import React, { useMemo, useState, useCallback } from 'react';
import { DirectoryNode } from '../types';
import { formatBytes, extStatsCache, FILE_CATEGORIES, OTHER_CATEGORY, getCategory, CATEGORY_COLORS } from '../utils';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
    dataRoot: DirectoryNode | null;
    updateRevision: number;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

const CategoryGroupRow: React.FC<{
    cat: string;
    catData: { bytes: number; count: number; exts: any[] };
    isExpanded: boolean;
    onToggle: (cat: string) => void;
    totalSize: number;
    color: string;
}> = React.memo(({ cat, catData, isExpanded, onToggle, totalSize, color }) => {
    const catPctTotal = (catData.bytes / totalSize) * 100;

    return (
        <div className="category-group">
            <div className="category-header" onClick={() => onToggle(cat)}>
                <div className="cat-icon" style={{ backgroundColor: color }}></div>
                <div className="cat-name-group">
                    <span className="cat-name">{cat}</span>
                    <span className="cat-pct">{catPctTotal.toFixed(1)}% ({catData.count} 文件)</span>
                </div>
                <div className="cat-stats">
                    <span className="cat-bytes">{formatBytes(catData.bytes)}</span>
                </div>
                <div className="cat-chevron">
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
            </div>

            <div className={`expandable-wrapper ${isExpanded ? 'is-expanded' : ''}`}>
                <div className="expandable-content">
                    <div className="extensions-list">
                        {catData.exts.map(extData => {
                            const extPct = (extData.bytes / catData.bytes) * 100;
                            return (
                                <div key={extData.ext} className="ext-item">
                                    <div className="ext-label">{extData.ext}</div>
                                    <div className="ext-bar-bg">
                                        <div
                                            className="ext-bar-fill"
                                            style={{
                                                width: `${extPct}%`,
                                                backgroundColor: color
                                            }}
                                        />
                                    </div>
                                    <div className="ext-size">{formatBytes(extData.bytes)}</div>
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

export const FileTypeDistribution: React.FC<Props> = ({ dataRoot, updateRevision }) => {
    // Keep track of which categories are expanded in the list
    const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());

    const toggleCat = useCallback((cat: string) => {
        setExpandedCats(prev => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat);
            else next.add(cat);
            return next;
        });
    }, []);

    const data = useMemo(() => {
        if (!dataRoot) return null;

        const extMap = extStatsCache.get(dataRoot);
        if (!extMap || extMap.size === 0) return null;

        const totalBytes = [...extMap.values()].reduce((s, v) => s + v.bytes, 0);
        if (totalBytes === 0) return null;

        const catMap = new Map<string, { bytes: number; count: number; exts: Array<{ ext: string; bytes: number; count: number }> }>();

        for (const cat of [...Object.keys(FILE_CATEGORIES), OTHER_CATEGORY]) {
            catMap.set(cat, { bytes: 0, count: 0, exts: [] });
        }

        for (const [ext, stat] of extMap) {
            const cat = getCategory(ext);
            const catEntry = catMap.get(cat)!;
            catEntry.bytes += stat.bytes;
            catEntry.count += stat.count;
            catEntry.exts.push({
                ext: ext ? `.${ext}` : '(no ext)',
                bytes: stat.bytes,
                count: stat.count
            });
        }

        // Sort categories by descending size
        const sortedCats = [...catMap.entries()]
            .filter(([, data]) => data.bytes > 0)
            .sort((a, b) => b[1].bytes - a[1].bytes);

        // Sort extensions within each category
        for (const [, catData] of sortedCats) {
            catData.exts.sort((a, b) => b.bytes - a.bytes);
        }

        return { totalBytes, categories: sortedCats };
    }, [dataRoot, updateRevision]);

    if (!data) {
        return (
            <div className="empty-distribution">
                暂无文件类型数据
            </div>
        );
    }

    return (
        <div className="file-type-distribution">
            {/* 1. Stacked Bar Chart */}
            <div className="stacked-bar-container">
                <div className="stacked-bar">
                    {data.categories.map(([cat, catData]) => {
                        const pct = (catData.bytes / data.totalBytes) * 100;
                        if (pct < 0.2 && data.categories.length > 5) return null; // hide tiny slivers
                        return (
                            <div
                                key={cat}
                                className="bar-segment"
                                style={{
                                    width: `${pct}%`,
                                    backgroundColor: CATEGORY_COLORS[cat]
                                }}
                                title={`${cat}: ${formatBytes(catData.bytes)}`}
                            />
                        );
                    })}
                </div>
            </div>

            {/* 2. Total Info */}
            <div className="distribution-total">
                <span className="total-label">已扫描空间</span>
                <span className="total-value">{formatBytes(data.totalBytes)}</span>
            </div>

            {/* 3. Expandable Category List */}
            <div className="category-list">
                {data.categories.map(([cat, catData]) => (
                    <CategoryGroupRow
                        key={cat}
                        cat={cat}
                        catData={catData}
                        isExpanded={expandedCats.has(cat)}
                        onToggle={toggleCat}
                        totalSize={data.totalBytes}
                        color={CATEGORY_COLORS[cat]}
                    />
                ))}
            </div>
        </div>
    );
};
