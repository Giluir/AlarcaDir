import React, { useCallback, useEffect, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ChevronDown, ChevronRight, FolderOpen, Loader2, Search, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { formatBytes } from '../utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Phase1Group {
    hash: string;
    bytes: number;
    paths: string[];
    // Extended fields for Phase 2 in-place update
    verified?: boolean;
    wasted?: number;
}

interface DuplicateGroup {
    original_hash: string;
    hash: string;
    bytes: number;
    wasted: number;
    paths: string[];
}

interface DupeProgress {
    phase: 'phase1' | 'phase2';
    done: number;
    total: number;
}

export type DupeStage = 'idle' | 'scanning1' | 'results' | 'scanning2';

export interface DupeState {
    stage: DupeStage;
    minSizeMB: number;
    maxGroup: number;
    extFilter: string;
    pathFilter: string;
    groups: Phase1Group[];
    selectedHashes: Set<string>;
    expandedHashes: Set<string>;
    progress: DupeProgress | null;
}

interface Props {
    sizeGroups: Map<number, string[]>;
    hasScanned: boolean;
    state: DupeState;
    setState: React.Dispatch<React.SetStateAction<DupeState>>;
}

// ─── Constants ───────────────────────────────────────────────────────────────
export const INITIAL_DUPE_STATE: DupeState = {
    stage: 'idle',
    minSizeMB: 1,
    maxGroup: 200,
    extFilter: '',
    pathFilter: '',
    groups: [],
    selectedHashes: new Set(),
    expandedHashes: new Set(),
    progress: null,
};

// ─── Sub-components ─────────────────────────────────────────────────────────

