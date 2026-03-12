// scanner/basic.rs
// High-performance recursive directory scanner using NtQueryDirectoryFile.
//
// 1. NtQueryDirectoryFile bypasses Win32 and speaks directly to the FS driver.
// 2. 4 MB user-mode buffer (thread-local) fetches hundreds of entries per syscall.
// 3. AllocationSize is returned inline — no extra GetCompressedFileSize for most files.
// 4. rayon::scope provides parallel BFS without extra dependencies.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::ffi::c_void;

use crate::scanner::types::{CancelFlag, FlatNode, ProgressReporter, ScanCounters, ScanResult};

// ── NT constants ─────────────────────────────────────────────────────────────

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

// FileFullDirectoryInformation = 2
const FILE_FULL_DIRECTORY_INFORMATION: u32 = 2;

const BUFFER_SIZE: usize = 4 * 1024 * 1024; // 4 MB
const NT_PATH_PREFIX: &str = "\\??\\";

// ── NT structures ────────────────────────────────────────────────────────────

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

#[repr(C)]
struct FileFullDirInfo {
    next_entry_offset: u32,
    file_index: u32,
    creation_time: i64,
    last_access_time: i64,
    last_write_time: i64,
    change_time: i64,
    end_of_file: i64,
    allocation_size: i64,
    file_attributes: u32,
    file_name_length: u32,
    ea_size: u32,
}

const FILENAME_OFFSET: usize = 68;

// ── NT API declarations ───────────────────────────────────────────────────────

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

// ── Shared scan state ─────────────────────────────────────────────────────────

struct State<'a> {
    nodes: Mutex<Vec<FlatNode>>,
    next_id: AtomicU32,
    cancel: &'a CancelFlag,
    counters: &'a Arc<ScanCounters>,
    progress: Option<&'a dyn ProgressReporter>,
}

unsafe impl Send for State<'_> {}
unsafe impl Sync for State<'_> {}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn nt_open_dir(path: &str) -> Option<*mut c_void> {
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

struct DirEntry {
    name: String,
    is_dir: bool,
    is_reparse: bool,
    physical: u64,
    logical: u64,
}

thread_local! {
    static SCAN_BUFFER: std::cell::RefCell<Vec<u64>> = std::cell::RefCell::new(vec![0u64; BUFFER_SIZE / 8]);
}

fn nt_list_dir(handle: *mut c_void) -> Vec<DirEntry> {
    SCAN_BUFFER.with(|tls_buf| {
        let mut buf_ref = tls_buf.borrow_mut();
        let buf_ptr = buf_ref.as_mut_ptr() as *mut c_void;
        let mut results = Vec::with_capacity(256);
        let mut restart = 1u8;

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
                    0,
                    std::ptr::null(),
                    restart,
                )
            };
            restart = 0;

            if status != STATUS_SUCCESS {
                break;
            }

            let buf_base = buf_ref.as_ptr() as *const u8;
            let mut offset = 0usize;
            loop {
                let entry_ptr = unsafe { buf_base.add(offset) as *const FileFullDirInfo };
                let entry = unsafe { &*entry_ptr };

                let name_len = entry.file_name_length as usize / 2;
                let name_ptr = unsafe { buf_base.add(offset + FILENAME_OFFSET) as *const u16 };
                let name_slice = unsafe { std::slice::from_raw_parts(name_ptr, name_len) };
                let name = String::from_utf16_lossy(name_slice);

                if name != "." && name != ".." {
                    let attrs = entry.file_attributes;
                    let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
                    let is_reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;

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
    })
}

// ── Recursive parallel scan ──────────────────────────────────────────────────

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

    // Progress reporting
    {
        let fc = state.counters.file_count.load(Ordering::Relaxed);
        if let Some(rep) = state.progress {
            if fc % 5000 < 256 {
                let bc = state.counters.byte_count.load(Ordering::Relaxed);
                rep.report(fc, bc, &path);
            }
        }
    }

    state.nodes.lock().unwrap().extend(new_nodes);

    for (sub_path, sub_id) in subdirs {
        scope.spawn(move |scope| {
            enumerate_dir(scope, sub_path, sub_id, state);
        });
    }
}

// ── Public entry point ───────────────────────────────────────────────────────

pub fn scan(
    root_path: &str,
    cancel: &CancelFlag,
    progress: Option<&dyn ProgressReporter>,
    counters: &Arc<ScanCounters>,
) -> ScanResult {
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

    let mut nodes = state.nodes.into_inner().unwrap();
    let total = counters.byte_count.load(Ordering::Relaxed);
    if !nodes.is_empty() {
        nodes[0].s = total;
    }

    ScanResult { nodes }
}
