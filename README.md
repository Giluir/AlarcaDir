# AlarcaDir

English | [简体中文](README_ZH.md)

AlarcaDir is a high-performance disk space analysis tool built with Tauri and Rust. It provides an intuitive Treemap visualization of your disk usage, helping you quickly identify large files and redundant duplicates.

## Features

- **Blazing Performance**: Powered by a custom Rust scanning engine. With Administrator privileges, it supports near-instant full-disk indexing by reading the **NTFS MFT** directly (inspired by WinDirStat's algorithm).
- **Visual Insights**: A dynamic Treemap displays file proportions with support for multi-level drill-down exploration.
- **Duplicate Detection**: Accurately locates wasted space using size pre-filtering and SHA-512 content hashing.
- **Modern UI**: A fluid user experience crafted with React, featuring a modern aesthetic that respects dark mode system preferences.
- **Explorer Integration**: Locate and highlight any file in Windows Explorer with a single click.

## Security & Privileges

To achieve the best scanning speed, running as **Administrator** is recommended.
- **Admin Mode**: Enables high-speed NTFS MFT scanning and ensures access to most system directories.
- **User Mode**: The application falls back to standard recursive filesystem traversal.

## Technology Stack

- **Backend**: Rust, Tauri
- **Frontend**: React, TypeScript, Vite
- **Algorithm**: The scanning logic is adapted from the classic [WinDirStat](https://github.com/windirstat/windirstat).

## Development

Ensure you have [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/) installed.

### Setup
```bash
npm install
```

### Run in Debug Mode
```bash
npm run tauri dev
```

### Build for Production
```bash
npm run tauri build
```

## License

GPL-2.0
