// scanner/exporter.rs
// Direct high-performance export of AlarcaDir scan results into SQLite raw_tree_nodes database.

use std::time::SystemTime;
use rusqlite::{params, Connection};

use crate::scanner;

/// Scans `root_path` using AlarcaDir fast MFT/fallback scanner, and exports
/// the raw tree hierarchy directly into SQLite database at `db_path`.
pub fn export_to_sqlite(root_path: &str, db_path: &str) -> Result<usize, String> {
    let cancel = scanner::new_cancel_flag();
    let scan_res = scanner::scan_path(root_path, cancel, None);
    let nodes = scan_res.nodes;

    if nodes.is_empty() {
        return Ok(0);
    }

    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS raw_tree_nodes (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_path TEXT,
            is_dir BOOLEAN NOT NULL,
            size INTEGER NOT NULL,
            created_at INTEGER,
            modified_at INTEGER,
            mft_id INTEGER
        );",
        [],
    )
    .map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut full_paths: Vec<String> = Vec::with_capacity(nodes.len());
    let now_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT OR REPLACE INTO raw_tree_nodes 
                (path, name, parent_path, is_dir, size, created_at, modified_at, mft_id)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;

        for node in nodes.iter() {
            let is_dir = node.t.is_some();
            let path = if node.parent_id < 0 {
                root_path.to_string()
            } else {
                let parent_idx = node.parent_id as usize;
                if parent_idx < full_paths.len() {
                    let parent_p = &full_paths[parent_idx];
                    if parent_p.ends_with('\\') || parent_p.ends_with('/') {
                        format!("{}{}", parent_p, node.n)
                    } else {
                        format!("{}\\{}", parent_p, node.n)
                    }
                } else {
                    format!("{}\\{}", root_path, node.n)
                }
            };

            let parent_p = if node.parent_id < 0 {
                String::new()
            } else {
                let parent_idx = node.parent_id as usize;
                if parent_idx < full_paths.len() {
                    full_paths[parent_idx].clone()
                } else {
                    root_path.to_string()
                }
            };

            stmt.execute(params![
                path,
                node.n,
                parent_p,
                is_dir,
                node.s as i64,
                now_ts,
                now_ts,
                node.id as i64
            ])
            .map_err(|e| e.to_string())?;

            full_paths.push(path);
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(nodes.len())
}
