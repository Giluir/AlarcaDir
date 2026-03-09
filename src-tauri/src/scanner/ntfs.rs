// scanner/ntfs.rs
// NTFS MFT fast-path scanner.
//
// Algorithm (mirrors the C++ FinderNtfs logic):
//   1. Open the volume with FILE_READ_DATA.
//   2. FSCTL_GET_NTFS_VOLUME_DATA → get BytesPerCluster, BytesPerFileRecordSegment.
//   3. Open $MFT and FSCTL_GET_RETRIEVAL_POINTERS → MFT data runs (LCN extents).
//   4. Read each extent in 4MB aligned chunks, in PARALLEL (rayon).
//   5. For each FILE_RECORD: parse $STANDARD_INFORMATION, $FILE_NAME, $DATA, $REPARSE.
//   6. Build parent→children map (locked HashMap).
//   7. BFS from root (index 5) to produce flat FlatNode list.
//
// Requires: administrator privileges + NTFS volume.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::time::Instant;

use rayon::prelude::*;

use crate::scanner::types::{CancelFlag, FlatNode, ProgressReporter, ScanCounters, ScanResult};

// NTFS well-known MFT segment numbers
const MFT_ROOT_INDEX: u64 = 5;
const NTFS_RESERVED_MAX: u64 = 24;

// MFT record attribute type codes
const ATTR_STANDARD_INFORMATION: u32 = 0x10;
const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_DATA: u32 = 0x80;
const ATTR_REPARSE_POINT: u32 = 0xC0;
const ATTR_END: u32 = 0xFFFF_FFFF;

// Reparse tags (from winnt.h)
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
const IO_REPARSE_TAG_WOF: u32 = 0x8000_001E;

// Windows FILE_ATTRIBUTE constants
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;

// MFT record sector size for fixup calculation
const MFT_SECTOR_SIZE: usize = 512;

/// Record stored during MFT parsing (one per base file record).
#[derive(Default, Clone)]
struct MftRecord {
    attributes: u32,
    logical_size: u64,
    physical_size: u64,
    last_write: u64, // FILETIME as u64, reserved for future use
    reparse_tag: u32,
}

/// Child entry inside the parent→children map.
#[derive(Clone)]
struct ChildEntry {
    name: String,
    base_record: u64,
}

/// Shared state built during the parallel MFT pass.
struct MftState {
    records: Mutex<HashMap<u64, MftRecord>>,
    parent_to_children: Mutex<HashMap<u64, Vec<ChildEntry>>>,
}

impl MftState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            records: Mutex::new(HashMap::new()),
            parent_to_children: Mutex::new(HashMap::new()),
        })
    }
}

