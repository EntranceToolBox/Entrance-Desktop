# Entrance-Desktop

[中文文档 / Chinese README](README_CN.md)

Desktop wrapper for [Entrance](https://github.com/fcanlnony/Entrance), built with Electron.

![Screenshot](doc/screenshot.png)

## Repository Layout

- `Entrance/`: backend submodule (kept with original folder name)
- `Desktop/`: Electron desktop source code
- `Share/Linux/`: Linux desktop icon and `.desktop` files
- `Share/Windows/`: Windows icon and shortcut assets

## Quick Start

1. Install dependencies:

```bash
npm run install:all
```

2. Start desktop app:

```bash
npm start
```

The Electron app auto-starts backend from `Entrance`.

## Startup Model

Desktop startup does not use `Entrance/start.sh`.

- Development startup: `npm start` runs `Desktop/launch-electron.js`, which launches Electron with `Desktop/main.js`.
- Linux packaged startup: the AppImage/executable starts Electron. During packaging, `Desktop/scripts/after-pack.js` creates a Linux wrapper that adds `--no-sandbox` and Wayland/X11 flags before executing the real binary.
- macOS packaged startup: the `.app` starts Electron directly with `Desktop/main.js`.
- Windows packaged startup: the portable `.exe` starts Electron directly with `Desktop/main.js`.

The backend is started by `Desktop/main.js` with `child_process.fork()` against `Entrance/server.js`. The desktop process sets the backend environment, including `PORT`, `AUTH_SECRET`, `SSH_PASSWORD_KEY`, and `ENTRANCE_DATA_DIR`.

`Entrance/start.sh` is only for running the backend submodule independently.

## Build Packages

```bash
# current platform
npm run dist

# platform specific
npm run dist:linux
npm run dist:win
```

Artifacts are generated in `Desktop/dist/`.
Windows builds now produce a single portable `.exe`.

感谢测试: [makabaka2240](https://github.com/makabaka2240) 
