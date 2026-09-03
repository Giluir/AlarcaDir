import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ShieldCheck,
  AlertTriangle,
  Trash2,
  Archive,
  FolderOpen,
  RefreshCw,
  Search,
  CheckSquare,
  Square,
  Info,
  Tag,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { formatBytes } from '../../utils';
import { CleanAction, CleanerScanResult, CleanExecutionResult } from '../../types/cleaner';

interface InstallerCleanerPanelProps {
  onAdminAlert?: () => void;
}

export const InstallerCleanerPanel: React.FC<InstallerCleanerPanelProps> = () => {
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<CleanerScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterRec, setFilterRec] = useState<'all' | 'safe' | 'caution'>('all');

  // Action modals
  const [actionType, setActionType] = useState<'quarantine' | 'rename' | 'delete' | null>(null);
  const [quarantineDir, setQuarantineDir] = useState('C:\\Windows\\Installer\\.quarantine');
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<CleanExecutionResult | null>(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedPaths(new Set());
    setExecResult(null);

    try {
      const res = await invoke<CleanerScanResult>('cleaner_scan', {
        pluginId: 'windows_installer',
      });
      setScanResult(res);
      // Auto-select items marked as SafeToQuarantine
      const initialSelected = new Set<string>();
      res.items.forEach((item) => {
        if (item.recommendation === 'SafeToQuarantine') {
          initialSelected.add(item.path);
        }
      });
      setSelectedPaths(initialSelected);
    } catch (e: any) {
      setError(typeof e === 'string' ? e : e.message || '扫描失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    runScan();
  }, [runScan]);

  // Filtered items
  const filteredItems = useMemo(() => {
    if (!scanResult) return [];
    const term = searchTerm.toLowerCase().trim();
    return scanResult.items.filter((item) => {
      if (filterRec === 'safe' && item.recommendation !== 'SafeToQuarantine') return false;
      if (filterRec === 'caution' && item.recommendation !== 'Caution') return false;
      if (!term) return true;

      return (
        item.name.toLowerCase().includes(term) ||
        (item.product_name && item.product_name.toLowerCase().includes(term)) ||
        (item.author && item.author.toLowerCase().includes(term)) ||
        (item.package_code && item.package_code.toLowerCase().includes(term))
      );
    });
  }, [scanResult, searchTerm, filterRec]);

  // Selected size
  const selectedSize = useMemo(() => {
    if (!scanResult) return 0;
    let sum = 0;
    for (const item of scanResult.items) {
      if (selectedPaths.has(item.path)) {
        sum += item.size;
      }
    }
    return sum;
  }, [scanResult, selectedPaths]);

  const toggleSelect = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAllFiltered = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      filteredItems.forEach((it) => next.add(it.path));
      return next;
    });
  }, [filteredItems]);

  const deselectAllFiltered = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      filteredItems.forEach((it) => next.delete(it.path));
      return next;
    });
  }, [filteredItems]);

  const handleOpenExplorer = useCallback(async (filePath: string) => {
    try {
      await invoke('open_explorer', { path: filePath, select: true });
    } catch (e) {
      console.error('打开文件位置失败:', e);
    }
  }, []);

  const executeAction = async (action: CleanAction) => {
    if (selectedPaths.size === 0) return;
    setExecuting(true);
    try {
      const res = await invoke<CleanExecutionResult>('cleaner_execute', {
        pluginId: 'windows_installer',
        action,
        items: Array.from(selectedPaths),
      });
      setExecResult(res);
      setActionType(null);
      // Refresh scan
      runScan();
    } catch (e: any) {
      alert(`执行失败: ${typeof e === 'string' ? e : e.message}`);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="installer-cleaner-panel">
      {/* ── Summary Stats Cards ──────────────────────────────────────────────── */}
      <div className="cleaner-stats-grid">
        <div className="cleaner-stat-card">
          <div className="stat-icon-wrapper active-color">
            <ShieldCheck size={22} />
          </div>
          <div className="stat-info">
            <span className="stat-label">活跃安装包 (受保护保留)</span>
            <div className="stat-val-group">
              <span className="stat-value">{scanResult ? scanResult.active_count : '--'}</span>
              <span className="stat-sub">
                {scanResult ? formatBytes(scanResult.active_bytes) : ''}
              </span>
            </div>
          </div>
        </div>

        <div className="cleaner-stat-card">
          <div className="stat-icon-wrapper warning-color">
            <AlertTriangle size={22} />
          </div>
          <div className="stat-info">
            <span className="stat-label">孤立冗余包 (可清理)</span>
            <div className="stat-val-group">
              <span className="stat-value warning-text">
                {scanResult ? scanResult.items.length : '--'}
              </span>
              <span className="stat-sub warning-text">
                {scanResult ? formatBytes(scanResult.total_bytes) : ''}
              </span>
            </div>
          </div>
        </div>

        <div className="cleaner-stat-card">
          <div className="stat-icon-wrapper select-color">
            <CheckSquare size={22} />
          </div>
          <div className="stat-info">
            <span className="stat-label">已选择待清理项</span>
            <div className="stat-val-group">
              <span className="stat-value highlight-text">{selectedPaths.size}</span>
              <span className="stat-sub highlight-text">
                {selectedPaths.size > 0 ? formatBytes(selectedSize) : '0 B'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Toolbar & Action Bar ────────────────────────────────────────────── */}
      <div className="cleaner-toolbar">
        <div className="cleaner-toolbar-left">
          <div className="search-box">
            <Search size={15} className="search-icon" />
            <input
              type="text"
              placeholder="搜索产品名称、发行商、GUID 或文件名..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="cleaner-search-input"
            />
          </div>

          <div className="filter-pills">
            <button
              className={`filter-pill ${filterRec === 'all' ? 'active' : ''}`}
              onClick={() => setFilterRec('all')}
            >
              全部 ({scanResult ? scanResult.items.length : 0})
            </button>
            <button
              className={`filter-pill ${filterRec === 'safe' ? 'active' : ''}`}
              onClick={() => setFilterRec('safe')}
            >
              安全隔离项 ({scanResult ? scanResult.items.filter((i) => i.recommendation === 'SafeToQuarantine').length : 0})
            </button>
            <button
              className={`filter-pill ${filterRec === 'caution' ? 'active' : ''}`}
              onClick={() => setFilterRec('caution')}
            >
              需谨慎 ({scanResult ? scanResult.items.filter((i) => i.recommendation === 'Caution').length : 0})
            </button>
          </div>
        </div>

        <div className="cleaner-toolbar-right">
          <button
            className="action-btn text-btn"
            onClick={selectAllFiltered}
            title="全选当前过滤出的项目"
          >
            全选
          </button>
          <button
            className="action-btn text-btn"
            onClick={deselectAllFiltered}
            title="取消全选"
          >
            取消
          </button>

          <button
            className="action-btn refresh-btn"
            onClick={runScan}
            disabled={loading}
            title="重新扫描"
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            <span>重新扫描</span>
          </button>

          <div className="action-divider" />

          <button
            className="clean-op-btn quarantine-btn"
            onClick={() => setActionType('quarantine')}
            disabled={selectedPaths.size === 0 || loading || executing}
            title="将所选项移动到指定的隔离备份目录，支持随时一键还原（强烈推荐）"
          >
            <Archive size={15} />
            <span>隔离备份 ({selectedPaths.size})</span>
          </button>

          <button
            className="clean-op-btn rename-btn"
            onClick={() => setActionType('rename')}
            disabled={selectedPaths.size === 0 || loading || executing}
            title="重命名添加 !UnUsed - 前缀，便于观察系统运行情况"
          >
            <Tag size={15} />
            <span>标记重命名</span>
          </button>

          <button
            className="clean-op-btn delete-btn"
            onClick={() => setActionType('delete')}
            disabled={selectedPaths.size === 0 || loading || executing}
            title="彻底从磁盘永久清除所选安装包"
          >
            <Trash2 size={15} />
            <span>永久清理</span>
          </button>
        </div>
      </div>

      {/* ── Feedback Notification ────────────────────────────────────────────── */}
      {execResult && (
        <div className="cleaner-banner success-banner">
          <CheckCircle2 size={18} />
          <span>
            清理完成：成功处理 <strong>{execResult.succeeded}</strong> 个文件，释放空间{' '}
            <strong>{formatBytes(execResult.freed_bytes)}</strong>
            {execResult.failed > 0 && `（${execResult.failed} 个文件处理失败）`}
          </span>
          <button className="banner-close" onClick={() => setExecResult(null)}>
            ×
          </button>
        </div>
      )}

      {error && (
        <div className="cleaner-banner error-banner">
          <XCircle size={18} />
          <span>{error}</span>
          <button className="banner-close" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* ── Item Table / List ─────────────────────────────────────────────────── */}
      <div className="cleaner-table-container">
        {loading ? (
          <div className="cleaner-loading-state">
            <RefreshCw size={32} className="spin" />
            <p>正在执行 Windows 注册表与 MSI API 双重白名单分析...</p>
            <span className="loading-sub">
              正在遍历 C:\Windows\Installer 并解析安装包 Summary 信息，请稍候
            </span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="cleaner-empty-state">
            <CheckCircle2 size={48} className="empty-icon-success" />
            <h3>太棒了，未发现任何冗余孤立安装包！</h3>
            <p>系统中的 Windows Installer 缓存完全健康整洁，无需清理。</p>
          </div>
        ) : (
          <div className="cleaner-table-wrapper">
            <table className="cleaner-table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>
                    <button
                      className="header-chk-btn"
                      onClick={() => {
                        const allSelected = filteredItems.every((it) => selectedPaths.has(it.path));
                        if (allSelected) deselectAllFiltered();
                        else selectAllFiltered();
                      }}
                    >
                      {filteredItems.every((it) => selectedPaths.has(it.path)) ? (
                        <CheckSquare size={16} />
                      ) : (
                        <Square size={16} />
                      )}
                    </button>
                  </th>
                  <th style={{ width: 140 }}>文件名</th>
                  <th>软件 / 产品信息</th>
                  <th style={{ width: 160 }}>发行商 / 厂商</th>
                  <th style={{ width: 100 }}>大小</th>
                  <th style={{ width: 110 }}>修改日期</th>
                  <th style={{ width: 110 }}>安全建议</th>
                  <th style={{ width: 70 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const isChecked = selectedPaths.has(item.path);
                  const isCaution = item.recommendation === 'Caution';
                  const dateStr = item.last_modified
                    ? new Date(item.last_modified * 1000).toLocaleDateString()
                    : '--';

                  return (
                    <tr
                      key={item.path}
                      className={`cleaner-row ${isChecked ? 'selected' : ''}`}
                      onClick={() => toggleSelect(item.path)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          className="row-chk-btn"
                          onClick={() => toggleSelect(item.path)}
                        >
                          {isChecked ? <CheckSquare size={16} /> : <Square size={16} />}
                        </button>
                      </td>
                      <td className="col-filename">
                        <span className="file-name" title={item.path}>
                          {item.name}
                        </span>
                      </td>
                      <td className="col-product">
                        <div className="product-title-group">
                          <span
                            className="product-title"
                            title={item.comments || item.product_name || item.name}
                          >
                            {item.product_name || '[无内置标题的补丁/组件]'}
                          </span>
                          {item.package_code && (
                            <span className="package-code" title={`PackageCode: ${item.package_code}`}>
                              {item.package_code}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="col-author">
                        <span className="author-text" title={item.author || ''}>
                          {item.author || '--'}
                        </span>
                      </td>
                      <td className="col-size">
                        <span className="size-text">{formatBytes(item.size)}</span>
                      </td>
                      <td className="col-date">
                        <span className="date-text">{dateStr}</span>
                      </td>
                      <td className="col-badge">
                        {isCaution ? (
                          <span className="badge badge-caution" title="检测到可能与现有卸载项同名，建议优先隔离而非直接删除">
                            需谨慎
                          </span>
                        ) : (
                          <span className="badge badge-safe" title="已被新版本替换或卸载遗留，可安全隔离备份">
                            建议隔离
                          </span>
                        )}
                      </td>
                      <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          className="icon-action-btn"
                          title="在文件资源管理器中定位"
                          onClick={() => handleOpenExplorer(item.path)}
                        >
                          <FolderOpen size={15} />
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

      {/* ── Quarantine Confirmation Modal ────────────────────────────────────── */}
      {actionType === 'quarantine' && (
        <div className="cleaner-modal-backdrop" onClick={() => setActionType(null)}>
          <div className="cleaner-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Archive size={20} className="modal-icon quarantine-color" />
              <h3>隔离备份孤立安装包</h3>
            </div>
            <div className="modal-body">
              <p>
                即将把选中的 <strong>{selectedPaths.size}</strong> 个安装包（总计{' '}
                <strong>{formatBytes(selectedSize)}</strong>）移动到备份目录。
              </p>
              <div className="modal-tip-box">
                <Info size={16} />
                <span>
                  <strong>安全提示：</strong>
                  移动后可立即释放 C 盘空间。如日后发现某软件修复需要对应文件，可随时从隔离目录移回原位。
                </span>
              </div>
              <div className="input-group">
                <label>目标隔离目录：</label>
                <input
                  type="text"
                  value={quarantineDir}
                  onChange={(e) => setQuarantineDir(e.target.value)}
                  className="modal-text-input"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="modal-btn cancel-btn"
                onClick={() => setActionType(null)}
                disabled={executing}
              >
                取消
              </button>
              <button
                className="modal-btn confirm-btn quarantine-confirm"
                onClick={() =>
                  executeAction({ type: 'Quarantine', target_dir: quarantineDir })
                }
                disabled={executing || !quarantineDir.trim()}
              >
                {executing ? '正在隔离...' : '开始隔离'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rename Confirmation Modal ────────────────────────────────────────── */}
      {actionType === 'rename' && (
        <div className="cleaner-modal-backdrop" onClick={() => setActionType(null)}>
          <div className="cleaner-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Tag size={20} className="modal-icon rename-color" />
              <h3>标记重命名孤立文件</h3>
            </div>
            <div className="modal-body">
              <p>
                即将为选中的 <strong>{selectedPaths.size}</strong> 个文件添加前缀{' '}
                <code>!UnUsed - </code>。
              </p>
              <div className="modal-tip-box">
                <Info size={16} />
                <span>
                  <strong>说明：</strong>
                  文件依然保留在原目录中，重命名后若某软件试图调用会报错，便于观察是否会影响特定冷门软件。
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="modal-btn cancel-btn"
                onClick={() => setActionType(null)}
                disabled={executing}
              >
                取消
              </button>
              <button
                className="modal-btn confirm-btn rename-confirm"
                onClick={() => executeAction({ type: 'Rename', prefix: '!UnUsed - ' })}
                disabled={executing}
              >
                {executing ? '正在重命名...' : '确认重命名'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Permanent Delete Warning Modal ────────────────────────────────────── */}
      {actionType === 'delete' && (
        <div className="cleaner-modal-backdrop" onClick={() => setActionType(null)}>
          <div className="cleaner-modal modal-danger" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <AlertTriangle size={20} className="modal-icon danger-color" />
              <h3>永久清理孤立安装包确认</h3>
            </div>
            <div className="modal-body">
              <p>
                即将永久删除选中的 <strong>{selectedPaths.size}</strong> 个安装包文件，预计释放空间{' '}
                <strong>{formatBytes(selectedSize)}</strong>。
              </p>
              <div className="modal-tip-box danger-box">
                <AlertTriangle size={18} />
                <span>
                  <strong>高危操作警告：</strong>
                  删除后文件将无法通过回收站找回！建议优先选用【隔离备份】功能，确认数周内无任何异常后再做彻底清理。
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="modal-btn cancel-btn"
                onClick={() => setActionType(null)}
                disabled={executing}
              >
                取消
              </button>
              <button
                className="modal-btn confirm-btn danger-confirm"
                onClick={() => executeAction({ type: 'Delete', permanent: true })}
                disabled={executing}
              >
                {executing ? '正在删除...' : '确定彻底删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
