# AlarcaDir

[English](README.md) | 简体中文

AlarcaDir 是一款基于 Tauri 和 Rust 开发的高性能磁盘空间分析工具。它通过直观的矩形树图（Treemap）可视化您的磁盘占用情况，帮助您快速识别大文件和重复文件。

## 核心特性

- **极致性能**：采用 Rust 编写的扫描引擎。在具备管理员权限时，支持通过读取 **NTFS MFT** 进行秒级全盘扫描（算法启发自 WinDirStat）。
- **直观可视化**：动态矩形树图展示文件比例，支持多级下钻探索。
- **重复文件检测**：基于文件大小预过滤和 SHA-512 哈希校验，精准定位浪费空间的重复内容。
- **现代化 UI**：基于 React 打造的流畅交互体验，支持深色模式感知的现代美学设计。
- **文件交互**：一键在资源管理器中定位并选中目标文件。

## 安全与权限

为了获得最佳扫描速度，建议以**管理员身份**运行。
- **管理员权限**：启用 NTFS MFT 高速扫描，能够访问大多数受保护的系统目录。
- **普通用户权限**：程序将回退至标准的递归文件系统遍历模式。

## 技术栈

- **后端**: Rust, Tauri
- **前端**: React, TypeScript, Vite
- **算法相关**: 扫描算法参考自经典工具 [WinDirStat](https://github.com/windirstat/windirstat)。

## 开发与构建

确保您的开发环境已安装 [Node.js](https://nodejs.org/) 和 [Rust](https://www.rust-lang.org/)。

### 安装依赖
```bash
npm install
```

### 调试运行
```bash
npm run tauri dev
```

### 生成安装包
```bash
npm run tauri build
```

## 开源协议

GPL-2.0
