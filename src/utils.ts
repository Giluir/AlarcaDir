import { DirectoryNode, FlatNode, FileChangeEvent } from './types';

/**
 * Convert the flat node array emitted by the Rust scanner into a DirectoryNode tree.
 * O(n) — one Map lookup per node. No recursion; all children are linked by parent_id.
 *
 * @param flat  Array of FlatNode as returned by `start_scan`.
 * @returns     Root DirectoryNode, fully nested and ready for annotateWithTotalSize.
 */
export function buildTreeFromFlat(flat: FlatNode[]): DirectoryNode {
    // Build a map: id → DirectoryNode (without children yet)
    const nodeMap = new Map<number, DirectoryNode>();
    for (const f of flat) {
        const dn: DirectoryNode = { n: f.n, s: f.s };
        if (f.l !== undefined) dn.l = f.l;
        if (f.t !== undefined) dn.t = f.t;
        nodeMap.set(f.id, dn);
    }

    let root: DirectoryNode | undefined;

    // Wire up parent → child relationships
    for (const f of flat) {
        if (f.parent_id === -1) {
            root = nodeMap.get(f.id);
            continue;
        }
        const parent = nodeMap.get(f.parent_id);
        const self = nodeMap.get(f.id);
        if (parent && self) {
            if (!parent.c) parent.c = [];
            parent.c.push(self);
        }
    }

    if (!root) throw new Error('buildTreeFromFlat: no root node found');
    return root;
}

/**
 * Decode the compact binary format emitted by the Rust `encode_nodes()` function
 * directly into a DirectoryNode tree — NO intermediate FlatNode array, ONE pass.
 *
 * Binary layout per node (all LE):
 *   id:        u32 (4)
 *   parent_id: i32 (4)  — -1 for root
 *   size_hi:   u32 (4)  — high 32 bits of physical size
 *   size_lo:   u32 (4)  — low  32 bits of physical size
 *   flags:     u8  (1)  — bit0=is_dir, bit1=has_logical
 *   name_len:  u16 (2)
 *   name:      UTF-8 (name_len bytes)
 *   [if bit1]: logical_hi: u32, logical_lo: u32 (8 bytes)
 */
export function buildTreeFromBinary(data: any): DirectoryNode {
    if (!data) throw new Error('buildTreeFromBinary: no data received');

    let buf: ArrayBuffer;
    let byteOffset = 0;
    let byteLength = 0;

    if (data instanceof ArrayBuffer) {
        buf = data;
        byteLength = data.byteLength;
    } else if (data.buffer instanceof ArrayBuffer) {
        // Handle Uint8Array or other TypedArrays
        buf = data.buffer;
        byteOffset = data.byteOffset;
        byteLength = data.byteLength;
    } else if (Array.isArray(data)) {
        // Fallback if data is returned as a plain number array (JSON fallback)
        const u8 = new Uint8Array(data);
        buf = u8.buffer;
        byteLength = u8.byteLength;
    } else {
        throw new Error(`buildTreeFromBinary: Unexpected data type ${data.constructor?.name || typeof data}`);
    }

    const view = new DataView(buf, byteOffset, byteLength);
    const decoder = new TextDecoder();
    const nodeMap = new Map<number, DirectoryNode>();
    let root: DirectoryNode | undefined;
    let offset = 0;
    const end = byteLength;

    while (offset < end) {
        const id = view.getUint32(offset, true); offset += 4;
        const parentId = view.getInt32(offset, true); offset += 4;
        const sizeHi = view.getUint32(offset, true); offset += 4;
        const sizeLo = view.getUint32(offset, true); offset += 4;
        const flags = view.getUint8(offset); offset += 1;
        const nameLen = view.getUint16(offset, true); offset += 2;
        const name = decoder.decode(new Uint8Array(buf, byteOffset + offset, nameLen)); offset += nameLen;

        let logical: number | undefined;
        if (flags & 0x02) {
            const logHi = view.getUint32(offset, true); offset += 4;
            const logLo = view.getUint32(offset, true); offset += 4;
            logical = logHi * 4294967296 + logLo;
        }

        const size = sizeHi * 4294967296 + sizeLo;
        const isDir = !!(flags & 0x01);

        const node: DirectoryNode = { n: name, s: size };
        if (logical !== undefined) node.l = logical;
        if (isDir) node.t = 'd';

        nodeMap.set(id, node);

        if (parentId === -1) {
            root = node;
        } else {
            const parent = nodeMap.get(parentId);
            if (parent) {
                if (!parent.c) parent.c = [];
                parent.c.push(node);
            }
        }
    }

    if (!root) throw new Error('buildTreeFromBinary: no root node found');
    return root;
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function calculateTotalSize(node: DirectoryNode): number {
    return Number(node.s) || 0;
}

// ─── Extension stats ─────────────────────────────────────────────────────────
export interface ExtStat { count: number; bytes: number; }
export type ExtMap = Map<string, ExtStat>;
/** WeakMap: DirectoryNode → aggregated extension stats for its entire subtree. */
export const extStatsCache = new WeakMap<DirectoryNode, ExtMap>();

// ─── File categories ──────────────────────────────────────────────────────────
export const FILE_CATEGORIES: Record<string, string[]> = {
    '视频': ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'vob'],
    '图片': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'tif', 'raw', 'heic', 'avif'],
    '文档': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf', 'csv', 'odt', 'ods'],
    '代码': ['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'cpp', 'c', 'h', 'hpp', 'cs', 'go', 'java', 'json', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'sh', 'toml', 'yaml', 'yml'],
    '压缩': ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'cab', 'iso', 'dmg'],
    '音频': ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'opus'],
    '系统': ['exe', 'dll', 'sys', 'msi', 'bat', 'cmd', 'reg', 'lnk', 'inf', 'drv'],
};