const DuplicateGroupRow: React.FC<{
    g: Phase1Group;
    isSelected: boolean;
    isExpanded: boolean;
    isScanning: boolean;
    onToggleExpand: (hash: string) => void;
    onToggleSelect: (hash: string) => void;
    onOpenExplorer: (path: string) => void;
    disabled: boolean;
}> = React.memo(({ g, isSelected, isExpanded, isScanning, onToggleExpand, onToggleSelect, onOpenExplorer, disabled }) => {
    const wasted = g.verified ? g.wasted! : (g.bytes * (g.paths.length - 1));
    const rowClass = `dup-group-row ${isSelected ? 'selected' : ''} ${g.verified ? 'verified' : ''}`;

    return (
        <div className={rowClass}>
            <div className="dup-group-header" onClick={() => onToggleExpand(g.hash)}>
                {!g.verified && (
                    <input
                        type="checkbox" checked={isSelected}
                        onChange={() => onToggleSelect(g.hash)}
                        onClick={e => e.stopPropagation()}
                        className="dup-checkbox"
                        disabled={disabled}
                    />
                )}
                {g.verified && <CheckCircle2 size={15} className="dup-verified-icon" />}

                <span className="dup-chevron">
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </span>

                {isScanning && <Loader2 size={13} className="spin dup-scanning-icon" />}

                <span className={`dup-badge ${g.verified ? 'badge-verified' : 'badge-unverified'}`}>
                    {g.verified ? '已验证' : '待验证'}
                </span>

                <span className="dup-copies">{g.paths.length} 份</span>
                <span className="dup-size-per">{formatBytes(g.bytes)} / 份</span>

                <span className={g.verified ? 'dup-wasted pt-verified' : 'dup-wasted-estimate pt-unverified'}>
                    {g.verified ? '' : '预计'}可释放 {formatBytes(wasted)}
                </span>

                <span className={`dup-hash-prefix ${g.verified ? 'verified' : ''}`} title={g.hash}>
                    {g.hash.slice(0, 10)}…
                </span>
            </div>

            <div className={`expandable-wrapper ${isExpanded ? 'is-expanded' : ''}`}>
                <div className="expandable-content">
                    <div className="dup-path-list">
                        {g.paths.map((p, i) => {
                            const name = p.includes('\\') ? p.slice(p.lastIndexOf('\\') + 1) : p;
                            const dir = p.includes('\\') ? p.slice(0, p.lastIndexOf('\\')) : '';
                            return (
                                <div key={i} className="dup-path-row">
                                    <span className="dup-fname" title={name}>{name}</span>
                                    <span className="dup-fdir" title={dir}>{dir}</span>
                                    <button className="icon-btn" onClick={() => onOpenExplorer(p)}>
                                        <FolderOpen size={13} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
});

// ─── Main Component ──────────────────────────────────────────────────────────

export const DuplicatesPage: React.FC<Props> = ({ sizeGroups, hasScanned, state, setState }) => {
    const unlistenRef = useRef<UnlistenFn | null>(null);

    // Context getters
    const setStage = (stage: DupeStage) => setState(s => ({ ...s, stage }));
    const setProgress = (p: DupeProgress | null) => setState(s => ({ ...s, progress: p }));

    // Cleanup listener on unmount
    useEffect(() => () => { unlistenRef.current?.(); }, []);

    // ─ Listen to dupe-progress events ────────────────────────────────────────
    const startListening = useCallback(async () => {
        unlistenRef.current?.();
        const unlisten = await listen<DupeProgress>('dupe-progress', (e) => {
            setProgress(e.payload);
        });
        unlistenRef.current = unlisten;
    }, [setState]);

    // ─ Build Phase-1 candidates from sizeGroups ───────────────────────────────
    const buildCandidates = useCallback((): Record<string, string[]> => {
        const minBytes = state.minSizeMB * 1024 * 1024;
        const allowedExts = state.extFilter.trim()
            ? new Set(state.extFilter.split(',').map(e => e.trim().toLowerCase().replace(/^\./, '')))
            : null;

        const payload: Record<string, string[]> = {};
        for (const [size, paths] of sizeGroups) {
            if (size < minBytes) continue;
            if (paths.length < 2 || paths.length > state.maxGroup) continue;

            let filtered = state.pathFilter.trim()
                ? paths.filter(p => p.toLowerCase().includes(state.pathFilter.toLowerCase()))
                : paths;

            if (allowedExts) {
                filtered = filtered.filter(p => {
                    const dot = p.lastIndexOf('.');
                    if (dot === -1) return false;
                    return allowedExts.has(p.slice(dot + 1).toLowerCase());
                });
            }

            if (filtered.length >= 2) {
                payload[String(size)] = filtered;
            }
        }
        return payload;
    }, [sizeGroups, state.minSizeMB, state.maxGroup, state.extFilter, state.pathFilter]);

    // ─ Compute candidate count ───────────────────────────────────────────────
    const candidates = buildCandidates();
    const candidateGroupCount = Object.keys(candidates).length;
    const candidateFileCount = Object.values(candidates).reduce((s, v) => s + v.length, 0);

    // ─ Phase 1: start quick scan ──────────────────────────────────────────────
    const handlePhase1 = async () => {
        setState(s => ({
            ...s, stage: 'scanning1', groups: [], selectedHashes: new Set(),
            progress: { phase: 'phase1', done: 0, total: candidateFileCount }
        }));
        await startListening();
        try {
            const result = await invoke<Phase1Group[]>('start_find_duplicates', {
                candidates: buildCandidates(),
            });
            setState(s => ({
                ...s,
                stage: 'results',
                groups: result,
                selectedHashes: new Set(result.map(g => g.hash))
            }));
        } catch (e) {
            console.error('Phase1 failed:', e);
            setStage('idle');
        }
        unlistenRef.current?.();
    };

    // ─ Phase 2: deep verify selected groups IN-PLACE ──────────────────────────
    const handlePhase2 = async () => {
        const toVerify = state.groups.filter(g => state.selectedHashes.has(g.hash) && !g.verified);
        if (toVerify.length === 0) return;

        setStage('scanning2');
        const totalFiles = toVerify.reduce((s, g) => s + g.paths.length, 0);
        setProgress({ phase: 'phase2', done: 0, total: totalFiles });
        await startListening();

        try {
            const verifiedResults = await invoke<DuplicateGroup[]>('verify_duplicates', { groups: toVerify });

            // Group the verified records by their original Phase 1 hash
            const verifiedMap = new Map<string, DuplicateGroup[]>();
            for (const r of verifiedResults) {
                const arr = verifiedMap.get(r.original_hash) || [];
                arr.push(r);
                verifiedMap.set(r.original_hash, arr);
            }

            setState(s => {
                // Determine which hashes we verified in this round (Phase 1 hashes)
                const roundHashes = new Set(toVerify.map(g => g.hash));

                // Build new list
                const nextGroups: Phase1Group[] = [];

                for (const g of s.groups) {
                    if (roundHashes.has(g.hash)) {
                        // It was verified in this round. Did it pass?
                        const passes = verifiedMap.get(g.hash);
                        if (passes && passes.length > 0) {
                            // A single Phase 1 group might split into multiple Phase 2 true duplicates!
                            for (const pass of passes) {
                                nextGroups.push({
                                    hash: pass.hash, // Use the new full-file hash as the group's new unique ID
                                    bytes: pass.bytes,
                                    paths: pass.paths, // might be fewer than before!
                                    verified: true,
                                    wasted: pass.wasted
                                });
                            }
                        }
                        // if passes is undefined/empty, it completely disappears from the list
                    } else {
                        // Not part of this verification round, keep as is
                        nextGroups.push(g);
                    }
                }

                // Sort nextGroups so verified items bubble to the top, then by wasted
                nextGroups.sort((a, b) => {
                    const wA = a.verified ? a.wasted! : (a.bytes * (a.paths.length - 1));
                    const wB = b.verified ? b.wasted! : (b.bytes * (b.paths.length - 1));
                    if (a.verified !== b.verified) return a.verified ? -1 : 1;
                    return wB - wA;
                });

                // Clear selection for the ones we just verified
                const nextSelected = new Set(s.selectedHashes);
                for (const h of roundHashes) nextSelected.delete(h);

                return {
                    ...s,
                    stage: 'results',
                    groups: nextGroups,
                    selectedHashes: nextSelected
                };
            });
        } catch (e) {
            console.error('Phase2 failed:', e);
            setStage('results');
        }
        unlistenRef.current?.();
    };

    // ─ UI Interactions ────────────────────────────────────────────────────────
    const toggleSelect = useCallback((hash: string) => {
        setState(s => {
            const next = new Set(s.selectedHashes);
            if (next.has(hash)) next.delete(hash); else next.add(hash);
            return { ...s, selectedHashes: next };
        });
    }, [setState]);

    const toggleExpand = useCallback((hash: string) => {
        setState(s => {
            const next = new Set(s.expandedHashes);
            if (next.has(hash)) next.delete(hash); else next.add(hash);
            return { ...s, expandedHashes: next };
        });
    }, [setState]);

    const handleOpenExplorer = useCallback(async (path: string) => {
        const parent = path.includes('\\') ? path.slice(0, path.lastIndexOf('\\')) : path;
        try { await invoke('open_explorer', { path: parent }); } catch { /* ignore */ }
    }, []);

    const pct = state.progress && state.progress.total > 0
        ? Math.round((state.progress.done / state.progress.total) * 100) : 0;

    if (!hasScanned) {
        return <div className="dup-page-empty">请先在主界面扫描一个目录。</div>;
    }

    const unverifiedSelectedCount = Array.from(state.selectedHashes).filter(h => {
        const g = state.groups.find(x => x.hash === h);
        return g && !g.verified;
    }).length;

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="dup-page">
            {/* ── 1. Filter settings ──────────────────────────────────────── */}
            <div className="dup-filters">
                <div className="dup-filter-row">
                    <label className="dup-filter-label">最小文件大小</label>
                    <div className="dup-filter-control">
                        <input
                            type="number" min="0" step="1"
                            value={state.minSizeMB}
                            onChange={e => setState(s => ({ ...s, minSizeMB: Number(e.target.value) }))}
                            className="dup-number-input"
                            disabled={state.stage === 'scanning1' || state.stage === 'scanning2'}
                        />
                        <span className="dup-unit">MB</span>
                    </div>

                    <label className="dup-filter-label">组内文件上限</label>
                    <div className="dup-filter-control">
                        <input
                            type="number" min="2" max="1000"
                            value={state.maxGroup}
                            onChange={e => setState(s => ({ ...s, maxGroup: Number(e.target.value) }))}
                            className="dup-number-input"
                            disabled={state.stage === 'scanning1' || state.stage === 'scanning2'}
                        />
                    </div>

                    <label className="dup-filter-label">扩展名</label>
                    <input
                        type="text" placeholder="mp4, mkv, zip …（空=全部）"
                        value={state.extFilter}
                        onChange={e => setState(s => ({ ...s, extFilter: e.target.value }))}
                        className="dup-text-input"
                        disabled={state.stage === 'scanning1' || state.stage === 'scanning2'}
                    />

                    <label className="dup-filter-label">路径包含</label>
                    <input
                        type="text" placeholder="Users\Downloads …"
                        value={state.pathFilter}
                        onChange={e => setState(s => ({ ...s, pathFilter: e.target.value }))}
                        className="dup-text-input"
                        disabled={state.stage === 'scanning1' || state.stage === 'scanning2'}
                    />
                </div>

                <div className="dup-filter-actions">
                    <span className="dup-candidate-info">
                        {candidateGroupCount} 组 · {candidateFileCount} 个文件待快速扫描
                    </span>
                    <button
                        className="btn btn-primary"
                        onClick={handlePhase1}
                        disabled={state.stage === 'scanning1' || state.stage === 'scanning2' || candidateGroupCount === 0}
                    >
                        {state.stage === 'scanning1'
                            ? <><Loader2 size={14} className="spin" /> 快速扫描中…</>
                            : <><Search size={14} /> 开始快速扫描 (64KB)</>
                        }
                    </button>
                </div>
            </div>

            {/* ── 2. Progress bar ─────────────────────────────────────────── */}
            {(state.stage === 'scanning1' || state.stage === 'scanning2') && state.progress && (
                <div className="dup-progress-area">
                    <div className="dup-progress-label">
                        <span>
                            {state.stage === 'scanning1' ? '快速扫描 (64KB)' : '深度哈希验证'}
                        </span>
                        <span>{state.progress.done} / {state.progress.total} 个文件 · {pct}%</span>
                    </div>
                    <div className="dup-progress-track">
                        <div
                            className={`dup-progress-fill ${state.stage === 'scanning2' ? 'phase2' : ''}`}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                </div>
            )}

            {/* ── 3. Single List (In-place verified) ──────────────────────── */}
            {(state.stage === 'results' || state.stage === 'scanning2') && state.groups.length > 0 && (
                <div className="dup-section" style={{ flex: 1 }}>
                    <div className="dup-section-header">
                        <span className="dup-section-title">
                            共 {state.groups.length} 组疑似重复
                        </span>
                        <div className="dup-section-actions">
                            <button className="dup-link-btn" onClick={() => setState(s => ({
                                ...s,
                                selectedHashes: new Set(s.groups.filter(g => !g.verified).map(g => g.hash))
                            }))}>
                                全选未验证
                            </button>
                            <button className="dup-link-btn" onClick={() => setState(s => ({ ...s, selectedHashes: new Set() }))}>
                                全不选
                            </button>
                            <button
                                className="btn btn-verify"
                                onClick={handlePhase2}
                                disabled={unverifiedSelectedCount === 0 || state.stage === 'scanning2'}
                            >
                                {state.stage === 'scanning2'
                                    ? <><Loader2 size={13} className="spin" /> 深度验证中…</>
                                    : <><ShieldCheck size={13} /> 深度验证选中 ({unverifiedSelectedCount} 组)</>
                                }
                            </button>
                        </div>
                    </div>

                    <div className="dup-group-list">
                        <Virtuoso
                            style={{ height: '100%', overflowY: 'scroll' }}
                            data={state.groups}
                            itemContent={(_index, g) => (
                                <DuplicateGroupRow
                                    key={g.hash}
                                    g={g}
                                    isSelected={state.selectedHashes.has(g.hash)}
                                    isExpanded={state.expandedHashes.has(g.hash)}
                                    isScanning={state.stage === 'scanning2' && state.selectedHashes.has(g.hash)}
                                    onToggleExpand={toggleExpand}
                                    onToggleSelect={toggleSelect}
                                    onOpenExplorer={handleOpenExplorer}
                                    disabled={state.stage === 'scanning2'}
                                />
                            )}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
