import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Package, Cpu, FolderArchive } from 'lucide-react';
import { CleanerPluginInfo } from '../../types/cleaner';
import { InstallerCleanerPanel } from './InstallerCleanerPanel';

interface CleanerPageProps {
  onAdminAlert?: () => void;
}

export const CleanerPage: React.FC<CleanerPageProps> = React.memo(({ onAdminAlert }) => {
  const [plugins, setPlugins] = useState<CleanerPluginInfo[]>([]);
  const [selectedPluginId, setSelectedPluginId] = useState<string>('windows_installer');

  useEffect(() => {
    invoke<CleanerPluginInfo[]>('get_cleaner_plugins')
      .then((res) => {
        setPlugins(res);
        if (res.length > 0 && !res.some((p) => p.id === selectedPluginId)) {
          setSelectedPluginId(res[0].id);
        }
      })
      .catch((e) => {
        console.error('获取清理插件列表失败:', e);
      });
  }, []); // Run once on mount

  return (
    <div className="cleaner-page">
      {/* ── Cleaner Sub-nav Bar ───────────────────────────────────────── */}
      <div className="cleaner-subnav-bar">
        <div className="cleaner-plugin-tabs">
          {plugins.map((p) => (
            <button
              key={p.id}
              className={`cleaner-plugin-tab ${selectedPluginId === p.id ? 'active' : ''}`}
              onClick={() => setSelectedPluginId(p.id)}
            >
              <Package size={15} />
              <span>{p.name}</span>
              <span className="cleaner-tab-tag ready">就绪</span>
            </button>
          ))}

          <div className="cleaner-plugin-tab disabled" title="计划在未来版本支持">
            <Cpu size={15} />
            <span>NVIDIA 驱动缓存</span>
            <span className="cleaner-tab-tag planned">规划中</span>
          </div>

          <div className="cleaner-plugin-tab disabled" title="计划在未来版本支持">
            <FolderArchive size={15} />
            <span>开发包管理器缓存</span>
            <span className="cleaner-tab-tag planned">规划中</span>
          </div>
        </div>
      </div>

      {/* ── Cleaner Plugin Content Area ──────────────────────────────── */}
      <div className="cleaner-content-area">
        {selectedPluginId === 'windows_installer' && (
          <InstallerCleanerPanel onAdminAlert={onAdminAlert} />
        )}
      </div>
    </div>
  );
});
