import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, Package, Cpu, FolderArchive, Clock } from 'lucide-react';
import { CleanerPluginInfo } from '../../types/cleaner';
import { InstallerCleanerPanel } from './InstallerCleanerPanel';

interface CleanerPageProps {
  onAdminAlert?: () => void;
}

export const CleanerPage: React.FC<CleanerPageProps> = () => {
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
  }, [selectedPluginId]);

  return (
    <div className="cleaner-page">
      {/* ── Plugin Shelf Header ────────────────────────────────────────── */}
      <div className="cleaner-shelf">
        <div className="shelf-header">
          <div className="shelf-title">
            <Sparkles size={18} className="shelf-title-icon" />
            <span>存储清理插件中心</span>
          </div>
          <span className="shelf-sub">
            独立解耦的系统存储与冗余分析工具箱，采用多重白名单与隔离机制确保系统安全
          </span>
        </div>

        <div className="plugin-card-list">
          {/* Active built-in plugins */}
          {plugins.map((p) => (
            <div
              key={p.id}
              className={`plugin-card ${selectedPluginId === p.id ? 'active' : ''}`}
              onClick={() => setSelectedPluginId(p.id)}
            >
              <div className="card-top">
                <div className="card-icon-box active-icon">
                  <Package size={20} />
                </div>
                <div className="card-badge ready">已就绪</div>
              </div>
              <div className="card-body">
                <h4 className="card-name">{p.name}</h4>
                <p className="card-desc">{p.description}</p>
              </div>
              <div className="card-footer">
                <span className="card-cat">{p.category}</span>
                {p.requires_admin && <span className="card-admin-tag">需管理员权限</span>}
              </div>
            </div>
          ))}

          {/* Extensible Future Plugins (Shelf Showcase) */}
          <div className="plugin-card disabled">
            <div className="card-top">
              <div className="card-icon-box planned-icon">
                <Cpu size={20} />
              </div>
              <div className="card-badge planned">规划中</div>
            </div>
            <div className="card-body">
              <h4 className="card-name">NVIDIA 驱动与着色器缓存</h4>
              <p className="card-desc">清理安装程序解压残留 (DisplayDriver) 与多版本 OTA 安装包</p>
            </div>
            <div className="card-footer">
              <span className="card-cat">显卡与游戏缓存</span>
              <span className="card-eta"><Clock size={12} /> 后续版本支持</span>
            </div>
          </div>

          <div className="plugin-card disabled">
            <div className="card-top">
              <div className="card-icon-box planned-icon">
                <FolderArchive size={20} />
              </div>
              <div className="card-badge planned">规划中</div>
            </div>
            <div className="card-body">
              <h4 className="card-name">开发者包管理器缓存</h4>
              <p className="card-desc">清理 npm, pip, cargo, gradle 等工具庞大的本地孤立依赖包</p>
            </div>
            <div className="card-footer">
              <span className="card-cat">开发环境清理</span>
              <span className="card-eta"><Clock size={12} /> 后续版本支持</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Active Plugin Content ──────────────────────────────────────── */}
      <div className="plugin-content-area">
        {selectedPluginId === 'windows_installer' && <InstallerCleanerPanel />}
      </div>
    </div>
  );
};

