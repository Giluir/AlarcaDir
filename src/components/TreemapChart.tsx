import React, { useMemo, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import { invoke } from '@tauri-apps/api/core';
import { DirectoryNode } from '../types';
import { formatBytes, calculateTotalSize } from '../utils';

interface Props {
    dataRoot: DirectoryNode | null;
    basePath: string;
    maxDepth: number;
    filterThreshold: number;
    updateRevision: number;
    onDrillDown: (node: DirectoryNode, pathTrace?: DirectoryNode[]) => void;
    onDrillUp: () => void;
}

export const TreemapChart: React.FC<Props> = React.memo(({ dataRoot, basePath, maxDepth, filterThreshold, updateRevision, onDrillDown, onDrillUp }) => {
    const chartRef = useRef<ReactECharts>(null);

    if (!dataRoot) return null;

    const processDataForTreemap = (node: DirectoryNode, rootTotalSize: number, currentDepth = 0): any => {
        let nodeTotalSize = node.t === 'd' ? calculateTotalSize(node) : (Number(node.s) || 0);

        // --- Header Merging Logic ---
        // If this is a directory and has exactly one child, and that child is also a directory,
        // we merge the names and "skip" this node's header level.
        let displayName = node.n;
        let effectiveNode = node;

        while (
            effectiveNode.t === 'd' &&
            effectiveNode.c &&
            effectiveNode.c.length === 1 &&
            effectiveNode.c[0].t === 'd' &&
            currentDepth < maxDepth // Don't merge if we're hitting the limit anyway
        ) {
            const onlyChild = effectiveNode.c[0];
            displayName += ' / ' + onlyChild.n;
            effectiveNode = onlyChild;
            // Note: We don't increment currentDepth here because we are merging the headers
            // only increment depth when we actually start processing multiple children or files.
        }
        // Use the total size of the original node (the container)
        // -----------------------------

        if (effectiveNode.t !== 'd') {
            return {
                name: displayName,
                value: nodeTotalSize,
                itemStyle: { color: '#A5D6A7' },
            };
        }

        if (currentDepth >= maxDepth) {
            return {
                name: displayName,
                value: nodeTotalSize,
                itemStyle: { color: '#90CAF9' }
            };
        }

        const processedChildren = [];
        let smallItemsSize = 0;

        if (effectiveNode.c && effectiveNode.c.length > 0) {
            const sortedC = [...effectiveNode.c].sort((a, b) => {
                const sizeA = a.t === 'd' ? calculateTotalSize(a) : (Number(a.s) || 0);
                const sizeB = b.t === 'd' ? calculateTotalSize(b) : (Number(b.s) || 0);
                return sizeB - sizeA;
            });

            for (let i = 0; i < sortedC.length; i++) {
                const child = sortedC[i];
                const childSize = child.t === 'd' ? calculateTotalSize(child) : (Number(child.s) || 0);

                // Performance Pruning: ignore truly tiny items (< 0.05% of root)
                if (childSize < rootTotalSize * 0.0005) {
                    continue;
                }

                // Smart filtering: merge items smaller than adjustable threshold
                if (childSize < rootTotalSize * filterThreshold || i >= 100) {
                    smallItemsSize += childSize;
                    continue;
                }

                const processed = processDataForTreemap(child, rootTotalSize, currentDepth + 1);
                if (processed.value > 0) {
                    processedChildren.push(processed);
                }
            }

            // Add the "Other" block if there's significant filtered data
            // AND we have at least one substantial child to show it alongside.
            // If ALL items are small, we'll just fold the folder (below).
            if (smallItemsSize > 0 && processedChildren.length > 0) {
                processedChildren.push({
                    name: `[Other items]`, // Keep name Short
                    value: smallItemsSize,
                    itemStyle: {
                        color: '#f0f0f0',
                        borderColor: '#e0e0e0',
                        borderWidth: 1
                    },
                    label: {
                        show: true,
                        fontSize: 9,
                        formatter: `Other (${formatBytes(smallItemsSize)})`
                    }
                });
            }

            processedChildren.sort((a, b) => b.value - a.value);
        }

        // Folding: If the node had children but nothing met the display criteria,
        // render it as a solid folder block instead of an empty container.
        if (effectiveNode.c && effectiveNode.c.length > 0 && processedChildren.length === 0) {
            return {
                name: displayName,
                value: nodeTotalSize,
                itemStyle: { color: '#90CAF9' }
            };
        }

        return {
            name: displayName,
            value: nodeTotalSize,
            itemStyle: { color: '#90CAF9' },
            children: processedChildren.length > 0 ? processedChildren : undefined,
        };
    };

    const chartOptions = useMemo(() => {
        const rootTotalSize = dataRoot.t === 'd' ? calculateTotalSize(dataRoot) : (Number(dataRoot.s) || 0);
        const data = processDataForTreemap(dataRoot, rootTotalSize, 0);

        return {
            tooltip: {
                formatter: (params: any) => `${params.name}: ${formatBytes(params.value)}`,
            },
            series: [{
                type: 'treemap',
                data: [data],
                roam: false,
                nodeClick: false, // Disabling ECharts' native drill down so we can handle it via React state
                breadcrumb: { show: false }, // Disabling echarts breadcrumb since we have our own UI breadcrumbs
                labelLayout: {
                    hideOverlap: false // SpaceSniffer shows text even if overlap/truncated sometimes, but let's just make it smaller
                },
                label: {
                    show: true,
                    formatter: (params: any) => {
                        return `${params.name}\n${formatBytes(params.value)}`;
                    },
                    fontSize: 10,
                    color: '#2C3E50', // 深色文字，在浅色背景上极具可读性
                    overflow: 'truncate',
                    minMargin: 2
                },
                upperLabel: {
                    show: true,
                    height: 24,
                    fontSize: 10,
                    fontWeight: 'bold',
                    color: '#ffffff', // 头部再次改为白色，在实体蓝底上对比更好
                    backgroundColor: '#64B5F6', // 适合的浅蓝色头部，区别于普通文件夹
                    borderColor: '#ffffff', // 维持纯白边框以分割
                    borderWidth: 1,
                    formatter: (params: any) => `  ${params.name} (${formatBytes(params.value)})`,
                },
                itemStyle: {
                    borderColor: '#ffffff',
                    borderWidth: 1,
                    gapWidth: 0,
                    borderRadius: 3 // 小圆角优化形状，不破坏缝隙
                },
                levels: [
                    {
                        itemStyle: { borderWidth: 0, gapWidth: 2, borderRadius: 3 },
                        label: { color: '#2C3E50' },
                        upperLabel: { color: '#2C3E50' }
                    },
                    {
                        itemStyle: { borderWidth: 1, borderColor: '#ffffff', gapWidth: 1, borderRadius: 3 },
                        label: { color: '#2C3E50' },
                        upperLabel: { show: true, color: '#2C3E50' }
                    },
                    {
                        itemStyle: { borderWidth: 1, borderColor: '#ffffff', borderRadius: 3 },
                        label: { color: '#2C3E50' }
                    }
                ]
            }]
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataRoot, maxDepth, filterThreshold, updateRevision]);

    const handleChartClick = (params: any) => {
        if (!dataRoot || !dataRoot.c) return;
        console.log("Treemap clicked:", params.name, "treePathInfo:", params.treePathInfo);

        // If clicking the invisible root node itself (length 2: Series -> dataRoot)
        if (!params.treePathInfo || params.treePathInfo.length <= 2) {
            onDrillUp();
            return;
        }

        let targetNode = dataRoot;
        let lastFolderNode = dataRoot;
        const drillPathTrace: DirectoryNode[] = [];

        // Traverse the path down to the clicked node
        for (let i = 2; i < params.treePathInfo.length; i++) {
            const pathName = params.treePathInfo[i].name;
            if (pathName === '[Other items]') return; // Virtual node, cannot drill down

            // Handle merged headers like "Folder A / Folder B"
            const segments = pathName.split(' / ');
            let currentSearchNode = targetNode;
            let allSegmentsFound = true;

            for (const seg of segments) {
                const nextNode = currentSearchNode.c?.find(child => child.n === seg);
                if (nextNode) {
                    currentSearchNode = nextNode;
                    if (currentSearchNode.t === 'd') {
                        lastFolderNode = currentSearchNode;
                        drillPathTrace.push(currentSearchNode);
                    }
                } else {
                    allSegmentsFound = false;
                    break;
                }
            }

            if (allSegmentsFound) {
                targetNode = currentSearchNode;
            } else {
                break;
            }
        }

        if (lastFolderNode && lastFolderNode !== dataRoot) {
            console.log("Treemap drilling down to:", lastFolderNode.n, "trace:", drillPathTrace);
            onDrillDown(lastFolderNode, drillPathTrace);
        }
    };

    const handleContextMenu = async (params: any) => {
        console.log("👉 [DEBUG] Right-Click Event Triggered in Treemap!", params);
        // Prevent default browser context menu
        params.event?.event?.preventDefault();

        if (!params.treePathInfo || params.treePathInfo.length <= 1) {
            console.log("👉 [DEBUG] Treemap ContextMenu Aborted: No treePathInfo or too short.", params.treePathInfo);
            return;
        }

        let fullPath = basePath;
        for (let i = 2; i < params.treePathInfo.length; i++) {
            const name = params.treePathInfo[i].name;
            if (name === '[Other items]') {
                console.log("👉 [DEBUG] Right-Click inside Other items ignored.");
                return;
            }

            // Handle merged headers by splitting
            const segments = name.split(' / ');
            for (const seg of segments) {
                const sep = fullPath.endsWith('\\') ? '' : '\\';
                fullPath += sep + seg;
            }
        }

        console.log("👉 [DEBUG] Treemap Attempting to open absolute system path:", fullPath);
        try {
            await invoke('open_explorer', { path: fullPath });
            console.log("👉 [DEBUG] open_explorer API call succeeded.");
        } catch (err) {
            console.error("👉 [DEBUG] open_explorer API call FAILED:", fullPath, err);
        }
    };

    // Global context menu disable for the chart area
    const handleContextMenuGlobal = (e: React.MouseEvent) => {
        e.preventDefault();
    };

    return (
        <div onContextMenu={handleContextMenuGlobal} style={{ height: '100%', width: '100%' }}>
            <ReactECharts
                ref={chartRef}
                option={chartOptions}
                onEvents={{
                    'click': handleChartClick,
                    'contextmenu': handleContextMenu
                }}
                style={{ height: '100%', width: '100%' }}
                lazyUpdate={true}
                notMerge={true}
            />
        </div>
    );
});
