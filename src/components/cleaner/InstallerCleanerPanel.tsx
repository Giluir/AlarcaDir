import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  Search,
  Archive,
  Trash2,
  FolderOpen,
  X,
  Tag,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { formatBytes } from '../../utils';
import { CleanAction, CleanerScanResult, CleanExecutionResult } from '../../types/cleaner';

interface InstallerCleanerPanelProps {
  onAdminAlert?: () => void;
}

// Module-level cache to keep clean list stable across re-renders and tab switches
let cachedScanResult: CleanerScanResult | null = null;
let cachedSelectedPaths: Set<string> | null = null;

export const InstallerCleanerPanel: React.FC<InstallerCleanerPanelProps> = React.memo(({ onAdminAlert }) => {
  const [scanResult, setScanResult] = useState<CleanerScanResult | null>(() => cachedScanResult);
  const [loading, setLoading] = useState<boolean>(false);
  const [executing, setExecuting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Filter & Search states
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [filterRec, setFilterRec] = useState<'all' | 'safe' | 'caution'>('all');

  // Selected paths for action (initialized from cache if available)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => (cachedSelectedPaths ? new Set(cachedSelectedPaths) : new Set())
  );

  // Stable ref for onAdminAlert so runScan has [] dependencies and never re-runs due to parent renders
  const onAdminAlertRef = useRef(onAdminAlert);
  useEffect(() => {
    onAdminAlertRef.current = onAdminAlert;
  }, [onAdminAlert]);

  // Modal dialog states
  const [actionType, setActionType] = useState<'quarantine' | 'rename' | 'delete' | null>(null);
  const [quarantineDir, setQuarantineDir] = useState<string>('C:\\Windows\\Installer\\.quarantine');
  const [renamePrefix, setRenamePrefix] = useState<string>('!UnUsed - ');
  const [execResult, setExecResult] = useState<CleanExecutionResult | null>(null);

  // Run scan (strictly manual or post-execution, 100% decoupled from Watcher events)
  const runScan = useCallback(async (force = false) => {
    if (!force && cachedScanResult) {
      setScanResult(cachedScanResult);
      if (cachedSelectedPaths) setSelectedPaths(new Set(cachedSelectedPaths));
      return;
    }

    setLoading(true);
    setError(null);
    setExecResult(null);
    try {
      const res = await invoke<CleanerScanResult>('cleaner_scan', {
        pluginId: 'windows_installer',
      });
      cachedScanResult = res;
      setScanResult(res);

      // Pre-select items recommended as SafeToQuarantine
      const initialSafe = new Set<string>();
      for (const item of res.items) {
        if (item.recommendation === 'SafeToQuarantine') {
          initialSafe.add(item.path);
        }
      }
      cachedSelectedPaths = initialSafe;
      setSelectedPaths(new Set(initialSafe));
    } catch (e: any) {
      console.error('扫描失败:', e);
      const errMsg = typeof e === 'string' ? e : e?.message || JSON.stringify(e);
      setError(errMsg);
      if (errMsg.includes('5') || errMsg.includes('Access is denied') || errMsg.includes('权限不足')) {
        onAdminAlertRef.current?.();
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Only scan on initial mount if cache is empty
  useEffect(() => {
    if (!cachedScanResult) {
      runScan(true);
    }
  }, [runScan]);

  // Filtered items
  const filteredItems = useMemo(() => {
    if (!scanResult) return [];
    return scanResult.items.filter((item) => {
      if (filterRec === 'safe' && item.recommendation !== 'SafeToQuarantine') return false;
      if (filterRec === 'caution' && item.recommendation !== 'Caution') return false;

      if (!searchTerm.trim()) return true;
      const lower = searchTerm.toLowerCase();
      return (
        item.name.toLowerCase().includes(lower) ||
        (item.product_name && item.product_name.toLowerCase().includes(lower)) ||
        (item.package_code && item.package_code.toLowerCase().includes(lower)) ||
        (item.author && item.author.toLowerCase().includes(lower))
      );
    });
  }, [scanResult, filterRec, searchTerm]);

  // Total bytes of selected files
  const selectedSize = useMemo(() => {
    if (!scanResult) return 0;
    let size = 0;
    for (const it of scanResult.items) {
      if (selectedPaths.has(it.path)) {
        size += it.size;
      }
    }
    return size;
  }, [scanResult, selectedPaths]);

  // Selection toggle handlers
  const toggleSelectPath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      cachedSelectedPaths = next;
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const it of filteredItems) {
        next.add(it.path);
      }
      cachedSelectedPaths = next;
      return next;
    });
  };

  const deselectAllFiltered = () => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      for (const it of filteredItems) {
        next.delete(it.path);
      }
      cachedSelectedPaths = next;
      return next;
    });
  };

  // Open file in Explorer
  const handleOpenExplorer = async (filePath: string) => {
    try {
      const dir = filePath.includes('\\') ? filePath.slice(0, filePath.lastIndexOf('\\')) : filePath;
      await invoke('open_explorer', { path: dir });
    } catch (e) {
      console.error('打开资源管理器失败:', e);
    }
  };

  // Execute clean action
  const handleConfirmAction = async () => {
    if (!actionType || selectedPaths.size === 0) return;

    setExecuting(true);
    setError(null);

    let action: CleanAction;
    if (actionType === 'quarantine') {
      action = { type: 'Quarantine', target_dir: quarantineDir };
    } else if (actionType === 'rename') {
      action = { type: 'Rename', prefix: renamePrefix };
    } else {
      action = { type: 'Delete', permanent: false };
    }

    try {
      const res = await invoke<CleanExecutionResult>('cleaner_execute', {
        pluginId: 'windows_installer',
        action,
        items: Array.from(selectedPaths),
      });
      setExecResult(res);
      setActionType(null);
      // Invalidate cache and force fresh scan
      cachedScanResult = null;
      cachedSelectedPaths = null;
      await runScan(true);
    } catch (e: any) {
      console.error('执行处置失败:', e);
      const msg = typeof e === 'string' ? e : e?.message || JSON.stringify(e);
      setError(msg);
      if (msg.includes('5') || msg.includes('Access is denied') || msg.includes('权限不足')) {
        onAdminAlertRef.current?.();
      }
    } finally {
      setExecuting(false);
    }
  };

  const isAllFilteredSelected =
    filteredItems.length > 0 && filteredItems.every((it) => selectedPaths.has(it.path));

  return (
    <div className="installer-cleaner-panel">
      {/* ── 1. Top Summary Metric Cards ─────────────────────────────────────── */}
      <div className="cleaner-stats-row">
        <div className="cleaner-stat-card">
          <div className="cleaner-stat-icon-box success">
            <ShieldCheck size={20} />
          </div>
          <div className="cleaner-stat-content">
            <span className="cleaner-stat-label">活跃安装包 (受保护保留)</span>
            <div className="cleaner-stat-val-group">
              <span className="cleaner-stat-value success">
                {scanResult ? scanResult.active_count : '--'}
              </span>
              <span className="cleaner-stat-sub">
                {scanResult ? formatBytes(scanResult.active_bytes) : ''}
              </span>
            </div>
          </div>
        </div>

        <div className="cleaner-stat-card">
          <div className="cleaner-stat-icon-box warning">
            <AlertTriangle size={20} />
          </div>
          <div className="cleaner-stat-content">
            <span className="cleaner-stat-label">孤立冗余包 (可清理)</span>
            <div className="cleaner-stat-val-group">
              <span className="cleaner-stat-value warning">
                {scanResult ? scanResult.items.length : '--'}
              </span>
              <span className="cleaner-stat-sub warning">
                {scanResult ? formatBytes(scanResult.total_bytes) : ''}
              </span>
            </div>
          </div>
        </div>

        <div className="cleaner-stat-card">
          <div className="cleaner-stat-icon-box primary">
            <Archive size={20} />
          </div>
          <div className="cleaner-stat-content">
            <span className="cleaner-stat-label">已选择待清理项</span>
            <div className="cleaner-stat-val-group">
              <span className="cleaner-stat-value primary">{selectedPaths.size}</span>
              <span className="cleaner-stat-sub primary">
                {selectedPaths.size > 0 ? formatBytes(selectedSize) : '0 B'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. Toolbar & Controls ───────────────────────────────────────────── */}
      <div className="cleaner-toolbar">
        <div className="cleaner-toolbar-left">
          <div className="cleaner-search-box">
            <Search size={14} className="cleaner-search-icon" />
            <input
              type="text"
              placeholder="搜索产品名称、GUID、发行商或文件名…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="dup-text-input cleaner-search-input"
            />
          </div>

          <div className="cleaner-filter-pills">
            <button
              className={`cleaner-filter-pill ${filterRec === 'all' ? 'active' : ''}`}
              onClick={() => setFilterRec('all')}
            >
              全部 ({scanResult ? scanResult.items.length : 0})
            </button>
            <button
              className={`cleaner-filter-pill ${filterRec === 'safe' ? 'active' : ''}`}
              onClick={() => setFilterRec('safe')}
            >
              安全隔离项 ({scanResult ? scanResult.items.filter((i) => i.recommendation === 'SafeToQuarantine').length : 0})
            </button>
            <button
              className={`cleaner-filter-pill ${filterRec === 'caution' ? 'active' : ''}`}
              onClick={() => setFilterRec('caution')}
            >
              需谨慎 ({scanResult ? scanResult.items.filter((i) => i.recommendation === 'Caution').length : 0})
            </button>
          </div>
        </div>

        <div className="cleaner-toolbar-right">
          <button className="dup-link-btn" onClick={selectAllFiltered}>全选</button>
          <button className="dup-link-btn" onClick={deselectAllFiltered}>取消</button>

          <button
            className="btn btn-secondary cleaner-btn"
            onClick={() => runScan(true)}
            disabled={loading}
            title="重新扫描"
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            <span>刷新</span>
          </button>

          <div className="cleaner-divider" />

          <button
            className="btn btn-primary cleaner-btn"
            onClick={() => setActionType('quarantine')}
            disabled={selectedPaths.size === 0 || loading || executing}
            title="将所选项移动到安全隔离目录（推荐，支持随时一键还原）"
          >
            <Archive size={14} />
            <span>隔离备份 ({selectedPaths.size})</span>
          </button>

          <button
            className="btn btn-secondary cleaner-btn"
            onClick={() => setActionType('rename')}
            disabled={selectedPaths.size === 0 || loading || executing}
            title="添加 !UnUsed - 前缀观察系统运行状态"
          >
            <Tag size={14} />
            <span>重命名</span>
          </button>

          <button
            className="btn btn-danger cleaner-btn"
            onClick={() => setActionType('delete')}
            disabled={selectedPaths.size === 0 || loading || executing}
            title="永久删除所选文件"
          >
            <Trash2 size={14} />
            <span>永久清理</span>
          </button>
        </div>
      </div>

      {/* ── 3. Notification Banners ─────────────────────────────────────────── */}
      {execResult && (
        <div className="cleaner-banner success">
          <CheckCircle2 size={16} />
          <span>
            清理完成：成功处理 <b>{execResult.succeeded}</b> 个文件，释放空间{' '}
            <b>{formatBytes(execResult.freed_bytes)}</b>
            {execResult.failed > 0 && `（${execResult.failed} 个文件处理失败）`}
          </span>
          <button className="cleaner-banner-close" onClick={() => setExecResult(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div className="cleaner-banner error">
          <XCircle size={16} />
          <span>{error}</span>
          <button className="cleaner-banner-close" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── 4. Item Table Section ───────────────────────────────────────────── */}
      <div className="cleaner-table-card">
        {loading ? (
          <div className="cleaner-loading-area">
            <RefreshCw size={28} className="spin" />
            <p>正在分析 Windows 注册表与 Win32 MSI 白名单…</p>
            <span>正在校验 C:\Windows\Installer 并解析安装包自省信息</span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="cleaner-empty-area">
            <CheckCircle2 size={44} className="cleaner-empty-icon" />
            <h3>未发现孤立冗余安装包</h3>
            <p>当前 Windows Installer 缓存干净整洁，所有物理包均对应活跃已安装产品。</p>
          </div>
        ) : (
          <div className="cleaner-table-scroll">
            <table className="cleaner-table">
              <thead>
                <tr>
                  <th style={{ width: 40, textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      className="dup-checkbox"
                      checked={isAllFilteredSelected}
                      onChange={() => {
                        if (isAllFilteredSelected) deselectAllFiltered();
                        else selectAllFiltered();
                      }}
                    />
                  </th>
                  <th style={{ width: 140 }}>文件名</th>
                  <th>关联软件产品 / PackageCode</th>
                  <th style={{ width: 160 }}>发行商</th>
                  <th style={{ width: 100, textAlign: 'right' }}>文件大小</th>
                  <th style={{ width: 120 }}>修改时间</th>
                  <th style={{ width: 100, textAlign: 'center' }}>处置建议</th>
                  <th style={{ width: 44, textAlign: 'center' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const isSelected = selectedPaths.has(item.path);
                  return (
                    <tr
                      key={item.path}
                      className={`cleaner-row ${isSelected ? 'selected' : ''}`}
                      onClick={() => toggleSelectPath(item.path)}
                    >
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="dup-checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectPath(item.path)}
                        />
                      </td>
                      <td className="cleaner-col-filename" title={item.path}>
                        {item.name}
                      </td>
                      <td>
                        <div className="cleaner-prod-info">
                          <span className="cleaner-prod-name">
                            {item.product_name || '未知 MSI 软件包'}
                          </span>
                          {item.package_code && (
                            <span className="cleaner-package-guid" title={item.package_code}>
                              {item.package_code}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="cleaner-col-author">
                        {item.author || '--'}
                      </td>
                      <td className="cleaner-col-size">
                        {formatBytes(item.size)}
                      </td>
                      <td className="cleaner-col-date">
                        {item.last_modified ? new Date(item.last_modified * 1000).toISOString().slice(0, 10) : '--'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {item.recommendation === 'SafeToQuarantine' ? (
                          <span className="dup-badge badge-verified">安全隔离</span>
                        ) : (
                          <span className="dup-badge badge-caution">需谨慎</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <button
                          className="icon-btn"
                          onClick={() => handleOpenExplorer(item.path)}
                          title="在文件资源管理器中定位"
                        >
                          <FolderOpen size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 5. Action Confirmation Modals (Frosted Glass Light Dialogs) ──────── */}
      {actionType && (
        <div className="cleaner-modal-overlay" onClick={() => setActionType(null)}>
          <div className="cleaner-modal-card" onClick={(e) => e.stopPropagation()}>
            <button className="cleaner-modal-close" onClick={() => setActionType(null)}>
              <X size={16} />
            </button>

            <div className="cleaner-modal-content">
              {actionType === 'quarantine' && (
                <>
                  <div className="cleaner-modal-header">
                    <div className="cleaner-modal-icon-wrapper primary">
                      <Archive size={24} />
                    </div>
                    <div>
                      <h3>隔离备份安装包</h3>
                      <p>将所选的 <b>{selectedPaths.size}</b> 个文件安全移至备份目录，释放 <b>{formatBytes(selectedSize)}</b> 空间</p>
                    </div>
                  </div>

                  <div className="cleaner-modal-body">
                    <div className="cleaner-modal-tip">
                      <ShieldCheck size={16} />
                      <span>文件并未真正删除，如遇软件修补或卸载需要，可随时将备份包移回原目录还原。</span>
                    </div>

                    <div className="cleaner-modal-field">
                      <label>隔离存放目标目录：</label>
                      <input
                        type="text"
                        className="dup-text-input cleaner-modal-input"
                        value={quarantineDir}
                        onChange={(e) => setQuarantineDir(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="cleaner-modal-footer">
                    <button className="btn btn-secondary" onClick={() => setActionType(null)}>
                      取消
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleConfirmAction}
                      disabled={executing || !quarantineDir.trim()}
                    >
                      {executing ? '处理中…' : '开始隔离'}
                    </button>
                  </div>
                </>
              )}

              {actionType === 'rename' && (
                <>
                  <div className="cleaner-modal-header">
                    <div className="cleaner-modal-icon-wrapper primary">
                      <Tag size={24} />
                    </div>
                    <div>
                      <h3>标记重命名安装包</h3>
                      <p>为所选 <b>{selectedPaths.size}</b> 个文件追加前缀，验证系统与软件使用情况</p>
                    </div>
                  </div>

                  <div className="cleaner-modal-body">
                    <div className="cleaner-modal-tip">
                      <span>重命名后 Windows 将无法直接找到该安装包，可观察数天。若无异常再执行清理。</span>
                    </div>

                    <div className="cleaner-modal-field">
                      <label>前缀名称：</label>
                      <input
                        type="text"
                        className="dup-text-input cleaner-modal-input"
                        value={renamePrefix}
                        onChange={(e) => setRenamePrefix(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="cleaner-modal-footer">
                    <button className="btn btn-secondary" onClick={() => setActionType(null)}>
                      取消
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleConfirmAction}
                      disabled={executing || !renamePrefix.trim()}
                    >
                      {executing ? '处理中…' : '开始重命名'}
                    </button>
                  </div>
                </>
              )}

              {actionType === 'delete' && (
                <>
                  <div className="cleaner-modal-header">
                    <div className="cleaner-modal-icon-wrapper danger">
                      <Trash2 size={24} />
                    </div>
                    <div>
                      <h3>永久清理确认</h3>
                      <p>您即将从磁盘彻底删除 <b>{selectedPaths.size}</b> 个安装包（共 <b>{formatBytes(selectedSize)}</b>）</p>
                    </div>
                  </div>

                  <div className="cleaner-modal-body">
                    <div className="cleaner-modal-tip danger">
                      <AlertTriangle size={16} />
                      <span>此操作直接删除磁盘文件，无法撤销！建议优先使用“隔离备份”。</span>
                    </div>
                  </div>

                  <div className="cleaner-modal-footer">
                    <button className="btn btn-secondary" onClick={() => setActionType(null)}>
                      取消
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={handleConfirmAction}
                      disabled={executing}
                    >
                      {executing ? '清理中…' : '确认彻底删除'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
