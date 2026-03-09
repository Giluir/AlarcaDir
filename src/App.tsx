import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { HardDrive, Play, Square, Folder, PanelRight } from 'lucide-react';
import './App.css';

import { DirectoryNode, ProgressPayload, FileChangeEvent } from './types';
import { formatBytes, annotateWithTotalSize, resetScanCaches, topFilesNodeCache, sizeGroupCache, TopFileEntry, buildTreeFromBinary, applyFileChanges } from './utils';
import { FileTypeDistribution } from './components/FileTypeDistribution';
import { TreemapChart } from './components/TreemapChart';
import { TopFilesPanel } from './components/TopFilesPanel';
import { DuplicatesPage, DupeState, INITIAL_DUPE_STATE } from './components/DuplicatesPage';
import { AdminAlert } from './components/AdminAlert';


function App() {
  const [drives, setDrives] = useState<string[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string>('');
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [scanResult, setScanResult] = useState<DirectoryNode | null>(null);
  const [showAdminAlert, setShowAdminAlert] = useState(false);

  // Sidebar: default collapsed, persisted
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('sidebarOpen') === 'true'; } catch { return false; }
  });
  const [sidebarTab, setSidebarTab] = useState<'filetypes' | 'topfiles'>('filetypes');

  // Main view tab
  const [activeTab, setActiveTab] = useState<'treemap' | 'duplicates'>('treemap');

  // Bottom panel data
  const [topFiles, setTopFiles] = useState<TopFileEntry[]>([]);
  const [sizeGroups, setSizeGroups] = useState<Map<number, string[]>>(new Map());
  const [hasScanned, setHasScanned] = useState(false);

  // Cross-tab persistent Duplicates state
  const [dupeState, setDupeState] = useState<DupeState>(INITIAL_DUPE_STATE);

  // Visualization settings (debounced)
  const [maxDepth, setMaxDepth] = useState(2);
  const [filterThreshold, setFilterThreshold] = useState(0.005);
  const [maxDepthLocal, setMaxDepthLocal] = useState(2);
  const [filterThresholdLocal, setFilterThresholdLocal] = useState(0.005);
  const depthTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const filterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Incremental updates 
  const [updateRevision, setUpdateRevision] = useState(0);

  // Interactive navigation state
  const [currentRoot, setCurrentRoot] = useState<DirectoryNode | null>(null);
  const [breadcrumbPath, setBreadcrumbPath] = useState<DirectoryNode[]>([]);
  const basePathStr = selectedDrive.endsWith('\\') ? selectedDrive.slice(0, -1) : selectedDrive;
  const currentPathString = breadcrumbPath.length > 1
    ? basePathStr + '\\' + breadcrumbPath.slice(1).map(b => b.n).join('\\')
    : selectedDrive;

  const currentPathRef = useRef(currentPathString);
  const currentSizeRef = useRef(0);

  useEffect(() => {
    currentPathRef.current = currentPathString;
  }, [currentPathString]);

  useEffect(() => {
    currentSizeRef.current = currentRoot?.s || 0;
  }, [currentRoot]);

  useEffect(() => {
    invoke<boolean>('check_admin')
      .then(res => {
        if (!res) setShowAdminAlert(true);
      })
      .catch(e => console.error("Admin check failed:", e));

    invoke<string[]>('get_drives')
      .then((dList) => {
        setDrives(dList);
        if (dList.length > 0) setSelectedDrive(dList[0]);
      })
      .catch((e) => console.error("Failed to get drives:", e));

    const unlistenProgress = listen<ProgressPayload>('scan-progress', (event) => {
      setProgress(event.payload);
    });

    const unlistenWatcher = listen<FileChangeEvent[]>('file-monitor-event', (event) => {
      if (applyFileChanges(event.payload, currentPathRef.current, currentSizeRef.current)) {
        setUpdateRevision(r => r + 1);
      }
    });

    return () => {
      unlistenProgress.then(f => f());
      unlistenWatcher.then(f => f());
    };
  }, []);

  // Persist sidebar open state
  useEffect(() => {
    try { localStorage.setItem('sidebarOpen', String(sidebarOpen)); } catch { }
  }, [sidebarOpen]);

  // Refresh top files when cache is incrementally mutated
  useEffect(() => {
    if (currentRoot) {
      setTopFiles(topFilesNodeCache.get(currentRoot) ?? []);
    }
  }, [updateRevision, currentRoot]);

  const handleStartScan = async () => {
    if (!selectedDrive) return;
    setScanning(true);
    setProgress({ files: 0, bytes: 0, path: 'Starting...' });
    setScanResult(null);
    setHasScanned(false);
    setDupeState(INITIAL_DUPE_STATE);
    resetScanCaches();

    try {
      // invoke returns ArrayBuffer from Rust (binary-encoded node list)
      const buffer = await invoke<ArrayBuffer>('start_scan', { path: selectedDrive });

      // One-pass binary decode directly into DirectoryNode tree
      const resultObj: DirectoryNode = buildTreeFromBinary(buffer);

      // One-time O(n) pre-computation
      annotateWithTotalSize(resultObj);

      setScanResult(resultObj);
      setCurrentRoot(resultObj);
      setBreadcrumbPath([resultObj]);
      // sizeGroups snapshot (full-disk, for duplicate detection)
      setSizeGroups(new Map(sizeGroupCache));
      setHasScanned(true);
      // topFiles for root
      setTopFiles(topFilesNodeCache.get(resultObj) ?? []);

    } catch (e) {
      console.error("Scan error:", e);
      alert(`Scan failed: ${e}`);
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const handleCancel = async () => {
    try { await invoke('cancel_scan'); } catch (e) { console.error("Cancel failed:", e); }
  };

  const handleDrillDown = useCallback((node: DirectoryNode, pathTrace?: DirectoryNode[]) => {
    setBreadcrumbPath(prev => {
      if (prev.length > 0 && prev[prev.length - 1].n === node.n) return prev;
      setCurrentRoot(node);
      // Update top files for the new root — O(1) WeakMap lookup
      setTopFiles(topFilesNodeCache.get(node) ?? []);
      if (pathTrace && pathTrace.length > 0) return [...prev, ...pathTrace];
      return [...prev, node];
    });
  }, []);

  const handleDrillUp = useCallback(() => {
    setBreadcrumbPath(prev => {
      if (prev.length <= 1) return prev;
      const newPath = prev.slice(0, prev.length - 1);
      const newRoot = newPath[newPath.length - 1];
      setCurrentRoot(newRoot);
      // Update top files for the new root
      setTopFiles(topFilesNodeCache.get(newRoot) ?? []);
      return newPath;
    });
  }, []);

  const handleBreadcrumbClick = useCallback((index: number) => {
    setBreadcrumbPath(prev => {
      const newPath = prev.slice(0, index + 1);
      const newRoot = newPath[newPath.length - 1];
      setCurrentRoot(newRoot);
      setTopFiles(topFilesNodeCache.get(newRoot) ?? []);
      return newPath;
    });
  }, []);

  return (
    <div className="container">
      <header className="header">
        <div className="title-area">
          <Folder className="icon-title" size={28} />
          <h1>Alarca<span className="title-highlight">Dir</span></h1>
        </div>
        <div className="controls-area">
          <div className="drive-selector">
            <HardDrive size={18} />
            <select value={selectedDrive} onChange={(e) => setSelectedDrive(e.target.value)} disabled={scanning}>
              {drives.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <button
            className={`btn btn-primary ${scanning ? 'btn-scanning' : ''}`}
            onClick={scanning ? handleCancel : handleStartScan}
          >
            {scanning ? <><Square size={16} /> Cancel</> : <><Play size={16} /> Scan</>}
          </button>
        </div>
      </header>

      <main className="main-content">
        {!scanning && !scanResult && (
          <div className="empty-state">
            <div className="glow-circle"></div>
            <HardDrive size={64} className="empty-icon" />
            <h2>Select a drive to scan</h2>
            <p>Experience lightning fast directory visualization.</p>
          </div>
        )}

        {scanning && progress && (
          <div className="scanning-state">
            <div className="spinner"></div>
            <h3>Scanning {selectedDrive}</h3>
            <div className="stats-row">
              <div className="stat-box">
                <span className="stat-label">Files</span>
                <span className="stat-value">{progress.files.toLocaleString()}</span>
              </div>
              <div className="stat-box">
                <span className="stat-label">Size</span>
                <span className="stat-value">{formatBytes(progress.bytes)}</span>
              </div>
            </div>
            <p className="current-path" title={progress.path}>{progress.path}</p>
          </div>
        )}

        {scanResult && !scanning && (
          <div className="result-view">
            {/* ── Tab bar ───────────────────────────────────────────────── */}
            <div className="main-tab-bar">
              <button
                className={`main-tab ${activeTab === 'treemap' ? 'active' : ''}`}
                onClick={() => setActiveTab('treemap')}
              >文件分布</button>
              <button
                className={`main-tab ${activeTab === 'duplicates' ? 'active' : ''}`}
                onClick={() => setActiveTab('duplicates')}
              >重复文件</button>
            </div>
            {/* ── Treemap Tab ──────────────────────────────────────────── */}
            {activeTab === 'treemap' && (<>
              <div className="toolbar">
                <div className="toolbar-controls">
                  <div className="ctrl-group">
                    <span className="ctrl-label">深度: {maxDepthLocal}</span>
                    <input type="range" min="1" max="5" value={maxDepthLocal}
                      onChange={(e) => {
                        const v = parseInt(e.target.value);
                        setMaxDepthLocal(v);
                        clearTimeout(depthTimer.current);
                        depthTimer.current = setTimeout(() => setMaxDepth(v), 150);
                      }} className="ctrl-slider" />
                  </div>
                  <div className="ctrl-group">
                    <span className="ctrl-label">过滤: {(filterThresholdLocal * 100).toFixed(2)}%</span>
                    <input type="range" min="0" max="0.03" step="0.001" value={filterThresholdLocal}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setFilterThresholdLocal(v);
                        clearTimeout(filterTimer.current);
                        filterTimer.current = setTimeout(() => setFilterThreshold(v), 150);
                      }} className="ctrl-slider" />
                  </div>
                </div>
                <div className="breadcrumbs">
                  {breadcrumbPath.map((crumb, idx) => (
                    <span key={idx} className="crumb-item">
                      <button className="crumb-btn" onClick={() => handleBreadcrumbClick(idx)}>
                        {idx === 0 && crumb.n.endsWith('\\') ? crumb.n.slice(0, -1) : crumb.n}
                      </button>
                      {idx < breadcrumbPath.length - 1 && <span className="crumb-separator">/</span>}
                    </span>
                  ))}
                </div>
                <div className="toolbar-right">
                  <button
                    className={`sidebar-toggle-btn ${sidebarOpen ? 'active' : ''}`}
                    onClick={() => setSidebarOpen(v => !v)}
                    title={sidebarOpen ? '收起文件类型分布' : '展开文件类型分布'}
                  >
                    <PanelRight size={16} />
                    <span>详情</span>
                  </button>
                </div>
              </div>
              <div className="result-layout">
                <div className="treemap-area">
                  <TreemapChart
                    dataRoot={currentRoot}
                    basePath={currentPathString}
                    maxDepth={maxDepth}
                    filterThreshold={filterThreshold}
                    updateRevision={updateRevision}
                    onDrillDown={handleDrillDown}
                    onDrillUp={handleDrillUp}
                  />
                </div>
                {sidebarOpen && (
                  <aside className="sidebar-panel">
                    <div className="sidebar-tabs">
                      <button
                        className={`sidebar-tab ${sidebarTab === 'filetypes' ? 'active' : ''}`}
                        onClick={() => setSidebarTab('filetypes')}
                      >
                        文件类型
                      </button>
                      <button
                        className={`sidebar-tab ${sidebarTab === 'topfiles' ? 'active' : ''}`}
                        onClick={() => setSidebarTab('topfiles')}
                      >
                        最大文件
                      </button>
                    </div>

                    {sidebarTab === 'filetypes' && (
                      <>
                        <div className="sidebar-header">
                          <span>文件类型分布</span>
                          <span className="sidebar-sub">当前目录</span>
                        </div>
                        <div className="sidebar-chart">
                          <FileTypeDistribution dataRoot={currentRoot} updateRevision={updateRevision} />
                        </div>
                      </>
                    )}

                    {sidebarTab === 'topfiles' && (
                      <>
                        <div className="sidebar-header">
                          <span>最大文件</span>
                          <span className="sidebar-sub">当前目录</span>
                        </div>
                        <div className="sidebar-chart">
                          <TopFilesPanel files={topFiles} />
                        </div>
                      </>
                    )}
                  </aside>
                )}
              </div>
            </>)}

            {/* ── Duplicates Tab ───────────────────────────────────────── */}
            {activeTab === 'duplicates' && (
              <DuplicatesPage
                sizeGroups={sizeGroups}
                hasScanned={hasScanned}
                state={dupeState}
                setState={setDupeState}
              />
            )}
          </div>

        )}
      </main>
      {showAdminAlert && <AdminAlert onClose={() => setShowAdminAlert(false)} />}
    </div>
  );
}

export default App;