export const OTHER_CATEGORY = '其他';

export const CATEGORY_COLORS: Record<string, string> = {
    '视频': '#7E57C2',
    '图片': '#26C6DA',
    '文档': '#FFA726',
    '代码': '#42A5F5',
    '压缩': '#FF7043',
    '音频': '#66BB6A',
    '系统': '#90A4AE',
    [OTHER_CATEGORY]: '#CFD8DC',
};
const EXT_TO_CATEGORY = new Map<string, string>();
for (const [cat, exts] of Object.entries(FILE_CATEGORIES)) {
    for (const e of exts) EXT_TO_CATEGORY.set(e, cat);
}
export function getCategory(ext: string): string {
    return EXT_TO_CATEGORY.get(ext) ?? OTHER_CATEGORY;
}

// ─── Top-N per-node cache ─────────────────────────────────────────────────────
const TOP_FILES_LIMIT = 50;

export interface TopFileEntry { path: string; bytes: number; }

/**
 * WeakMap: DirectoryNode → top-50 largest files in its subtree (sorted desc).
 * Populated once by annotateWithTotalSize; O(1) lookup during navigation.
 * Auto-freed by GC when old scan data is released.
 */
export const topFilesNodeCache = new WeakMap<DirectoryNode, TopFileEntry[]>();

/**
 * Map<sizeBytes, path[]> — same-size file groups with ≥2 members.
 * Used as the pre-filter before SHA-256 hashing for duplicate detection.
 * Reset on each new scan via resetScanCaches().
 */
export let sizeGroupCache: Map<number, string[]> = new Map();

/** O(1) mapping from lowercase absolute path to DirectoryNode */
export const pathNodeMap = new Map<string, DirectoryNode>();

/** Reset mutable global caches before starting a new scan. */
export function resetScanCaches() {
    sizeGroupCache = new Map();
    pathNodeMap.clear();
}

// ─── Merge two sorted TopFileEntry arrays, take top-K ─────────────────────────
function mergeTopK(a: TopFileEntry[], b: TopFileEntry[], k: number): TopFileEntry[] {
    const result: TopFileEntry[] = [];
    let i = 0, j = 0;
    while (result.length < k && (i < a.length || j < b.length)) {
        if (i < a.length && (j >= b.length || a[i].bytes >= b[j].bytes)) {
            result.push(a[i++]);
        } else {
            result.push(b[j++]);
        }
    }
    return result;
}

