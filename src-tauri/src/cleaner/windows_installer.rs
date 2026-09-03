use std::collections::HashSet;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, HMODULE, HWND, MAX_PATH};
use windows::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_NORMAL};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT,
    HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, REG_SZ,
};
use windows::Win32::UI::Shell::{
    SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW,
};

use super::plugin::{
    CleanAction, CleanExecutionResult, CleanItem, CleanItemResult, CleanRecommendation,
    CleanerPlugin, CleanerPluginInfo, CleanerScanResult,
};

pub struct WindowsInstallerCleaner;

impl Default for WindowsInstallerCleaner {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowsInstallerCleaner {
    pub fn new() -> Self {
        Self
    }

    /// Retrieve the standard Windows Installer directory (typically C:\Windows\Installer)
    fn get_installer_dir() -> PathBuf {
        if let Ok(windir) = std::env::var("WINDIR") {
            let mut p = PathBuf::from(windir);
            p.push("Installer");
            if p.exists() {
                return p;
            }
        }
        PathBuf::from("C:\\Windows\\Installer")
    }

    /// Gather all registered LocalPackage paths from Windows Registry
    fn gather_registry_whitelist() -> HashSet<String> {
        let mut whitelist = HashSet::new();

        // 1. Traverse HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData
        // SAFETY: Opening HKLM with 64-bit view read access is standard and safe.
        unsafe {
            let mut h_userdata = HKEY::default();
            let status = RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\UserData"),
                0,
                KEY_READ | KEY_WOW64_64KEY,
                &mut h_userdata,
            );

            if status == ERROR_SUCCESS && !h_userdata.is_invalid() {
                // Enumerate all SID subkeys (S-1-5-18, user SIDs, etc.)
                let sids = Self::enum_subkeys(h_userdata);
                for sid in sids {
                    let sid_w: Vec<u16> = sid.encode_utf16().chain(std::iter::once(0)).collect();
                    let mut h_sid = HKEY::default();
                    if RegOpenKeyExW(
                        h_userdata,
                        PCWSTR::from_raw(sid_w.as_ptr()),
                        0,
                        KEY_READ | KEY_WOW64_64KEY,
                        &mut h_sid,
                    ) == ERROR_SUCCESS
                        && !h_sid.is_invalid()
                    {
                        // Scan both "Products" and "Patches" under each SID
                        for sub_hive in &[w!("Products"), w!("Patches")] {
                            let mut h_sub = HKEY::default();
                            if RegOpenKeyExW(
                                h_sid,
                                *sub_hive,
                                0,
                                KEY_READ | KEY_WOW64_64KEY,
                                &mut h_sub,
                            ) == ERROR_SUCCESS
                                && !h_sub.is_invalid()
                            {
                                let guid_keys = Self::enum_subkeys(h_sub);
                                for guid_key in guid_keys {
                                    let mut install_props_path = guid_key.clone();
                                    install_props_path.push_str("\\InstallProperties");
                                    let prop_w: Vec<u16> = install_props_path
                                        .encode_utf16()
                                        .chain(std::iter::once(0))
                                        .collect();

                                    let mut h_props = HKEY::default();
                                    if RegOpenKeyExW(
                                        h_sub,
                                        PCWSTR::from_raw(prop_w.as_ptr()),
                                        0,
                                        KEY_READ | KEY_WOW64_64KEY,
                                        &mut h_props,
                                    ) == ERROR_SUCCESS
                                        && !h_props.is_invalid()
                                    {
                                        if let Some(pkg) =
                                            Self::query_string_value(h_props, w!("LocalPackage"))
                                        {
                                            if !pkg.trim().is_empty() {
                                                whitelist.insert(Self::normalize_path(&pkg));
                                            }
                                        }
                                        let _ = RegCloseKey(h_props);
                                    }
                                }
                                let _ = RegCloseKey(h_sub);
                            }
                        }
                        let _ = RegCloseKey(h_sid);
                    }
                }
                let _ = RegCloseKey(h_userdata);
            }
        }

