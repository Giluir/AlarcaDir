use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::*, DebouncedEvent, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Debug)]
pub struct FileChangeEvent {
    pub kind: String,
    pub path: String,
    pub size: u64,
}

pub struct WatcherState {
    // Keep the debouncer alive
    #[allow(dead_code)]
    debouncer: Option<Debouncer<RecommendedWatcher>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self { debouncer: None }
    }

    pub fn stop(&mut self) {
        self.debouncer = None;
    }

    pub fn start(&mut self, path: String, app: AppHandle) -> std::result::Result<(), String> {
        self.stop();

        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = new_debouncer(Duration::from_millis(1000), tx)
            .map_err(|e| e.to_string())?;

        debouncer
            .watcher()
            .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        self.debouncer = Some(debouncer);

        // Spawn a thread to receive debounced events and emit them
        std::thread::spawn(move || {
            while let Ok(res) = rx.recv() {
                match res {
                    Ok(events) => {
                        let mut changes = Vec::new();
                        for event in events {
                            let path_str = event.path.to_string_lossy().to_string();
                            let size = if let Ok(meta) = std::fs::metadata(&event.path) {
                                meta.len()
                            } else {
                                0
                            };

                            let kind = if event.path.exists() {
                                "Modify"
                            } else {
                                "Remove"
                            };

                            // PERFORMANCE OPTIMIZATION: Ignore events for files < 100KB
                            // This significantly reduces IPC and UI overhead from logging/lock files.
                            if size < 100 * 1024 && kind != "Remove" {
                                continue;
                            }

                            changes.push(FileChangeEvent {
                                kind: kind.to_string(),
                                path: path_str,
                                size,
                            });
                        }

                        if !changes.is_empty() {
                            let _ = app.emit("file-monitor-event", changes);
                        }
                    }
                    Err(e) => {
                        eprintln!("Watcher error: {:?}", e);
                    }
                }
            }
        });

        Ok(())
    }
}
