// scanner/basic.rs
// High-performance recursive directory scanner using NtQueryDirectoryFile.
//
// vs jwalk / std::fs::read_dir (FindFirstFileW):
//   1. NtQueryDirectoryFile bypasses Win32 and speaks directly to the FS driver.
//   2. 4 MB user-mode buffer fetches hundreds of entries per syscall instead of one.
//   3. AllocationSize is returned inline — no extra GetCompressedFileSize for most files.
//   4. rayon::scope provides parallel BFS without extra dependencies.
//
// On non-Windows we fall back to jwalk (non-production path).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use crate::scanner::types::{CancelFlag, FlatNode, ProgressReporter, ScanCounters, ScanResult};

// ─── public entry point ───────────────────────────────────────────────────────

pub fn scan(
    root_path: &str,
    cancel: &CancelFlag,
    progress: Option<&dyn ProgressReporter>,
    counters: &Arc<ScanCounters>,
) -> ScanResult {

    #[cfg(windows)]
    let nodes = win::scan_tree(root_path, cancel, progress, counters);

    #[cfg(not(windows))]
    let nodes = fallback_jwalk(root_path, cancel, progress, counters);

    ScanResult {
        nodes,
    }
}

// ─── Windows NT implementation ────────────────────────────────────────────────

#[cfg(windows)]
#[allow(dead_code)]
mod win {
    use super::*;
    use std::ffi::c_void;

    // ── NT constants ─────────────────────────────────────────────────────────

    const STATUS_SUCCESS: i32 = 0;
    const STATUS_NO_MORE_FILES: i32 = 0x80000006_u32 as i32;

    const FILE_LIST_DIRECTORY: u32 = 0x0000_0001;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const FILE_OPEN: u32 = 0x0000_0001;
    const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
    const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x0000_4000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;

    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x0000_0200;
    const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x0000_0800;

    // FileFullDirectoryInformation = 2
    const FILE_FULL_DIRECTORY_INFORMATION: u32 = 2;

    const BUFFER_SIZE: usize = 4 * 1024 * 1024; // 4 MB — same as C++
    const NT_PATH_PREFIX: &str = "\\??\\";