// ---------------------------------------------------------------------------
// Windows raw API helpers (inline to avoid linking to the `windows` crate
// system header types in a complicated way — we just use the raw FFI directly)
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod win {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetLogicalDriveStringsW, FILE_FLAG_NO_BUFFERING, FILE_FLAG_OVERLAPPED,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        FILE_READ_DATA, FILE_READ_ATTRIBUTES, SYNCHRONIZE,
        FILE_FLAG_OPEN_REPARSE_POINT,
    };
    use windows::Win32::System::IO::{DeviceIoControl, OVERLAPPED};
    use windows::Win32::System::Ioctl::{
        FSCTL_GET_NTFS_VOLUME_DATA, FSCTL_GET_RETRIEVAL_POINTERS,
        NTFS_VOLUME_DATA_BUFFER, RETRIEVAL_POINTERS_BUFFER,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};
    use windows::Win32::Foundation::{GetLastError, ERROR_MORE_DATA, WAIT_OBJECT_0};

    pub struct OwnedHandle(pub HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe { CloseHandle(self.0).ok(); }
            }
        }
    }
    impl OwnedHandle {
        pub fn _is_invalid(&self) -> bool { self.0.is_invalid() }
    }

    /// Open a volume (e.g. `\\.\C:`) for raw MFT reading.
    pub fn open_volume(volume_path: &[u16]) -> Option<OwnedHandle> {
        let h = unsafe {
            CreateFileW(
                PCWSTR(volume_path.as_ptr()),
                (FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE).0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_NO_BUFFERING | FILE_FLAG_OVERLAPPED,
                HANDLE::default(),
            )
        };
        match h {
            Ok(h) if !h.is_invalid() => Some(OwnedHandle(h)),
            _ => None,
        }
    }

    /// Open $MFT::$DATA to obtain retrieval pointers.
    pub fn open_mft(mft_path: &[u16]) -> Option<OwnedHandle> {
        let h = unsafe {
            CreateFileW(
                PCWSTR(mft_path.as_ptr()),
                FILE_READ_ATTRIBUTES.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                HANDLE::default(),
            )
        };
        match h {
            Ok(h) if !h.is_invalid() => Some(OwnedHandle(h)),
            _ => None,
        }
    }

    /// Returns `(BytesPerCluster, BytesPerFileRecordSegment)`.
    pub fn get_ntfs_volume_data(volume_handle: HANDLE) -> Option<(u64, u64)> {
        let mut data = NTFS_VOLUME_DATA_BUFFER::default();
        let mut returned = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                volume_handle,
                FSCTL_GET_NTFS_VOLUME_DATA,
                None, 0,
                Some(&mut data as *mut _ as *mut _),
                std::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>() as u32,
                Some(&mut returned),
                None,
            )
        };
        if ok.is_ok() {
            Some((data.BytesPerCluster as u64, data.BytesPerFileRecordSegment as u64))
        } else {
            None
        }
    }

    /// Returns list of `(lcn_start, cluster_count)` data runs for the MFT.
    pub fn get_retrieval_pointers(mft_handle: HANDLE) -> Option<Vec<(u64, u64)>> {
        let mut buf: Vec<u8> = vec![0u8; std::mem::size_of::<RETRIEVAL_POINTERS_BUFFER>() + 128 * 16];
        // STARTING_VCN_INPUT_BUFFER has a single i64 field (StartingVcn)
        let input_vcn: i64 = 0i64;
        let mut returned = 0u32;
        loop {
            let res = unsafe {
                DeviceIoControl(
                    mft_handle,
                    FSCTL_GET_RETRIEVAL_POINTERS,
                    Some(&input_vcn as *const _ as *const _),
                    std::mem::size_of::<i64>() as u32,
                    Some(buf.as_mut_ptr() as *mut _),
                    buf.len() as u32,
                    Some(&mut returned),
                    None,
                )
            };
            if res.is_ok() { break; }
            let err = unsafe { GetLastError() };
            if err == ERROR_MORE_DATA { buf.resize(buf.len() * 2, 0); continue; }
            return None;
        }
        let rp = unsafe { &*(buf.as_ptr() as *const RETRIEVAL_POINTERS_BUFFER) };
        let count = rp.ExtentCount as usize;
        // StartingVcn is an i64 (LARGE_INTEGER) stored at byte 0 of the buffer
        let starting_vcn = unsafe { *(buf.as_ptr() as *const i64) } as u64;
        let extents = unsafe {
            std::slice::from_raw_parts(rp.Extents.as_ptr(), count)
        };
        let mut runs = Vec::with_capacity(count);
        let mut prev_vcn = starting_vcn;
        for ext in extents {
            // Each extent: NextVcn (i64) + Lcn (i64)
            let lcn = ext.Lcn as u64;
            let next_vcn = ext.NextVcn as u64;
            runs.push((lcn, next_vcn.saturating_sub(prev_vcn)));
            prev_vcn = next_vcn;
        }
        Some(runs)
    }

    /// Read `len` bytes from `volume_handle` at byte offset `offset` into `buf`.
    /// Uses OVERLAPPED + event for compatibility with FILE_FLAG_NO_BUFFERING.
    pub fn read_at(volume_handle: HANDLE, buf: &mut [u8], offset: u64) -> bool {
        let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) };
        let event = match event {
            Ok(e) => e,
            Err(_) => return false,
        };
        let ov = OVERLAPPED {
            Anonymous: windows::Win32::System::IO::OVERLAPPED_0 {
                Anonymous: windows::Win32::System::IO::OVERLAPPED_0_0 {
                    Offset: (offset & 0xFFFF_FFFF) as u32,
                    OffsetHigh: (offset >> 32) as u32,
                },
            },
            hEvent: event,
            ..Default::default()
        };
        let mut bytes_read = 0u32;
        let ok = unsafe {
            windows::Win32::Storage::FileSystem::ReadFile(
                volume_handle,
                Some(buf),
                Some(&mut bytes_read),
                Some(&ov as *const _ as *mut _),
            )
        };
        if ok.is_err() {
            let err = unsafe { GetLastError() };
            use windows::Win32::Foundation::ERROR_IO_PENDING;
            if err != ERROR_IO_PENDING {
                unsafe { CloseHandle(event).ok(); }
                return false;
            }
            let wait = unsafe { WaitForSingleObject(event, INFINITE) };
            if wait != WAIT_OBJECT_0 {
                unsafe { CloseHandle(event).ok(); }
                return false;
            }
            let mut transferred = 0u32;
            let res = unsafe {
                windows::Win32::System::IO::GetOverlappedResult(
                    volume_handle, &ov, &mut transferred, false,
                )
            };
            unsafe { CloseHandle(event).ok(); }
            return res.is_ok();
        }
        unsafe { CloseHandle(event).ok(); }
        ok.is_ok()
    }

    /// Get all logical drive strings (e.g. "C:\", "D:\", ...).
    pub fn get_logical_drives() -> Vec<String> {
        let mut buf = vec![0u16; 256];
        let len = unsafe { GetLogicalDriveStringsW(Some(&mut buf)) } as usize;
        if len == 0 { return vec![]; }
        buf[..len].split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf16_lossy(s))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Record parsing helpers (platform-independent byte manipulation)