        // 2. Cross-check HKCR\Installer\Products and HKCR\Installer\Patches
        unsafe {
            for root_sub in &[w!("Installer\\Products"), w!("Installer\\Patches")] {
                let mut h_root = HKEY::default();
                if RegOpenKeyExW(
                    HKEY_CLASSES_ROOT,
                    *root_sub,
                    0,
                    KEY_READ | KEY_WOW64_64KEY,
                    &mut h_root,
                ) == ERROR_SUCCESS
                    && !h_root.is_invalid()
                {
                    let items = Self::enum_subkeys(h_root);
                    for itm in items {
                        let itm_w: Vec<u16> =
                            itm.encode_utf16().chain(std::iter::once(0)).collect();
                        let mut h_itm = HKEY::default();
                        if RegOpenKeyExW(
                            h_root,
                            PCWSTR::from_raw(itm_w.as_ptr()),
                            0,
                            KEY_READ | KEY_WOW64_64KEY,
                            &mut h_itm,
                        ) == ERROR_SUCCESS
                            && !h_itm.is_invalid()
                        {
                            if let Some(pkg) = Self::query_string_value(h_itm, w!("LocalPackage")) {
                                if !pkg.trim().is_empty() {
                                    whitelist.insert(Self::normalize_path(&pkg));
                                }
                            }
                            let _ = RegCloseKey(h_itm);
                        }
                    }
                    let _ = RegCloseKey(h_root);
                }
            }
        }

        whitelist
    }

