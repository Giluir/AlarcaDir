pub mod scanner;
pub mod watcher;

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use sha2::{Digest, Sha512};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use scanner::{CancelFlag, ProgressReporter};

// ─────────────────────────────────────────────────────────────────────────────
// Hash helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const PHASE1_LIMIT: u64 = 64 * 1024;

fn hash_file_limited(path: &str, limit: u64) -> Option<Vec<u8>> {
    let file = std::fs::File::open(path).ok()?;
    hash_reader(file, limit)
}

fn hash_reader(mut reader: impl Read, limit: u64) -> Option<Vec<u8>> {
    let mut hasher = Sha512::new();
    let mut buf = [0u8; 512 * 1024];
    let mut total_read = 0u64;
    loop {
        let remaining = limit.saturating_sub(total_read);
        if remaining == 0 { break; }
        let want = remaining.min(buf.len() as u64) as usize;
        let n = reader.read(&mut buf[..want]).ok()?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
        total_read += n as u64;
    }
    let full = hasher.finalize();
    Some(full[..16].to_vec())
}

fn bytes_to_hex(b: &[u8]) -> String {
    b.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn emit_progress(app: &AppHandle, phase: &str, done: usize, total: usize) {
    let _ = app.emit("dupe-progress", json!({ "phase": phase, "done": done, "total": total }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate detection (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Phase1Group {
    pub hash: String,
    pub bytes: u64,
    pub paths: Vec<String>,
}

#[derive(serde::Serialize)]
struct DuplicateGroup {
    original_hash: String,
    hash: String,
    bytes: u64,
    wasted: u64,
    paths: Vec<String>,
}

#[tauri::command]
async fn start_find_duplicates(
    candidates: HashMap<String, Vec<String>>,
    app: AppHandle,
) -> Result<Vec<Phase1Group>, String> {
    let groups: Vec<(u64, Vec<String>)> = candidates
        .into_iter()
        .filter_map(|(k, v)| k.parse::<u64>().ok().map(|sz| (sz, v)))
        .filter(|(_, v)| v.len() >= 2)
        .collect();

    let total: usize = groups.iter().map(|(_, v)| v.len()).sum();
    let done = Arc::new(AtomicUsize::new(0));

    emit_progress(&app, "phase1", 0, total);

    let app_cl = app.clone();
    let done_cl = done.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<Phase1Group> = groups
            .into_par_iter()
            .flat_map(|(size, paths)| {
                let hashed: Vec<(Vec<u8>, String)> = paths
                    .into_par_iter()
                    .filter_map(|p| {
                        let h = hash_file_limited(&p, PHASE1_LIMIT)?;
                        let n = done_cl.fetch_add(1, Ordering::Relaxed) + 1;
                        if n % 50 == 0 || n == total {
                            emit_progress(&app_cl, "phase1", n, total);
                        }
                        Some((h, p))
                    })
                    .collect();

                let mut by_hash: HashMap<Vec<u8>, Vec<String>> = HashMap::new();
                for (hash, path) in hashed {
                    by_hash.entry(hash).or_default().push(path);
                }

                by_hash.into_iter()
                    .filter(|(_, v)| v.len() >= 2)
                    .map(|(hash, paths)| Phase1Group {
                        hash: bytes_to_hex(&hash),
                        bytes: size,
                        paths,
                    })
                    .collect::<Vec<_>>()
            })
            .collect();

        out.sort_by(|a, b| {
            let wa = a.bytes * (a.paths.len() as u64 - 1);
            let wb = b.bytes * (b.paths.len() as u64 - 1);
            wb.cmp(&wa)
        });
        out
    })
    .await
    .map_err(|e| e.to_string())?;

    emit_progress(&app, "phase1", total, total);
    Ok(result)
}

#[tauri::command]
async fn verify_duplicates(
    groups: Vec<Phase1Group>,
    app: AppHandle,
) -> Result<Vec<DuplicateGroup>, String> {
    let total: usize = groups.iter().map(|g| g.paths.len()).sum();
    let done = Arc::new(AtomicUsize::new(0));

    emit_progress(&app, "phase2", 0, total);

    let app_cl = app.clone();
    let done_cl = done.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<DuplicateGroup> = groups
            .into_par_iter()
            .flat_map(|group| {
                let size = group.bytes;
                let orig_hash = group.hash.clone();
                let full: Vec<(Vec<u8>, String)> = group.paths
                    .into_par_iter()
                    .filter_map(|p| {
                        let h = hash_file_limited(&p, u64::MAX)?;
                        let n = done_cl.fetch_add(1, Ordering::Relaxed) + 1;
                        if n % 20 == 0 || n == total {
                            emit_progress(&app_cl, "phase2", n, total);
                        }
                        Some((h, p))
                    })
                    .collect();

                let mut by_hash: HashMap<Vec<u8>, Vec<String>> = HashMap::new();
                for (hash, path) in full {
                    by_hash.entry(hash).or_default().push(path);
                }

                by_hash.into_iter()
                    .filter(|(_, v)| v.len() >= 2)
                    .map(|(hash, paths)| {
                        let wasted = size * (paths.len() as u64 - 1);
                        DuplicateGroup {
                            original_hash: orig_hash.clone(),
                            hash: bytes_to_hex(&hash),
                            bytes: size,
                            wasted,
                            paths,
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .collect();

        out.sort_by(|a, b| b.wasted.cmp(&a.wasted));
        out
    })
    .await
    .map_err(|e| e.to_string())?;

    emit_progress(&app, "phase2", total, total);
    Ok(result)
}

// ─────────────────────────────────────────────────────────────────────────────
// App state — native Rust scanner (no DLL)
// ─────────────────────────────────────────────────────────────────────────────

struct AppState {
    /// Current in-flight scan cancel token (None = idle).
    current_cancel: Mutex<Option<CancelFlag>>,
    watcher: Mutex<watcher::WatcherState>,
}

/// Progress reporter that emits Tauri events to the frontend.
/// Throttled to at most once per 250 ms to avoid flooding the IPC queue.
struct TauriReporter {
    app: AppHandle,
    /// Guards last-emit timestamp for rate limiting.
    last_report: Mutex<Instant>,
}

impl ProgressReporter for TauriReporter {
    fn report(&self, files: u64, bytes: u64, path: &str) {
        let mut last = self.last_report.lock().unwrap();
        if last.elapsed() >= Duration::from_millis(250) {
            let _ = self.app.emit("scan-progress", serde_json::json!({
                "files": files,
                "bytes": bytes,
                "path": path,
            }));
            *last = Instant::now();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_drives() -> Result<Vec<String>, String> {
    Ok(scanner::get_drives())
}

/// Start a scan and return raw binary-encoded node list.
/// Using `tauri::ipc::Response` ensures true binary transfer (no JSON overhead).
#[tauri::command]
async fn start_scan(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    // Prevent concurrent scans
    {
        let lock = state.current_cancel.lock().unwrap();
        if lock.is_some() {
            return Err("Already scanning".into());
        }
    }

    let cancel = scanner::new_cancel_flag();
    *state.current_cancel.lock().unwrap() = Some(cancel.clone());

    let reporter = TauriReporter { app: app.clone(), last_report: Mutex::new(Instant::now()) };
    let path_clone = path.clone();
    let cancel_clone = cancel.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        scanner::scan_path(&path_clone, cancel_clone, Some(&reporter))
    })
    .await
    .map_err(|e| e.to_string())?;

    *state.current_cancel.lock().unwrap() = None;

    // Start watcher for this path
    if let Err(e) = state.watcher.lock().unwrap().start(path, app) {
        eprintln!("Failed to start watcher: {}", e);
    }

    // Encode as compact binary
    let bytes = scanner::types::encode_nodes(&result.nodes);
    
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    if let Some(cancel) = state.current_cancel.lock().unwrap().as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
    state.watcher.lock().unwrap().stop();
}

#[tauri::command]
fn open_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let p = std::path::Path::new(&path);
        let mut cmd = std::process::Command::new("explorer");
        if p.is_file() {
            cmd.arg("/select,");
            cmd.arg(&path);
        } else {
            cmd.arg(&path);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(AppState {
                current_cancel: Mutex::new(None),
                watcher: Mutex::new(watcher::WatcherState::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_drives,
            start_scan,
            cancel_scan,
            open_explorer,
            start_find_duplicates,
            verify_duplicates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