// ---------------------------------------------------------------------------

#[repr(C, packed)]
struct FileRecord {
    signature: u32,
    usa_offset: u16,
    usa_count: u16,
    lsn: u64,
    sequence_number: u16,
    link_count: u16,
    first_attribute_offset: u16,
    flags: u16,
    first_free_byte: u32,
    bytes_available: u32,
    base_file_record_raw: u64,
    next_attribute_number: u16,
    segment_number_high: u16,
    segment_number_low: u32,
}

impl FileRecord {
    fn is_valid(&self) -> bool {
        // 0x454C4946 = 'FILE'
        u32::from_le(self.signature) == 0x454C4946
    }
    fn is_in_use(&self) -> bool {
        u16::from_le(self.flags) & 0x0001 != 0
    }
    fn is_directory(&self) -> bool {
        u16::from_le(self.flags) & 0x0002 != 0
    }
    fn segment_number(&self) -> u64 {
        (u16::from_le(self.segment_number_high) as u64) << 32
            | u32::from_le(self.segment_number_low) as u64
    }
    fn base_file_record_number(&self) -> u64 {
        // Low 48 bits
        u64::from_le(self.base_file_record_raw) & 0x0000_FFFF_FFFF_FFFF
    }
}

#[repr(C, packed)]
struct AttributeRecord {
    type_code: u32,
    record_length: u32,
    form_code: u8,
    name_length: u8,
    name_offset: u16,
    flags: u16,
    instance: u16,
    // followed by either resident or non-resident form
}

impl AttributeRecord {
    fn is_non_resident(&self) -> bool {
        self.form_code & 0x01 != 0
    }
    fn is_compressed(&self) -> bool {
        u16::from_le(self.flags) & 0x0001 != 0
    }
    fn is_sparse(&self) -> bool {
        u16::from_le(self.flags) & 0x8000 != 0
    }
}

// Resident value offset is at byte 20 (after the AttributeRecord header).
const RESIDENT_VALUE_OFFSET_OFF: usize = 20;
const RESIDENT_VALUE_LENGTH_OFF: usize = 16;

// Non-resident offsets (relative to start of AttributeRecord):
const NR_LOWEST_VCN_OFF: usize = 16;
const NR_ALLOCATED_LENGTH_OFF: usize = 40;
const NR_FILE_SIZE_OFF: usize = 48;
const NR_COMPRESSED_OFF: usize = 64;

#[repr(C, packed)]
struct FileName {
    parent_directory: u64, // low 48 bits = parent MFT index
    _creation_time: i64,
    _last_modification_time: i64,
    _mft_change_time: i64,
    _last_access_time: i64,
    allocated_length: i64,
    file_size: i64,
    file_attributes: u32,
    _packed_ea_or_reparse: u32,
    file_name_length: u8,
    flags: u8,
    // followed by file_name_length UTF-16 code units
}

