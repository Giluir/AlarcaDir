// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--export-sqlite" {
        let root_path = &args[2];
        let db_path = if args.len() >= 4 { &args[3] } else { "never_agent_test.db" };
        println!("[AlarcaDir Exporter] Starting MFT scan for: {} -> SQLite: {}", root_path, db_path);
        match alarcadir_lib::exporter::export_to_sqlite(root_path, db_path) {
            Ok(count) => {
                println!("[AlarcaDir Exporter] Successfully exported {} raw nodes to {}", count, db_path);
                std::process::exit(0);
            }
            Err(err) => {
                eprintln!("[AlarcaDir Exporter] Error: {}", err);
                std::process::exit(1);
            }
        }
    }

    alarcadir_lib::run();
}