    /// Gather all registered LocalPackage paths from Win32 MSI API (MsiEnumProductsEx, MsiEnumPatchesEx)
    fn gather_msi_api_whitelist() -> HashSet<String> {
        let mut whitelist = HashSet::new();

        // Dynamically load msi.dll
        unsafe {
            let h_msi: HMODULE = match LoadLibraryW(w!("msi.dll")) {
                Ok(m) => m,
                Err(_) => return whitelist,
            };

            type MsiEnumProductsExFn = unsafe extern "system" fn(
                PCWSTR,
                PCWSTR,
                u32,
                u32,
                PWSTR,
                *mut u32,
                PWSTR,
                *mut u32,
            ) -> u32;

            type MsiGetProductInfoExFn =
                unsafe extern "system" fn(PCWSTR, PCWSTR, u32, PCWSTR, PWSTR, *mut u32) -> u32;

            type MsiEnumPatchesExFn = unsafe extern "system" fn(
                PCWSTR,
                PCWSTR,
                u32,
                u32,
                u32,
                PWSTR,
                PWSTR,
                *mut u32,
                PWSTR,
                *mut u32,
            ) -> u32;

            type MsiGetPatchInfoExFn = unsafe extern "system" fn(
                PCWSTR,
                PCWSTR,
                PCWSTR,
                u32,
                PCWSTR,
                PWSTR,
                *mut u32,
            ) -> u32;

            let p_enum_prods: Option<MsiEnumProductsExFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiEnumProductsExW"))
                    .map(|p| std::mem::transmute(p));
            let p_get_prod_info: Option<MsiGetProductInfoExFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiGetProductInfoExW"))
                    .map(|p| std::mem::transmute(p));
            let p_enum_patches: Option<MsiEnumPatchesExFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiEnumPatchesExW"))
                    .map(|p| std::mem::transmute(p));
            let p_get_patch_info: Option<MsiGetPatchInfoExFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiGetPatchInfoExW"))
                    .map(|p| std::mem::transmute(p));

            const MSIINSTALLCONTEXT_ALL: u32 = 7; // USERMANAGED (1) | USERUNMANAGED (2) | MACHINE (4)

            // 1. Enumerate all Products
            if let (Some(enum_prods), Some(get_prod_info)) = (p_enum_prods, p_get_prod_info) {
                let mut index = 0u32;
                loop {
                    let mut prod_code = [0u16; 39];
                    let mut installed_context = 0u32;
                    let mut sid_buf = [0u16; 128];
                    let mut sid_len = sid_buf.len() as u32;

                    let ret = enum_prods(
                        PCWSTR::null(),
                        PCWSTR::null(),
                        MSIINSTALLCONTEXT_ALL,
                        index,
                        PWSTR::from_raw(prod_code.as_mut_ptr()),
                        &mut installed_context,
                        PWSTR::from_raw(sid_buf.as_mut_ptr()),
                        &mut sid_len,
                    );

                    if ret != 0 {
                        break; // ERROR_NO_MORE_ITEMS (259) or error
                    }

                    // Query LocalPackage for this product
                    let mut val_buf = [0u16; MAX_PATH as usize * 2];
                    let mut val_len = val_buf.len() as u32;
                    let info_ret = get_prod_info(
                        PCWSTR::from_raw(prod_code.as_ptr()),
                        PCWSTR::from_raw(sid_buf.as_ptr()),
                        installed_context,
                        w!("LocalPackage"),
                        PWSTR::from_raw(val_buf.as_mut_ptr()),
                        &mut val_len,
                    );

                    if info_ret == 0 && val_len > 0 {
                        let path_str = String::from_utf16_lossy(&val_buf[..val_len as usize]);
                        if !path_str.trim().is_empty() {
                            whitelist.insert(Self::normalize_path(&path_str));
                        }
                    }

                    index += 1;
                }
            }

            // 2. Enumerate all Patches
            if let (Some(enum_patches), Some(get_patch_info)) = (p_enum_patches, p_get_patch_info) {
                let mut index = 0u32;
                loop {
                    let mut patch_code = [0u16; 39];
                    let mut target_prod_code = [0u16; 39];
                    let mut target_context = 0u32;
                    let mut target_sid = [0u16; 128];
                    let mut target_sid_len = target_sid.len() as u32;

                    let ret = enum_patches(
                        PCWSTR::null(),
                        PCWSTR::null(),
                        MSIINSTALLCONTEXT_ALL,
                        1, // MSIFILTER_NONE = 1
                        index,
                        PWSTR::from_raw(patch_code.as_mut_ptr()),
                        PWSTR::from_raw(target_prod_code.as_mut_ptr()),
                        &mut target_context,
                        PWSTR::from_raw(target_sid.as_mut_ptr()),
                        &mut target_sid_len,
                    );

                    if ret != 0 {
                        break;
                    }

                    let mut val_buf = [0u16; MAX_PATH as usize * 2];
                    let mut val_len = val_buf.len() as u32;
                    let info_ret = get_patch_info(
                        PCWSTR::from_raw(patch_code.as_ptr()),
                        PCWSTR::from_raw(target_prod_code.as_ptr()),
                        PCWSTR::from_raw(target_sid.as_ptr()),
                        target_context,
                        w!("LocalPackage"),
                        PWSTR::from_raw(val_buf.as_mut_ptr()),
                        &mut val_len,
                    );

                    if info_ret == 0 && val_len > 0 {
                        let path_str = String::from_utf16_lossy(&val_buf[..val_len as usize]);
                        if !path_str.trim().is_empty() {
                            whitelist.insert(Self::normalize_path(&path_str));
                        }
                    }

                    index += 1;
                }
            }
        }

        whitelist
    }

    /// Extract OLE SummaryInformation metadata from candidate MSI/MSP files
    fn extract_msi_metadata(
        file_path: &Path,
    ) -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        let mut subject = None;
        let mut author = None;
        let mut comments = None;
        let mut pkg_code = None;

        let path_w: Vec<u16> = file_path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let h_msi = match LoadLibraryW(w!("msi.dll")) {
                Ok(m) => m,
                Err(_) => return (subject, author, comments, pkg_code),
            };

            type MsiOpenDatabaseWFn = unsafe extern "system" fn(PCWSTR, PCWSTR, *mut usize) -> u32;
            type MsiGetSummaryInformationWFn =
                unsafe extern "system" fn(usize, PCWSTR, u32, *mut usize) -> u32;
            type MsiSummaryInfoGetPropertyWFn = unsafe extern "system" fn(
                usize,
                u32,
                *mut u32,
                *mut i32,
                *mut c_void,
                PWSTR,
                *mut u32,
            ) -> u32;
            type MsiCloseHandleFn = unsafe extern "system" fn(usize) -> u32;