impl FileName {
    fn parent_mft_index(&self) -> u64 {
        u64::from_le(self.parent_directory) & 0x0000_FFFF_FFFF_FFFF
    }
    fn is_short_name(&self) -> bool {
        self.flags == 0x02
    }
}

#[repr(C, packed)]
struct StandardInformation {
    _creation_time: i64,
    _last_modification_time: i64,
    _mft_change_time: i64,
    _last_access_time: i64,
    file_attributes: u32,
}

unsafe fn read_u16_at(ptr: *const u8, off: usize) -> u16 {
    u16::from_le((ptr.add(off) as *const u16).read_unaligned())
}
unsafe fn read_u32_at(ptr: *const u8, off: usize) -> u32 {
    u32::from_le((ptr.add(off) as *const u32).read_unaligned())
}
unsafe fn read_u64_at(ptr: *const u8, off: usize) -> u64 {
    u64::from_le((ptr.add(off) as *const u64).read_unaligned())
}
unsafe fn read_i64_at(ptr: *const u8, off: usize) -> i64 {
    i64::from_le((ptr.add(off) as *const i64).read_unaligned())
}

/// Parse a single MFT chunk buffer and accumulate results into `state`.
fn process_mft_chunk(
    chunk: &[u8],
    record_size: usize,
    state: &MftState,
    counters: &Arc<ScanCounters>,
) -> Option<String> {
    let mut off = 0usize;
    let mut last_name = None;
    while off + record_size <= chunk.len() {
        let rec_buf = &chunk[off..off + record_size];
        off += record_size;

        // Safety: rec_buf is always record_size bytes, aligned via _aligned_malloc equivalent
        let rec = unsafe { &*(rec_buf.as_ptr() as *const FileRecord) };
        if !rec.is_valid() || !rec.is_in_use() {
            continue;
        }

        // Apply fixup array
        let usa_offset = u16::from_le(rec.usa_offset) as usize;
        let usa_count = u16::from_le(rec.usa_count) as usize;
        let _words_per_sector = MFT_SECTOR_SIZE / 2;

        let mut rec_copy: Vec<u8> = rec_buf.to_vec();
        if usa_offset + 2 * usa_count > record_size {
            continue;
        }
        let usn = unsafe { read_u16_at(rec_copy.as_ptr(), usa_offset) };
        let mut fixup_ok = true;
        for i in 1..usa_count {
            let sector_end_byte = i * MFT_SECTOR_SIZE - 2;
            if sector_end_byte + 2 > record_size { break; }
            let sector_end_val = unsafe { read_u16_at(rec_copy.as_ptr(), sector_end_byte) };
            if sector_end_val != usn {
                fixup_ok = false;
                break;
            }
            let fix = unsafe { read_u16_at(rec_copy.as_ptr(), usa_offset + i * 2) };
            rec_copy[sector_end_byte] = fix as u8;
            rec_copy[sector_end_byte + 1] = (fix >> 8) as u8;
        }
        if !fixup_ok { continue; }

        let rec = unsafe { &*(rec_copy.as_ptr() as *const FileRecord) };
        let current_idx = rec.segment_number();
        let base_idx = if rec.base_file_record_number() > 0 {
            rec.base_file_record_number()
        } else {
            current_idx
        };

        if current_idx == base_idx {
            counters.file_count.fetch_add(1, Ordering::Relaxed);
        }

        let first_attr_off = u16::from_le(rec.first_attribute_offset) as usize;
        if first_attr_off >= record_size { continue; }

        let is_dir = rec.is_directory();

        // Iterate over attributes
        let mut attr_off = first_attr_off;
        while attr_off + 8 <= record_size {
            let attr_ptr = unsafe { rec_copy.as_ptr().add(attr_off) };
            let type_code = unsafe { read_u32_at(attr_ptr, 0) };
            if type_code == ATTR_END { break; }
            let rec_len = unsafe { read_u32_at(attr_ptr, 4) } as usize;
            if rec_len == 0 || attr_off + rec_len > record_size { break; }

            let attr = unsafe { &*(attr_ptr as *const AttributeRecord) };
            let is_nr = attr.is_non_resident();

            match type_code {
                ATTR_STANDARD_INFORMATION if !is_nr => {
                    let val_off = unsafe { read_u16_at(attr_ptr, RESIDENT_VALUE_OFFSET_OFF) } as usize;
                    if attr_off + val_off + std::mem::size_of::<StandardInformation>() <= record_size {
                        let si = unsafe { &*(attr_ptr.add(val_off) as *const StandardInformation) };
                        let mut attrs = u32::from_le(si.file_attributes);
                        if is_dir { attrs |= FILE_ATTRIBUTE_DIRECTORY; }
                        if attrs == 0 { attrs = 1; } // FILE_ATTRIBUTE_NORMAL

                        let mut records = state.records.lock().unwrap();
                        let r = records.entry(base_idx).or_default();
                        r.attributes = attrs;
                    }
                }

                ATTR_FILE_NAME if !is_nr => {
                    let val_off = unsafe { read_u16_at(attr_ptr, RESIDENT_VALUE_OFFSET_OFF) } as usize;
                    if attr_off + val_off + std::mem::size_of::<FileName>() > record_size {
                        attr_off += rec_len;
                        continue;
                    }
                    let fn_ptr = unsafe { attr_ptr.add(val_off) as *const FileName };
                    let fn_hdr = unsafe { &*fn_ptr };

                    // Skip short name (DOS 8.3 alias) and . / ..
                    if fn_hdr.is_short_name() {
                        attr_off += rec_len;
                        continue;
                    }
                    let name_len = fn_hdr.file_name_length as usize;
                    let name_start = val_off + std::mem::size_of::<FileName>();
                    if attr_off + name_start + name_len * 2 > record_size {
                        attr_off += rec_len;
                        continue;
                    }
                    let name_u16 = unsafe {
                        std::slice::from_raw_parts(attr_ptr.add(name_start) as *const u16, name_len)
                    };
                    let name = String::from_utf16_lossy(name_u16);
                    if name == "." || name == ".." {
                        attr_off += rec_len;
                        continue;
                    }
                    if last_name.is_none() {
                        last_name = Some(name.clone());
                    }

                    let parent_idx = fn_hdr.parent_mft_index();

                    let mut ptc = state.parent_to_children.lock().unwrap();
                    ptc.entry(parent_idx).or_default().push(ChildEntry {
                        name,
                        base_record: base_idx,
                    });
                }

                ATTR_DATA => {
                    // Only process the default (unnamed) data stream, lowest VCN
                    let name_len = attr.name_length as usize;
                    if name_len > 0 {
                        // Named stream — check for WofCompressedData
                        let name_off = unsafe { read_u16_at(attr_ptr, 10) } as usize; // NameOffset is at byte 10
                        if name_len * 2 + name_off <= rec_len {
                            let stream_name_u16 = unsafe {
                                std::slice::from_raw_parts(attr_ptr.add(name_off) as *const u16, name_len)
                            };
                            let sn = String::from_utf16_lossy(stream_name_u16);
                            if sn == "WofCompressedData" && is_nr {
                                let alloc = unsafe { read_u64_at(attr_ptr, NR_ALLOCATED_LENGTH_OFF) };
                                let mut records = state.records.lock().unwrap();
                                let mut r = records.entry(base_idx).or_default();
                                let old_phys = r.physical_size;
                                r.physical_size = alloc;
                                if alloc > old_phys {
                                    counters.byte_count.fetch_add(alloc - old_phys, Ordering::Relaxed);
                                } else if old_phys > alloc {
                                    counters.byte_count.fetch_sub(old_phys - alloc, Ordering::Relaxed);
                                }
                            }
                        }
                        attr_off += rec_len;
                        continue;
                    }

                    let mut records = state.records.lock().unwrap();
                    let r = records.entry(base_idx).or_default();
                    if is_nr {
                        let lowest_vcn = unsafe { read_i64_at(attr_ptr, NR_LOWEST_VCN_OFF) };
                        if lowest_vcn != 0 { attr_off += rec_len; continue; }
                        r.logical_size = unsafe { read_u64_at(attr_ptr, NR_FILE_SIZE_OFF) };
                        let is_c = attr.is_compressed();
                        let is_s = attr.is_sparse();
                        let new_phys = if is_c || is_s {
                            unsafe { read_u64_at(attr_ptr, NR_COMPRESSED_OFF) }
                        } else {
                            unsafe { read_u64_at(attr_ptr, NR_ALLOCATED_LENGTH_OFF) }
                        };
                        let old_phys = r.physical_size;
                        r.physical_size = new_phys;
                        if new_phys > old_phys {
                            counters.byte_count.fetch_add(new_phys - old_phys, Ordering::Relaxed);
                        } else if old_phys > new_phys {
                            counters.byte_count.fetch_sub(old_phys - new_phys, Ordering::Relaxed);
                        }
                    } else {
                        let val_len = unsafe { read_u32_at(attr_ptr, RESIDENT_VALUE_LENGTH_OFF) } as u64;
                        r.logical_size = val_len;
                        let new_phys = (val_len + 7) & !7; // align to 8
                        let old_phys = r.physical_size;
                        r.physical_size = new_phys;
                        if new_phys > old_phys {
                            counters.byte_count.fetch_add(new_phys - old_phys, Ordering::Relaxed);
                        } else if old_phys > new_phys {
                            counters.byte_count.fetch_sub(old_phys - new_phys, Ordering::Relaxed);
                        }
                    }
                }

                ATTR_REPARSE_POINT if !is_nr => {
                    let val_off = unsafe { read_u16_at(attr_ptr, RESIDENT_VALUE_OFFSET_OFF) } as usize;
                    if attr_off + val_off + 4 <= record_size {
                        let tag = unsafe { read_u32_at(attr_ptr.add(val_off), 0) };
                        let mut records = state.records.lock().unwrap();
                        let r = records.entry(base_idx).or_default();
                        r.reparse_tag = tag;
                        if tag == IO_REPARSE_TAG_WOF {
                            r.attributes |= FILE_ATTRIBUTE_COMPRESSED;
                        }
                        // Treat mount points and junctions the same
                        if tag == IO_REPARSE_TAG_MOUNT_POINT {
                            r.reparse_tag = IO_REPARSE_TAG_MOUNT_POINT;
                        }
                    }
                }

                _ => {}
            }

            attr_off += rec_len;
        }
    }
    last_name
}