// ─── Main annotation pass ─────────────────────────────────────────────────────
/**
 * One-time O(n) post-order traversal that simultaneously:
 *  1. Stamps every directory node's 's' with its recursive total size.
 *  2. Builds extStatsCache for every directory node.
 *  3. Builds topFilesNodeCache (top-50 files) for every directory node.
 *  4. Builds sizeGroupCache (same-size groups, global) for duplicate detection.
 *
 * Call once after scan data arrives. Do NOT pass a basePath — the root node's
 * n field already contains the full root path (e.g. "C:\").
 *
 * Returns [extMap, topFiles] for the node (used internally for bottom-up merge).
 */
export function annotateWithTotalSize(
    node: DirectoryNode,
    currentPath = '',
): [ExtMap, TopFileEntry[]] {
    // Build full filesystem path for this node.
    // When currentPath is '' (root call), nodePath = node.n (e.g. "C:\").
    // For children, currentPath is the parent's nodePath.
    const nodePath = currentPath === ''
        ? node.n
        : (currentPath.endsWith('\\') ? currentPath + node.n : currentPath + '\\' + node.n);

    pathNodeMap.set(nodePath.toLowerCase(), node);

    // ── Leaf file ────────────────────────────────────────────────────────────
    if (node.t !== 'd') {
        const bytes = Number(node.s) || 0;
        const ext = node.n.includes('.')
            ? node.n.slice(node.n.lastIndexOf('.') + 1).toLowerCase()
            : '';

        const m: ExtMap = new Map();
        if (bytes > 0) m.set(ext, { count: 1, bytes });

        // Register in size-group cache for duplicate detection
        if (bytes > 0) {
            const existing = sizeGroupCache.get(bytes);
            if (existing) existing.push(nodePath);
            else sizeGroupCache.set(bytes, [nodePath]);
        }

        return [m, bytes > 0 ? [{ path: nodePath, bytes }] : []];
    }

    // ── Directory ─────────────────────────────────────────────────────────────
    const merged: ExtMap = new Map();
    let total = 0;
    let runningTop: TopFileEntry[] = [];

    if (node.c && node.c.length > 0) {
        for (const child of node.c) {
            const [childMap, childTop] = annotateWithTotalSize(child, nodePath);
            total += Number(child.s) || 0;

            // Merge extension stats
            for (const [ext, stat] of childMap) {
                const existing = merged.get(ext);
                if (existing) {
                    existing.count += stat.count;
                    existing.bytes += stat.bytes;
                } else {
                    merged.set(ext, { count: stat.count, bytes: stat.bytes });
                }
            }

            // Incrementally merge top files — O(K) per child, never grows past K
            runningTop = mergeTopK(runningTop, childTop, TOP_FILES_LIMIT);
        }
    }

    node.s = total;
    extStatsCache.set(node, merged);
    topFilesNodeCache.set(node, runningTop);

    return [merged, runningTop];
}

// ─── Incremental Patching ─────────────────────────────────────────────────────

/**
 * Update the tree in-place and returning true if the UI should re-render.
 * Background data updates (pathNodeMap, sizes, etc.) happen for ALL changes.
 * 
 * @param currentViewPath  The path currently being viewed in the Treemap.
 * @param viewTotalSize    The total size of the current view root (to calc significance).
 */