            let p_open_db: Option<MsiOpenDatabaseWFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiOpenDatabaseW"))
                    .map(|p| std::mem::transmute(p));
            let p_get_sum: Option<MsiGetSummaryInformationWFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiGetSummaryInformationW"))
                    .map(|p| std::mem::transmute(p));
            let p_get_prop: Option<MsiSummaryInfoGetPropertyWFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiSummaryInfoGetPropertyW"))
                    .map(|p| std::mem::transmute(p));
            let p_close_handle: Option<MsiCloseHandleFn> =
                GetProcAddress(h_msi, windows::core::s!("MsiCloseHandle"))
                    .map(|p| std::mem::transmute(p));

            if let (Some(open_db), Some(get_sum), Some(get_prop), Some(close_handle)) =
                (p_open_db, p_get_sum, p_get_prop, p_close_handle)
            {
                let mut h_db = 0usize;
                // MSIDBOPEN_READONLY = (LPCTSTR)0
                if open_db(PCWSTR::from_raw(path_w.as_ptr()), PCWSTR::null(), &mut h_db) == 0 {
                    let mut h_sum = 0usize;
                    if get_sum(h_db, PCWSTR::null(), 0, &mut h_sum) == 0 {
                        let read_str_prop = |pid: u32| -> Option<String> {
                            let mut data_type = 0u32;
                            let mut int_val = 0i32;
                            let mut buf = [0u16; 512];
                            let mut buf_len = buf.len() as u32;
                            if get_prop(
                                h_sum,
                                pid,
                                &mut data_type,
                                &mut int_val,
                                std::ptr::null_mut(),
                                PWSTR::from_raw(buf.as_mut_ptr()),
                                &mut buf_len,
                            ) == 0
                                && buf_len > 0
                            {
                                Some(String::from_utf16_lossy(&buf[..buf_len as usize]))
                            } else {
                                None
                            }
                        };

                        // PID_SUBJECT = 3, PID_AUTHOR = 4, PID_COMMENTS = 6, PID_REVNUMBER = 9 (PackageCode)
                        subject = read_str_prop(3);
                        author = read_str_prop(4);
                        comments = read_str_prop(6);
                        pkg_code = read_str_prop(9);

                        close_handle(h_sum);
                    }
                    close_handle(h_db);
                }
            }
        }

        (subject, author, comments, pkg_code)
    }

    /// Check if package code is referenced in the system Uninstall registry
    fn check_in_uninstall_registry(pkg_code: Option<&str>, product_name: Option<&str>) -> bool {
        let targets = [
            (
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
            ),
            (
                HKEY_LOCAL_MACHINE,
                w!("SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
            ),
        ];

        for (hive, sub) in targets {
            unsafe {
                let mut h_uninstall = HKEY::default();
                if RegOpenKeyExW(hive, sub, 0, KEY_READ | KEY_WOW64_64KEY, &mut h_uninstall)
                    == ERROR_SUCCESS
                    && !h_uninstall.is_invalid()
                {
                    let subkeys = Self::enum_subkeys(h_uninstall);
                    for k in subkeys {
                        if let Some(pc) = pkg_code {
                            if !pc.is_empty() && k.eq_ignore_ascii_case(pc) {
                                let _ = RegCloseKey(h_uninstall);
                                return true;
                            }
                        }
                        if let Some(pn) = product_name {
                            let k_w: Vec<u16> =
                                k.encode_utf16().chain(std::iter::once(0)).collect();
                            let mut h_sub = HKEY::default();
                            if RegOpenKeyExW(
                                h_uninstall,
                                PCWSTR::from_raw(k_w.as_ptr()),
                                0,
                                KEY_READ | KEY_WOW64_64KEY,
                                &mut h_sub,
                            ) == ERROR_SUCCESS
                                && !h_sub.is_invalid()
                            {
                                if let Some(disp_name) =
                                    Self::query_string_value(h_sub, w!("DisplayName"))
                                {
                                    if !disp_name.is_empty() && disp_name.eq_ignore_ascii_case(pn) {
                                        let _ = RegCloseKey(h_sub);
                                        let _ = RegCloseKey(h_uninstall);
                                        return true;
                                    }
                                }
                                let _ = RegCloseKey(h_sub);
                            }
                        }
                    }
                    let _ = RegCloseKey(h_uninstall);
                }
            }
        }

        false
    }

    // Helper: Enumerate subkeys for a given registry HKEY
    fn enum_subkeys(hkey: HKEY) -> Vec<String> {
        let mut subkeys = Vec::new();
        let mut index = 0u32;
        let mut name_buf = [0u16; 256];

        loop {
            let mut name_len = name_buf.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    hkey,
                    index,
                    PWSTR::from_raw(name_buf.as_mut_ptr()),
                    &mut name_len,
                    None,
                    PWSTR::null(),
                    None,
                    None,
                )
            };

            if status != ERROR_SUCCESS {
                break;
            }

            let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            subkeys.push(name);
            index += 1;
        }

        subkeys
    }

    // Helper: Query string value (REG_SZ) from a registry HKEY
    fn query_string_value(hkey: HKEY, val_name: PCWSTR) -> Option<String> {
        let mut val_type = REG_SZ;
        let mut byte_len = 0u32;

        unsafe {
            // First pass: get required size
            if RegQueryValueExW(
                hkey,
                val_name,
                None,
                Some(&mut val_type),
                None,
                Some(&mut byte_len),
            ) != ERROR_SUCCESS
                || byte_len == 0
            {
                return None;
            }

            let u16_len = (byte_len as usize).div_ceil(2);
            let mut buf = vec![0u16; u16_len];

            if RegQueryValueExW(
                hkey,
                val_name,
                None,
                Some(&mut val_type),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut byte_len),
            ) == ERROR_SUCCESS
            {
                let actual_u16_len = (byte_len as usize) / 2;
                let trimmed = if actual_u16_len > 0 && buf[actual_u16_len - 1] == 0 {
                    &buf[..actual_u16_len - 1]
                } else {
                    &buf[..actual_u16_len]
                };
                Some(String::from_utf16_lossy(trimmed))
            } else {
                None
            }
        }
    }

    // Normalize path to lowercase standard Windows path for hash comparison
    fn normalize_path(p: &str) -> String {
        p.replace('/', "\\").trim().to_lowercase()
    }
}