    // ── NT structures ────────────────────────────────────────────────────────

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        max_length: u16,
        _pad: u32,
        buffer: *mut u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        _pad0: u32,
        root_directory: *mut c_void,
        object_name: *const UnicodeString,
        attributes: u32,
        _pad1: u32,
        security_descriptor: *mut c_void,
        security_qos: *mut c_void,
    }

    #[repr(C)]
    union IoStatusUnion {
        status: i32,
        pointer: *mut c_void,
    }

    #[repr(C)]
    struct IoStatusBlock {
        u: IoStatusUnion,
        information: usize,
    }

    // FILE_FULL_DIR_INFORMATION — FileName immediately follows this header (at offset 68)
    #[repr(C)]
    struct FileFullDirInfo {
        next_entry_offset: u32,
        file_index: u32,
        creation_time: i64,
        last_access_time: i64,
        last_write_time: i64,
        change_time: i64,
        end_of_file: i64,       // logical size
        allocation_size: i64,   // physical (allocated) size
        file_attributes: u32,
        file_name_length: u32,  // bytes, not chars
        ea_size: u32,
        // FileName: [u16; N] follows here
    }

    // FileName starts at byte offset 68 within FILE_FULL_DIR_INFORMATION.
    // IMPORTANT: do NOT use std::mem::size_of::<FileFullDirInfo>() here!
    // Rust's #[repr(C)] adds 4 bytes of tail-padding to align the struct
    // size to the next multiple of 8 (i64 alignment), giving sizeof = 72.
    // But Windows places FileName at the true field boundary: 68, not 72.
    const FILENAME_OFFSET: usize = 68;

    // ── NT API declarations ───────────────────────────────────────────────────

    #[link(name = "ntdll")]
    extern "system" {
        fn NtOpenFile(
            file_handle: *mut *mut c_void,
            desired_access: u32,
            object_attributes: *const ObjectAttributes,
            io_status_block: *mut IoStatusBlock,
            share_access: u32,
            open_options: u32,
        ) -> i32;

        fn NtQueryDirectoryFile(
            file_handle: *mut c_void,
            event: *mut c_void,
            apc_routine: *mut c_void,
            apc_context: *mut c_void,
            io_status_block: *mut IoStatusBlock,
            file_information: *mut c_void,
            length: u32,
            file_information_class: u32,
            return_single_entry: u8,
            file_name: *const UnicodeString,
            restart_scan: u8,
        ) -> i32;

        fn NtClose(handle: *mut c_void) -> i32;
    }

    // ── Shared scan state ─────────────────────────────────────────────────────

    struct State<'a> {
        nodes: Mutex<Vec<FlatNode>>,
        next_id: AtomicU32,
        cancel: &'a CancelFlag,
        counters: &'a Arc<ScanCounters>,
        progress: Option<&'a dyn ProgressReporter>,
    }

    unsafe impl Send for State<'_> {}
    unsafe impl Sync for State<'_> {}

    // ── Volume cluster size helper ────────────────────────────────────────────

    fn get_cluster_size(root: &str) -> u64 {
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceW;
        // root e.g. "C:\" → wide string
        let drive = if root.len() >= 3 && &root[1..3] == ":\\" {
            root[..3].to_string()
        } else {
            root.to_string()
        };
        let wide: Vec<u16> = drive.encode_utf16().chain(std::iter::once(0)).collect();
        let mut spc = 0u32;
        let mut bps = 0u32;
        let mut _nfc = 0u32;
        let mut _tnc = 0u32;
        unsafe {
            if GetDiskFreeSpaceW(
                windows::core::PCWSTR(wide.as_ptr()),
                Some(&mut spc),
                Some(&mut bps),
                Some(&mut _nfc),
                Some(&mut _tnc),
            ).is_ok() {
                return spc as u64 * bps as u64;
            }
        }
        4096
    }

    // ── Open a directory with NtOpenFile ─────────────────────────────────────

    fn nt_open_dir(path: &str) -> Option<*mut c_void> {
        // Convert to NT namespace: "C:\foo" → "\??\C:\foo"
        let nt_path = if path.starts_with("\\\\") {
            format!("\\??\\UNC\\{}", &path[2..])
        } else {
            format!("{}{}", NT_PATH_PREFIX, path)
        };
        let mut wide: Vec<u16> = nt_path.encode_utf16().collect();
        let byte_len = (wide.len() * 2) as u16;
        let us = UnicodeString {
            length: byte_len,
            max_length: byte_len,
            _pad: 0,
            buffer: wide.as_mut_ptr(),
        };
        let oa = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            _pad0: 0,
            root_directory: std::ptr::null_mut(),
            object_name: &us,
            attributes: OBJ_CASE_INSENSITIVE,
            _pad1: 0,
            security_descriptor: std::ptr::null_mut(),
            security_qos: std::ptr::null_mut(),
        };
        let mut handle: *mut c_void = std::ptr::null_mut();
        let mut isb = IoStatusBlock { u: IoStatusUnion { status: 0 }, information: 0 };
        let status = unsafe {
            NtOpenFile(
                &mut handle,
                FILE_LIST_DIRECTORY | SYNCHRONIZE,
                &oa,
                &mut isb,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT,
            )
        };
        if status == STATUS_SUCCESS { Some(handle) } else { None }
    }

    // ── Enumerate one directory: returns (file nodes, subdir paths) ───────────

    struct DirEntry {
        name: String,
        is_dir: bool,
        is_reparse: bool,  // junction or symlink — do not recurse
        physical: u64,
        logical: u64,
    }

    fn nt_list_dir(handle: *mut c_void) -> Vec<DirEntry> {
        let mut buf: Vec<u64> = vec![0u64; BUFFER_SIZE / 8]; // 8-byte aligned
        let buf_ptr = buf.as_mut_ptr() as *mut c_void;
        let mut results = Vec::with_capacity(256);
        let mut restart = 1u8; // TRUE for first call

        loop {
            let mut isb = IoStatusBlock { u: IoStatusUnion { status: 0 }, information: 0 };
            let status = unsafe {
                NtQueryDirectoryFile(
                    handle,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut isb,
                    buf_ptr,
                    BUFFER_SIZE as u32,
                    FILE_FULL_DIRECTORY_INFORMATION,
                    0, // ReturnSingleEntry = FALSE
                    std::ptr::null(),
                    restart,
                )
            };
            restart = 0;

            if status == STATUS_NO_MORE_FILES {
                break;
            }
            if status != STATUS_SUCCESS {
                break;
            }

            // Walk the linked list of entries in the buffer
            let buf_base = buf.as_ptr() as *const u8;
            let mut offset = 0usize;
            let entries_before = results.len();
            loop {
                let entry_ptr = unsafe { buf_base.add(offset) as *const FileFullDirInfo };
                let entry = unsafe { &*entry_ptr };

                let name_len = entry.file_name_length as usize / 2; // chars
                let name_ptr = unsafe { buf_base.add(offset + FILENAME_OFFSET) as *const u16 };
                let name_slice = unsafe { std::slice::from_raw_parts(name_ptr, name_len) };
                let name = String::from_utf16_lossy(name_slice);

                if name != "." && name != ".." {
                    let attrs = entry.file_attributes;
                    let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
                    let is_reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;

                    // Always include the entry itself (as a leaf) but tag junctions
                    // so the caller can skip recursive descent into them.
                    let physical = if is_dir { 0 } else { entry.allocation_size.unsigned_abs() };
                    let logical  = if is_dir { 0 } else { entry.end_of_file.unsigned_abs() };
                    results.push(DirEntry { name, is_dir, is_reparse, physical, logical });
                }

                if entry.next_entry_offset == 0 {
                    break;
                }
                offset += entry.next_entry_offset as usize;
            }
        }
        results
    }

    // ── Recursive parallel scan using rayon::scope ────────────────────────────

    fn enumerate_dir<'scope>(
        scope: &rayon::Scope<'scope>,
        path: String,
        parent_id: u32,
        state: &'scope State<'scope>,
    ) {
        if state.cancel.load(Ordering::Relaxed) { return; }

        let handle = match nt_open_dir(&path) {
            Some(h) => h,
            None => return,
        };

        let entries = nt_list_dir(handle);
        unsafe { NtClose(handle); }

        let mut new_nodes = Vec::with_capacity(entries.len());
        let mut subdirs: Vec<(String, u32)> = Vec::new();

        for entry in entries {
            let id = state.next_id.fetch_add(1, Ordering::Relaxed);
            state.counters.byte_count.fetch_add(entry.physical, Ordering::Relaxed);
            if !entry.is_dir {
                state.counters.file_count.fetch_add(1, Ordering::Relaxed);
            }
            let l = if !entry.is_dir && entry.logical != entry.physical && entry.logical > 0 {
                Some(entry.logical)
            } else {
                None
            };
            new_nodes.push(FlatNode {
                id,
                parent_id: parent_id as i64,
                n: entry.name.clone(),
                s: entry.physical,
                l,
                t: if entry.is_dir { Some("d") } else { None },
            });
            if entry.is_dir && !entry.is_reparse {
                let sub = if path.ends_with('\\') {
                    format!("{}{}", path, entry.name)
                } else {
                    format!("{}\\{}", path, entry.name)
                };
                subdirs.push((sub, id));
            }
        }

        // Throttled progress
        {
            let fc = state.counters.file_count.load(Ordering::Relaxed);
            let bc = state.counters.byte_count.load(Ordering::Relaxed);
            if let Some(rep) = state.progress {
                if fc % 5000 < 256 { // approx every 5000 files
                    rep.report(fc, bc, &path);
                }
            }
        }

        // Insert nodes
        state.nodes.lock().unwrap().extend(new_nodes);

        // Recurse in parallel
        for (sub_path, sub_id) in subdirs {
            scope.spawn(move |scope| {
                enumerate_dir(scope, sub_path, sub_id, state);
            });
        }
    }

    // ── Top-level entry ───────────────────────────────────────────────────────

    pub fn scan_tree(
        root_path: &str,
        cancel: &CancelFlag,
        progress: Option<&dyn ProgressReporter>,
        counters: &Arc<ScanCounters>,
    ) -> Vec<FlatNode> {
        let root_id = 0u32;
        let root_node = FlatNode {
            id: root_id,
            parent_id: -1,
            n: root_path.to_string(),
            s: 0,
            l: None,
            t: Some("d"),
        };

        let state = State {
            nodes: Mutex::new(vec![root_node]),
            next_id: AtomicU32::new(1),
            cancel,
            counters,
            progress,
        };


        rayon::scope(|scope| {
            enumerate_dir(scope, root_path.to_string(), root_id, &state);
        });

        // Update root node with total byte count
        let mut nodes = state.nodes.into_inner().unwrap();
        let total = counters.byte_count.load(Ordering::Relaxed);
        if !nodes.is_empty() {
            nodes[0].s = total;
        }
        nodes
    }
}