export function applyFileChanges(
    changes: FileChangeEvent[],
    currentViewPath: string,
    viewTotalSize: number
): boolean {
    let visualChanged = false;
    let dataChanged = false;

    const currentViewPathLower = currentViewPath.toLowerCase();
    const significanceThreshold = viewTotalSize * 0.001; // Strictly 0.1%

    const getParentPath = (path: string) => {
        const idx = path.lastIndexOf('\\');
        if (idx < 0) return '';
        if (idx === 2 && path[1] === ':') return path.slice(0, 3);
        return path.slice(0, idx);
    };

    const getFileName = (path: string) => {
        const idx = path.lastIndexOf('\\');
        return idx > -1 ? path.slice(idx + 1) : path;
    };

    const dirtyDirs = new Set<string>();

    for (const change of changes) {
        const lowerPath = change.path.toLowerCase();
        const isInView = lowerPath.startsWith(currentViewPathLower);
        const parentPathLower = getParentPath(lowerPath);
        const name = getFileName(change.path);

        if (!parentPathLower) continue;

        const parentNode = pathNodeMap.get(parentPathLower);
        if (!parentNode || parentNode.t !== 'd') continue;

        let delta = 0;
        let existing = pathNodeMap.get(lowerPath);

        if (change.kind === 'Modify' || change.kind === 'Create') {
            if (existing) {
                if (existing.t !== 'd') {
                    delta = change.size - (Number(existing.s) || 0);
                    existing.s = change.size;
                }
            } else {
                delta = change.size;
                const newNode: DirectoryNode = { n: name, s: change.size };
                if (!parentNode.c) parentNode.c = [];
                parentNode.c.push(newNode);
                pathNodeMap.set(lowerPath, newNode);
                existing = newNode;
            }
        } else if (change.kind === 'Remove') {
            if (existing) {
                delta = -(Number(existing.s) || 0);
                if (parentNode.c) {
                    parentNode.c = parentNode.c.filter(n => n !== existing);
                }
                pathNodeMap.delete(lowerPath);
            }
        }

        if (delta !== 0 || change.kind === 'Remove' || change.kind === 'Create') {
            dataChanged = true;

            // SIGNIFICANCE CHECK:
            // Only trigger visual update if the change is in/under the current view
            // and is either a structure change or a "large" size delta.
            if (isInView) {
                if (change.kind !== 'Modify' || Math.abs(delta) > significanceThreshold) {
                    visualChanged = true;
                }
            }

            let currP = parentPathLower;
            while (currP) {
                const pNode = pathNodeMap.get(currP);
                if (!pNode) break;

                pNode.s = Math.max(0, (Number(pNode.s) || 0) + delta);
                dirtyDirs.add(currP);

                const nextP = getParentPath(currP);
                if (nextP === currP) break;
                currP = nextP;
            }
        }
    }

    if (dataChanged && dirtyDirs.size > 0) {
        const sortedDirty = Array.from(dirtyDirs).sort((a, b) => b.length - a.length);

        for (const dirPath of sortedDirty) {
            const dirNode = pathNodeMap.get(dirPath);
            if (!dirNode) continue;

            const mergedExt: ExtMap = new Map();
            let runningTop: TopFileEntry[] = [];

            if (dirNode.c) {
                for (const child of dirNode.c) {
                    if (child.t !== 'd') {
                        const bytes = Number(child.s) || 0;
                        const ext = child.n.includes('.') ? child.n.slice(child.n.lastIndexOf('.') + 1).toLowerCase() : '';
                        if (bytes > 0) {
                            const existingExt = mergedExt.get(ext);
                            if (existingExt) {
                                existingExt.count += 1;
                                existingExt.bytes += bytes;
                            } else {
                                mergedExt.set(ext, { count: 1, bytes });
                            }
                            const childPath = dirPath.endsWith('\\') ? dirPath + child.n : dirPath + '\\' + child.n;
                            runningTop = mergeTopK(runningTop, [{ path: childPath, bytes }], TOP_FILES_LIMIT);
                        }
                    } else {
                        const childExt = extStatsCache.get(child);
                        if (childExt) {
                            for (const [ext, stat] of childExt) {
                                const existing = mergedExt.get(ext);
                                if (existing) {
                                    existing.count += stat.count;
                                    existing.bytes += stat.bytes;
                                } else {
                                    mergedExt.set(ext, { count: stat.count, bytes: stat.bytes });
                                }
                            }
                        }
                        const childTop = topFilesNodeCache.get(child);
                        if (childTop) {
                            runningTop = mergeTopK(runningTop, childTop, TOP_FILES_LIMIT);
                        }
                    }
                }
            }

            extStatsCache.set(dirNode, mergedExt);
            topFilesNodeCache.set(dirNode, runningTop);
        }
    }

    return visualChanged;
}
