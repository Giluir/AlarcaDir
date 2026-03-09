import React, { useState, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatBytes, TopFileEntry, getCategory, CATEGORY_COLORS } from '../utils';
import { FolderOpen, Search } from 'lucide-react';

interface Props {
    files: TopFileEntry[];
}

export const TopFilesPanel: React.FC<Props> = React.memo(({ files }) => {
    const [filter, setFilter] = useState('');

    const filteredFiles = useMemo(() => {
        if (!filter.trim()) return files;
        const lowerFilter = filter.toLowerCase();
        return files.filter(f => {
            const name = f.path.includes('\\') ? f.path.slice(f.path.lastIndexOf('\\') + 1) : f.path;
            return name.toLowerCase().includes(lowerFilter);
        });
    }, [files, filter]);

    const openExplorer = async (path: string) => {
        try { await invoke('open_explorer', { path }); } catch { /* ignore */ }
    };

    if (files.length === 0) {
        return <div className="panel-empty" style={{ padding: '20px' }}>暂无大文件数据</div>;
    }

    return (
        <div className="file-type-distribution" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div className="top-files-filter" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--panel-bg)', position: 'sticky', top: 0, zIndex: 5 }}>
                <Search size={14} style={{ color: 'var(--text-secondary)' }} />
                <input
                    type="text"
                    placeholder="按扩展名或文件名过滤..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    style={{
                        flex: 1,
                        background: 'transparent',
                        border: 'none',
                        outline: 'none',
                        fontSize: '0.8rem',
                        color: 'var(--text-primary)',
                        padding: '4px 0'
                    }}
                />
                {filter && (
                    <button
                        onClick={() => setFilter('')}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '0 4px' }}
                    >✕</button>
                )}
            </div>

            <div className="category-list" style={{ flex: 1 }}>
                {filteredFiles.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>未匹配到文件</div>
                ) : filteredFiles.map((f, idx) => {
                    const name = f.path.includes('\\')
                        ? f.path.slice(f.path.lastIndexOf('\\') + 1)
                        : f.path;
                    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
                    const color = CATEGORY_COLORS[getCategory(ext)];
                    const dir = f.path.includes('\\')
                        ? f.path.slice(0, f.path.lastIndexOf('\\'))
                        : '';

                    return (
                        <div key={idx} className="category-group" style={{ borderBottom: '1px solid var(--border-color)' }}>
                            <div className="category-header" style={{ cursor: 'default', padding: '8px 16px' }}>
                                <div className="cat-icon" style={{ backgroundColor: color, opacity: 0.9, width: '10px', height: '10px', borderRadius: '2px' }}></div>
                                <div className="cat-name-group" style={{ marginLeft: '10px' }}>
                                    <span className="cat-name" title={name} style={{ fontSize: '0.82rem', fontWeight: 500 }}>{name}</span>
                                    <span className="cat-pct" style={{ marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7 }} title={dir}>{dir}</span>
                                </div>
                                <div className="cat-stats" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginLeft: 'auto', paddingRight: '12px' }}>
                                    <span className="cat-bytes" style={{ fontSize: '0.8rem', fontWeight: 600 }}>{formatBytes(f.bytes)}</span>
                                </div>
                                <div className="cat-chevron" style={{ opacity: 0.6 }}>
                                    <button
                                        className="icon-btn"
                                        title="在资源管理器中显示"
                                        onClick={(e) => { e.stopPropagation(); openExplorer(f.path); }}
                                        style={{ display: 'flex', padding: '4px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}
                                    >
                                        <FolderOpen size={14} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
});
