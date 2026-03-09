// scanner/mod.rs
// Unified scan entry point: tries NTFS MFT fast-path, falls back to jwalk.

pub mod types;
pub mod ntfs;
pub mod basic;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

pub use types::{CancelFlag, FlatNode, ProgressReporter, ScanCounters, ScanResult};

/// Run a disk scan of `root_path`.
///
/// Strategy:
///   1. Attempt NTFS MFT fast-path (Windows, requires admin + NTFS).
///   2. If unavailable, fall back to parallel jwalk-based recursive scan.
pub fn scan_path(
    root_path: &str,
    cancel: CancelFlag,
    progress: Option<&dyn ProgressReporter>,
) -> ScanResult {
    let counters = ScanCounters::new();

    // Fast path: NTFS MFT
    if let Some(result) = ntfs::scan(root_path, &cancel, progress, &counters) {
        return result;
    }

    // Fallback: parallel recursive scan
    let result = basic::scan(root_path, &cancel, progress, &counters);
    result
}

/// Create a new cancellation token.
pub fn new_cancel_flag() -> CancelFlag {
    Arc::new(AtomicBool::new(false))
}

/// Get all available drives/volumes.
pub fn get_drives() -> Vec<String> {
    ntfs::get_drives()
}