impl CleanerPlugin for WindowsInstallerCleaner {
    fn info(&self) -> CleanerPluginInfo {
        CleanerPluginInfo {
            id: "windows_installer".to_string(),
            name: "Windows Installer 冗余缓存".to_string(),
            description: "扫描 C:\\Windows\\Installer 目录中已被版本升级或卸载遗留的孤立 .msi 与 .msp 安装包文件。支持安全隔离、重命名与彻底删除。".to_string(),
            category: "系统更新与安装".to_string(),
            requires_admin: true,
        }
    }

    fn scan(&self) -> Result<CleanerScanResult, String> {
        let installer_dir = Self::get_installer_dir();
        if !installer_dir.exists() {
            return Err(format!("Installer 目录不存在: {}", installer_dir.display()));
        }

        // 1. Build combined whitelist (Registry + MSI API)
        let mut whitelist = Self::gather_registry_whitelist();
        let api_whitelist = Self::gather_msi_api_whitelist();
        whitelist.extend(api_whitelist);

        // 2. Scan physical files in Installer directory
        let entries = std::fs::read_dir(&installer_dir)
            .map_err(|e| format!("读取 Installer 目录失败: {}", e))?;

        let mut items = Vec::new();
        let mut total_bytes = 0u64;
        let mut active_count = 0usize;
        let mut active_bytes = 0u64;
        let mut scanned_count = 0usize;

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext != "msi" && ext != "msp" {
                continue;
            }

            scanned_count += 1;
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let size = metadata.len();
            let norm = Self::normalize_path(&path.to_string_lossy());

            // Check if in whitelist
            if whitelist.contains(&norm) {
                active_count += 1;
                active_bytes += size;
                continue;
            }

            // Orphan candidate!
            total_bytes += size;
            let last_modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            // Extract MSI Summary Information
            let (subject, author, comments, pkg_code) = Self::extract_msi_metadata(&path);

            // Secondary check: verify if registered in Uninstall
            let in_uninstall =
                Self::check_in_uninstall_registry(pkg_code.as_deref(), subject.as_deref());
            let recommendation = if in_uninstall {
                CleanRecommendation::Caution
            } else {
                CleanRecommendation::SafeToQuarantine
            };

            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            items.push(CleanItem {
                path: path.to_string_lossy().to_string(),
                name,
                size,
                last_modified,
                product_name: subject,
                author,
                package_code: pkg_code,
                comments,
                recommendation,
            });
        }

