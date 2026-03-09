// scanner/types.rs
// Shared data types for the Rust-native disk scanner.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

/// Cancellation token - shared between scan coordinator and worker threads.
pub type CancelFlag = Arc<AtomicBool>;

/// Progress reporting callback.
/// Called from worker threads; implementors should be fast (e.g. emit & return).
pub trait ProgressReporter: Send + Sync {
    fn report(&self, files: u64, bytes: u64, path: &str);
}

/// Flat representation of a single file/directory node.
/// Using a flat array + parent_id avoids deep JSON nesting and JS stack pressure.
#[derive(serde::Serialize, Debug)]
pub struct FlatNode {
    /// Unique 0-based id within this scan result.
    pub id: u32,
    /// -1 for root node.
    pub parent_id: i64,
    /// File or directory name (not full path).
    pub n: String,
    /// Physical (allocated, on-disk) size in bytes.
    pub s: u64,
    /// Logical (reported EOF) size in bytes — omitted if equal to physical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<u64>,
    /// "d" for directory, absent for file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<&'static str>,
}

/// Result of a completed scan — flat list of all nodes in BFS order.
pub struct ScanResult {
    pub nodes: Vec<FlatNode>,
}

/// Encode `Vec<FlatNode>` into a compact binary format for IPC transfer.
///
/// Binary layout per node (all little-endian):
///   id:        u32  (4)
///   parent_id: i32  (4) — -1 for root
///   size_hi:   u32  (4) — high 32 bits of physical size
///   size_lo:   u32  (4) — low  32 bits of physical size
///   flags:     u8   (1) — bit0=is_dir, bit1=has_logical
///   name_len:  u16  (2)
///   name:      [u8; name_len] — UTF-8
///   [if bit1]: logical_hi: u32, logical_lo: u32 — 8 bytes
///
/// Average ~34 bytes/node vs ~60 bytes/node for JSON.
pub fn encode_nodes(nodes: &[FlatNode]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(nodes.len() * 35);
    for node in nodes {
        buf.extend_from_slice(&node.id.to_le_bytes());
        buf.extend_from_slice(&(node.parent_id as i32).to_le_bytes());
        buf.extend_from_slice(&((node.s >> 32) as u32).to_le_bytes());
        buf.extend_from_slice(&(node.s as u32).to_le_bytes());
        let flags: u8 = (node.t.is_some() as u8) | ((node.l.is_some() as u8) << 1);
        buf.push(flags);
        let name_bytes = node.n.as_bytes();
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(name_bytes);
        if let Some(l) = node.l {
            buf.extend_from_slice(&((l >> 32) as u32).to_le_bytes());
            buf.extend_from_slice(&(l as u32).to_le_bytes());
        }
    }
    buf
}

/// Shared atomic counters for progress reporting.
pub struct ScanCounters {
    pub file_count: AtomicU64,
    pub byte_count: AtomicU64,
}

impl ScanCounters {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            file_count: AtomicU64::new(0),
            byte_count: AtomicU64::new(0),
        })
    }
}
