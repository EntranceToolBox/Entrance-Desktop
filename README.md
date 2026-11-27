# Entrance-Desktop

[中文文档 / Chinese README](README_CN.md)

Desktop wrapper for [Entrance](https://github.com/fcanlnony/Entrance) for Linux, Windows and macOS.

![Screenshot](doc/screenshot.png)

## Repository Layout

- `Entrance/`: backend submodule (kept with original folder name)
- `Platform/Linux/`: C++17, GTK4, libadwaita and WebKitGTK
- `Platform/Windows/`: C++17, Win32 and WebView2 with a Mica title bar on Windows 11 22H2 or later
- `Platform/macOS/`: Swift, AppKit and WKWebView
- `Share/Linux/`: Linux desktop icon and `.desktop` files
- `Share/Windows/`: Windows icon and shortcut assets

## Build dependencies

All builds use Git, Node.js and npm. Node.js 24 LTS is a suitable build host. Choose the row for your build host and target.

| Build host → target | Client toolchain | Additional packaging tools |
| --- | --- | --- |
| Linux → Linux | CMake 3.20+, a C++17 compiler, pkg-config, and development packages for GTK4, libadwaita 1 and WebKitGTK 6.0 | Bash, `patchelf` and `appimagetool`. Alternatively, install `squashfs-tools` and set `APPIMAGE_RUNTIME` to a Type 2 runtime for the target CPU. |
| Windows → Windows | Visual Studio 2022 with Desktop development with C++, the Windows SDK and CMake 3.20+ | NSIS 3 (`makensis`). Install the Evergreen WebView2 Runtime to run the client. |
| Linux → Windows x64 | CMake 3.20+ and MinGW-w64 with `x86_64-w64-mingw32-g++` and `x86_64-w64-mingw32-windres` | NSIS 3 (`makensis`) |
| macOS → macOS | Xcode Command Line Tools with Swift and the macOS SDK (AppKit and WebKit) | `curl`, `tar`, `lipo`, `codesign` and `ditto` |
| Linux → macOS | Swift with Darwin target support, a compatible macOS SDK with Swift module interfaces, and LLVM's Mach-O linker (`ld64.lld`) | `llvm-lipo`, `rcodesign`, `curl`, `tar` and `zip`. Set `MACOS_SDKROOT` or `SDKROOT` to the SDK directory. |

The Windows build downloads the WebView2 SDK from NuGet. Linux-to-Windows packaging also downloads Windows Node.js. macOS packaging downloads Node.js for both Intel and Apple Silicon and installs the locked backend dependencies for each target.

## Quick Start

1. Initialize the backend submodule and install its dependencies from the repository root.

```bash
git submodule update --init --recursive
npm run install:all
```

2. Start desktop app:

```bash
npm start
```

## Build Packages

On Linux, run `npm run dist:linux` or `npm run dist` to generate `Desktop/dist/Entrance-Desktop-<version>-<arch>.AppImage`.

Make the AppImage executable and run it directly. It includes the native client, backend and Node.js. The host provides FUSE, GTK4, libadwaita and WebKitGTK 6.0. Build on the oldest Linux distribution you intend to support so that the system library versions are compatible.

On Linux, run `npm run dist:win` to cross-build the Windows x64 installer. The result is `Desktop/dist/Entrance-Desktop-Setup-<version>-Windows-x64.exe`. Run Setup once on Windows with the Evergreen WebView2 Runtime installed. Then launch Entrance Desktop from the Start menu. Setup defaults to `%LOCALAPPDATA%\Programs\Entrance Desktop`. You can browse to another writable folder. Upgrades default to the previous installation folder. Windows Settings lists the uninstaller.

On Windows, run `npm run dist` to create the installer in `Desktop/dist/`.

Run `npm run dist:darwin` to build both macOS packages in `Desktop/dist/`, named `Entrance-Desktop-<version>-macOS-x86_64.zip` and `Entrance-Desktop-<version>-macOS-arm64.zip`. Extract the matching archive and move `Entrance Desktop.app` into Applications. Each package includes Node.js and the native backend modules for its target. The minimum system version is macOS 13.5. [macOS build instructions](Platform/macOS/README.md)

The native app starts the bundled Entrance backend on loopback and closes it when the window exits. Set `PORT` to choose its port (default 3000). To open an already running web frontend, set `ENTRANCE_AUTOSTART=0` and `ENTRANCE_URL`.

感谢测试: [makabaka2240](https://github.com/makabaka2240) 
