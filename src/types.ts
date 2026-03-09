export interface DirectoryNode {
    n: string;
    s: number;
    l?: number;
    t?: string;
    c?: DirectoryNode[];
}

/** Flat node as emitted by the Rust scanner (flat array instead of nested tree). */
export interface FlatNode {
    id: number;
    parent_id: number;    // -1 for root
    n: string;
    s: number;
    l?: number;
    t?: string;           // "d" = directory, absent = file
}

export interface ProgressPayload {
    files: number;
    bytes: number;
    path: string;
}

export interface FileChangeEvent {
    kind: string; // "Create", "Remove", "Modify"
    path: string;
    size: number;
}