/// BFS from root to build the flat FlatNode list.
fn build_flat_nodes(
    state: &MftState,
    root_label: &str,
    cancel: &CancelFlag,
    counters: &Arc<ScanCounters>,
) -> Vec<FlatNode> {
    let records = state.records.lock().unwrap();
    let ptc = state.parent_to_children.lock().unwrap();

    let mut nodes: Vec<FlatNode> = Vec::with_capacity(records.len() + 1);
    let mut id_counter: u32 = 0;

    // Map from MFT index to node id
    let mut mft_to_id: HashMap<u64, u32> = HashMap::new();

    // Root node
    let root_id = id_counter;
    id_counter += 1;
    nodes.push(FlatNode {
        id: root_id,
        parent_id: -1,
        n: root_label.to_string(),
        s: 0,
        l: None,
        t: Some("d"),
    });
    mft_to_id.insert(MFT_ROOT_INDEX, root_id);

    // BFS queue of (mft_index, node_id)
    let mut queue = std::collections::VecDeque::new();
    queue.push_back((MFT_ROOT_INDEX, root_id));

    while let Some((mft_idx, parent_node_id)) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) { break; }

        let children = match ptc.get(&mft_idx) {
            Some(c) => c,
            None => continue,
        };

        for child in children {
            if child.base_record < NTFS_RESERVED_MAX { continue; }

            let rec = match records.get(&child.base_record) {
                Some(r) => r.clone(),
                None => continue,
            };

            let is_dir = rec.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
            let id = id_counter;
            id_counter += 1;

            counters.byte_count.fetch_add(rec.physical_size, Ordering::Relaxed);
            if !is_dir {
                counters.file_count.fetch_add(1, Ordering::Relaxed);
            }

            let l = if rec.logical_size != rec.physical_size && rec.logical_size > 0 {
                Some(rec.logical_size)
            } else {
                None
            };

            nodes.push(FlatNode {
                id,
                parent_id: parent_node_id as i64,
                n: child.name.clone(),
                s: rec.physical_size,
                l,
                t: if is_dir { Some("d") } else { None },
            });

            if is_dir {
                mft_to_id.insert(child.base_record, id);
                queue.push_back((child.base_record, id));
            }
        }
    }

    nodes
}