// ─── Non-Windows fallback (jwalk) ─────────────────────────────────────────────

#[cfg(not(windows))]
fn fallback_jwalk(
    root_path: &str,
    cancel: &CancelFlag,
    progress: Option<&dyn ProgressReporter>,
    counters: &Arc<ScanCounters>,
) -> Vec<FlatNode> {
    use jwalk::{Parallelism, WalkDir};
    use std::os::unix::fs::MetadataExt;

    let mut nodes = vec![FlatNode {
        id: 0, parent_id: -1, n: root_path.to_string(), s: 0, l: None, t: Some("d"),
    }];
    let mut next_id = 1u32;
    let mut path_to_id = std::collections::HashMap::new();
    let root_pb = std::path::PathBuf::from(root_path);
    path_to_id.insert(root_pb.clone(), 0u32);

    let walker = WalkDir::new(root_path)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(Parallelism::RayonNewPool(rayon::current_num_threads()));

    let mut last_report = Instant::now();
    for entry_result in walker {
        if cancel.load(Ordering::Relaxed) { break; }
        let entry = match entry_result { Ok(e) => e, Err(_) => continue };
        let epath = entry.path();
        if epath == root_pb { continue; }
        let parent_path = match epath.parent() { Some(p) => p.to_path_buf(), None => continue };
        let parent_id = *path_to_id.get(&parent_path).unwrap_or(&0);
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let is_dir = meta.is_dir();
        let logical = meta.size();
        let physical = meta.blocks() * 512;
        counters.byte_count.fetch_add(physical, Ordering::Relaxed);
        if !is_dir { counters.file_count.fetch_add(1, Ordering::Relaxed); }
        let id = next_id; next_id += 1;
        if is_dir { path_to_id.insert(epath.to_path_buf(), id); }
        let l = if logical != physical { Some(logical) } else { None };
        nodes.push(FlatNode {
            id, parent_id: parent_id as i64,
            n: entry.file_name().to_string_lossy().into_owned(),
            s: physical, l, t: if is_dir { Some("d") } else { None },
        });
        if last_report.elapsed().as_millis() >= 100 {
            if let Some(rep) = progress {
                rep.report(counters.file_count.load(Ordering::Relaxed),
                           counters.byte_count.load(Ordering::Relaxed),
                           epath.to_str().unwrap_or(""));
            }
            last_report = Instant::now();
        }
    }
    nodes
}