        // Sort items by size descending
        items.sort_by(|a, b| b.size.cmp(&a.size));

        Ok(CleanerScanResult {
            plugin_id: "windows_installer".to_string(),
            items,
            total_bytes,
            active_count,
            active_bytes,
            scanned_count,
        })
    }

    fn execute(
        &self,
        action: CleanAction,
        item_paths: Vec<String>,
    ) -> Result<CleanExecutionResult, String> {
        let mut processed = 0usize;
        let mut succeeded = 0usize;
        let mut failed = 0usize;
        let mut freed_bytes = 0u64;
        let mut details = Vec::new();

        match action {
            CleanAction::Quarantine { target_dir } => {
                let target_path = PathBuf::from(&target_dir);
                if !target_path.exists() {
                    std::fs::create_dir_all(&target_path).map_err(|e| {
                        format!("创建隔离目录失败 ({}): {}", target_path.display(), e)
                    })?;
                }

                for p_str in item_paths {
                    processed += 1;
                    let src = PathBuf::from(&p_str);
                    if !src.exists() {
                        failed += 1;
                        details.push(CleanItemResult {
                            path: p_str,
                            success: false,
                            message: "文件不存在".to_string(),
                        });
                        continue;
                    }

                    let file_size = src.metadata().map(|m| m.len()).unwrap_or(0);
                    let file_name = match src.file_name() {
                        Some(n) => n,
                        None => {
                            failed += 1;
                            details.push(CleanItemResult {
                                path: p_str,
                                success: false,
                                message: "获取文件名失败".to_string(),
                            });
                            continue;
                        }
                    };

                    let dst = target_path.join(file_name);

                    // Move file (try rename first, fallback to copy+remove)
                    let move_res = std::fs::rename(&src, &dst).or_else(|_| {
                        std::fs::copy(&src, &dst)
                            .and_then(|_| std::fs::remove_file(&src))
                            .map(|_| ())
                    });

                    match move_res {
                        Ok(_) => {
                            succeeded += 1;
                            freed_bytes += file_size;
                            details.push(CleanItemResult {
                                path: p_str,
                                success: true,
                                message: format!("已成功隔离至: {}", dst.display()),
                            });
                        }
                        Err(e) => {
                            failed += 1;
                            details.push(CleanItemResult {
                                path: p_str,
                                success: false,
                                message: format!("隔离失败: {}", e),
                            });
                        }
                    }
                }
            }

            CleanAction::Rename { prefix } => {
                for p_str in item_paths {
                    processed += 1;
                    let src = PathBuf::from(&p_str);
                    if !src.exists() {
                        failed += 1;
                        details.push(CleanItemResult {
                            path: p_str,
                            success: false,
                            message: "文件不存在".to_string(),
                        });
                        continue;
                    }

                    let file_size = src.metadata().map(|m| m.len()).unwrap_or(0);
                    let file_name = match src.file_name().and_then(|n| n.to_str()) {
                        Some(n) => n,
                        None => {
                            failed += 1;
                            details.push(CleanItemResult {
                                path: p_str,
                                success: false,
                                message: "无效文件名".to_string(),
                            });
                            continue;
                        }
                    };

                    if file_name.starts_with(&prefix) {
                        succeeded += 1;
                        details.push(CleanItemResult {
                            path: p_str,
                            success: true,
                            message: "该文件已被重命名过".to_string(),
                        });
                        continue;
                    }

                    let new_name = format!("{}{}", prefix, file_name);
                    let dst = src.with_file_name(new_name);

                    match std::fs::rename(&src, &dst) {
                        Ok(_) => {
                            succeeded += 1;
                            freed_bytes += file_size;
                            details.push(CleanItemResult {
                                path: p_str,
                                success: true,
                                message: format!("已重命名为: {}", dst.display()),
                            });
                        }
                        Err(e) => {
                            failed += 1;
                            details.push(CleanItemResult {
                                path: p_str,
                                success: false,
                                message: format!("重命名失败: {}", e),
                            });
                        }
                    }
                }
            }

            CleanAction::Delete { permanent } => {
                for p_str in item_paths {
                    processed += 1;
                    let src = PathBuf::from(&p_str);
                    if !src.exists() {
                        failed += 1;
                        details.push(CleanItemResult {
                            path: p_str,
                            success: false,
                            message: "文件不存在".to_string(),
                        });
                        continue;
                    }

                    let file_size = src.metadata().map(|m| m.len()).unwrap_or(0);

                    // Ensure attributes allow deletion
                    let src_w: Vec<u16> = src
                        .to_string_lossy()
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect();
                    unsafe {
                        let _ = SetFileAttributesW(
                            PCWSTR::from_raw(src_w.as_ptr()),
                            FILE_ATTRIBUTE_NORMAL,
                        );
                    }

                    if permanent {
                        match std::fs::remove_file(&src) {
                            Ok(_) => {
                                succeeded += 1;
                                freed_bytes += file_size;
                                details.push(CleanItemResult {
                                    path: p_str,
                                    success: true,
                                    message: "已永久删除".to_string(),
                                });
                            }
                            Err(e) => {
                                failed += 1;
                                details.push(CleanItemResult {
                                    path: p_str,
                                    success: false,
                                    message: format!("删除失败: {}", e),
                                });
                            }
                        }
                    } else {
                        // Move to Windows Recycle Bin
                        // Double null-terminated path required by SHFileOperationW
                        let mut double_null_w = src_w.clone();
                        double_null_w.push(0);

                        let mut file_op = SHFILEOPSTRUCTW {
                            hwnd: HWND::default(),
                            wFunc: FO_DELETE,
                            pFrom: PCWSTR::from_raw(double_null_w.as_ptr()),
                            pTo: PCWSTR::null(),
                            fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT).0 as u16,
                            fAnyOperationsAborted: false.into(),
                            hNameMappings: std::ptr::null_mut(),
                            lpszProgressTitle: PCWSTR::null(),
                        };

                        let ret = unsafe { SHFileOperationW(&mut file_op) };
                        if ret == 0 && !file_op.fAnyOperationsAborted.as_bool() {
                            succeeded += 1;
                            freed_bytes += file_size;
                            details.push(CleanItemResult {
                                path: p_str,
                                success: true,
                                message: "已移动至系统回收站".to_string(),
                            });
                        } else {
                            // Fallback to permanent remove if recycle bin fails
                            match std::fs::remove_file(&src) {
                                Ok(_) => {
                                    succeeded += 1;
                                    freed_bytes += file_size;
                                    details.push(CleanItemResult {
                                        path: p_str,
                                        success: true,
                                        message: "回收站操作失败，已执行直接删除".to_string(),
                                    });
                                }
                                Err(e) => {
                                    failed += 1;
                                    details.push(CleanItemResult {
                                        path: p_str,
                                        success: false,
                                        message: format!("移动到回收站与删除均失败: {}", e),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(CleanExecutionResult {
            processed,
            succeeded,
            failed,
            freed_bytes,
            details,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_installer_cleaner_scan() {
        let cleaner = WindowsInstallerCleaner::new();
        let info = cleaner.info();
        assert_eq!(info.id, "windows_installer");
        let res = cleaner.scan();
        assert!(res.is_ok(), "Scan failed: {:?}", res.err());
        let result = res.unwrap();
        println!(
            "Scanned: {}, Active count: {} ({} MB), Orphan count: {} ({} MB)",
            result.scanned_count,
            result.active_count,
            result.active_bytes / (1024 * 1024),
            result.items.len(),
            result.total_bytes / (1024 * 1024)
        );
        assert!(result.scanned_count > 0);
    }
}
