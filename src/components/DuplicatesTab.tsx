import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatBytes } from '../utils';
import { ChevronDown, ChevronRight, FolderOpen, Loader2 } from 'lucide-react';

interface DuplicateGroup {
    hash: string;
    bytes: number;
    wasted: number;
    paths: string[];
}

interface Props {
    /** Map<sizeBytes_str, paths[]> — already filtered to groups with ≥2 files */
    candidates: Map<number, string[]>;
    hasScanned: boolean;
}

export const DuplicatesTab: React.FC<Props> = ({ candidates, hasScanned }) => {
    const [groups, setGroups] = useState<DuplicateGroup[]>([]);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);
    const [expandedHashes, setExpandedHashes] = useState<Set<string>>(new Set());

    const toggleGroup = (hash: string) => {
        setExpandedHashes(prev => {
            const next = new Set(prev);
            if (next.has(hash)) next.delete(hash);
            else next.add(hash);
            return next;
        });
    };

    const openExplorer = async (path: string) => {
        const parent = path.includes('\\') ? path.slice(0, path.lastIndexOf('\\')) : path;
        try { await invoke('open_explorer', { path: parent }); } catch { /* ignore */ }
    };

    const handleScan = async () => {
        setLoading(true);
        setDone(false);
        setGroups([]);

        // Minimum file size for duplicate detection (1 MB)
        // Rationale: tiny files with coincidentally matching sizes are very common,
        // they produce massive candidate counts and low-quality results.
        const MIN_SIZE = 1024 * 1024;
        // Max files per size-group to avoid processing pathological groups
        // (e.g. 5000 identical-size system DLLs). Capped at 200.
        const MAX_GROUP = 200;

        const payload: Record<string, string[]> = {};
        for (const [size, paths] of candidates) {
            if (size >= MIN_SIZE && paths.length >= 2 && paths.length <= MAX_GROUP) {
                payload[String(size)] = paths;
            }
        }

        try {
            const result = await invoke<DuplicateGroup[]>('find_duplicates', { candidates: payload });
            setGroups(result);
        } catch (e) {
            console.error('find_duplicates failed:', e);
        } finally {
            setLoading(false);
            setDone(true);
        }
    };

    // Count groups that will actually be sent (apply same filters)
    const MIN_SIZE = 1024 * 1024;
    const MAX_GROUP = 200;
    const candidateCount = [...candidates.entries()]
        .filter(([size, paths]) => size >= MIN_SIZE && paths.length >= 2 && paths.length <= MAX_GROUP)
        .length;
    const candidateFiles = [...candidates.entries()]
        .filter(([size, paths]) => size >= MIN_SIZE && paths.length >= 2 && paths.length <= MAX_GROUP)
        .reduce((sum, [, paths]) => sum + paths.length, 0);
    const totalWasted = groups.reduce((s, g) => s + g.wasted, 0);


    if (!hasScanned) {
        return <div className="panel-empty">请先扫描一个目录。</div>;
    }

    return (
        <div className="duplicates-panel">
            {/* Action bar */}
            <div className="dup-action-bar">
                <div className="dup-info">
                    {!done
                        ? <span>{candidateCount} 个大小相同的文件组（共 {candidateFiles} 个文件，≥1MB）待验证</span>
                        : <span>找到 <b>{groups.length}</b> 组重复文件，可释放 <b>{formatBytes(totalWasted)}</b></span>
                    }
                </div>
                <button
                    className="btn btn-primary"
                    style={{ height: 30, fontSize: '0.82rem', padding: '0 14px' }}
                    onClick={handleScan}
                    disabled={loading || candidateCount === 0}
                >
                    {loading ? <><Loader2 size={14} className="spin" /> 哈希计算中…</> : '🔍 开始检测'}
                </button>
            </div>

            {/* Results */}
            {done && groups.length === 0 && (
                <div className="panel-empty">未发现重复文件 🎉</div>
            )}

            <div className="dup-groups">
                {groups.map((g) => {
                    const isExpanded = expandedHashes.has(g.hash);
                    return (
                        <div key={g.hash} className="dup-group">
                            <div className="dup-group-header" onClick={() => toggleGroup(g.hash)}>
                                <span className="dup-chevron">
                                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                </span>
                                <span className="dup-copies">{g.paths.length} 份</span>
                                <span className="dup-size">{formatBytes(g.bytes)} / 份</span>
                                <span className="dup-wasted">可释放 {formatBytes(g.wasted)}</span>
                                <span className="dup-hash" title={g.hash}>{g.hash.slice(0, 12)}…</span>
                            </div>
                            {isExpanded && (
                                <div className="dup-paths">
                                    {g.paths.map((p, i) => {
                                        const name = p.includes('\\') ? p.slice(p.lastIndexOf('\\') + 1) : p;
                                        const dir = p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : '';
                                        return (
                                            <div key={i} className="dup-path-item">
                                                <span className="dup-fname" title={name}>{name}</span>
                                                <span className="dup-fdir" title={dir}>{dir}</span>
                                                <button className="icon-btn" title="在资源管理器中显示" onClick={() => openExplorer(p)}>
                                                    <FolderOpen size={13} />
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