/// Attempt to run a fast NTFS MFT scan of `root_path`.
/// Returns `None` if unavailable (no admin rights, non-NTFS, etc.).
#[cfg(windows)]
pub fn scan(
    root_path: &str,
    cancel: &CancelFlag,
    progress: Option<&dyn ProgressReporter>,
    counters: &Arc<ScanCounters>,
) -> Option<ScanResult> {
    use windows::Win32::Foundation::HANDLE;

    // Normalise to volume path: "C:\" → "\\.\C:"
    let vol: String = {
        let trimmed = root_path.trim_end_matches(|c| c == '\\' || c == '/');
        if trimmed.len() == 2 && trimmed.chars().nth(1) == Some(':') {
            format!("\\\\.\\{}", trimmed)
        } else if trimmed.starts_with("\\\\") {
            format!("\\\\.\\{}", trimmed)
        } else {
            format!("\\\\.\\{}", trimmed)
        }
    };

    let vol_wide: Vec<u16> = vol.encode_utf16().chain(std::iter::once(0)).collect();
    let vol_handle = win::open_volume(&vol_wide)?;

    let (bytes_per_cluster, bytes_per_record) =
        win::get_ntfs_volume_data(vol_handle.0)?;
    if bytes_per_record == 0 { return None; }

    let record_size = bytes_per_record as usize;

    // Open $MFT
    let mft_path = format!("{}\\$MFT::$DATA", vol);
    let mft_wide: Vec<u16> = mft_path.encode_utf16().chain(std::iter::once(0)).collect();
    let mft_handle = win::open_mft(&mft_wide)?;

    let data_runs = win::get_retrieval_pointers(mft_handle.0)?;
    if data_runs.is_empty() { return None; }

    let state = MftState::new();

    // Process each data run in parallel (rayon)
    const CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4 MB

    // We need to share the volume handle safely across threads.
    // HANDLE wraps a *mut c_void; we store it as usize for Send+Sync.
    struct SendHandle(usize);
    unsafe impl Send for SendHandle {}
    unsafe impl Sync for SendHandle {}
    let raw_handle = SendHandle(vol_handle.0 .0 as usize);

    data_runs.par_iter().for_each(|&(lcn_start, cluster_count)| {
        let bytes_to_read = cluster_count * bytes_per_cluster;
        let mut file_offset = lcn_start * bytes_per_cluster;
        let mut remaining = bytes_to_read as usize;

        // Allocate aligned buffer (4MB, sector aligned)
        let mut buf = vec![0u8; CHUNK_SIZE];

        while remaining > 0 {
            if cancel.load(Ordering::Relaxed) { break; }

            let this_read = remaining.min(CHUNK_SIZE);
            // Round up to record boundary
            let this_read = ((this_read + record_size - 1) / record_size) * record_size;
            let this_read = this_read.min(buf.len());

            let h = HANDLE(raw_handle.0 as *mut _);
            if !win::read_at(h, &mut buf[..this_read], file_offset) {
                break;
            }

            let name_opt = process_mft_chunk(&buf[..this_read], record_size, &state, counters);

            if let Some(rep) = progress {
                // Minimal progress — use a rough file estimate
                let fc = counters.file_count.load(Ordering::Relaxed);
                let bc = counters.byte_count.load(Ordering::Relaxed);
                let path = if let Some(n) = name_opt {
                    format!("{} [MFT Reading]... \\{}", vol, n)
                } else {
                    format!("{} [MFT Reading]...", vol)
                };
                rep.report(fc, bc, &path);
            }

            file_offset += this_read as u64;
            remaining = remaining.saturating_sub(this_read);
        }
    });

    let nodes = build_flat_nodes(&state, root_path, cancel, counters);

    Some(ScanResult { nodes })
}

/// Stub for non-Windows builds.
#[cfg(not(windows))]
pub fn scan(
    _root_path: &str,
    _cancel: &CancelFlag,
    _progress: Option<&dyn ProgressReporter>,
    _counters: &Arc<ScanCounters>,
) -> Option<ScanResult> {
    None
}

/// Get available drive letters (Windows only).
#[cfg(windows)]
pub fn get_drives() -> Vec<String> {
    win::get_logical_drives()
}
#[cfg(not(windows))]
pub fn get_drives() -> Vec<String> {
    vec!["/".to_string()]
}
