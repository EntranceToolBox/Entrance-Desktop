# Desktop

Electron shell for the Entrance backend.

## Behavior

- The app only allows navigation within `http://localhost:3000` by default.
- Electron auto-starts the `Entrance` backend process.
- If backend is still booting, Electron shows a waiting page and retries every 2 seconds.
- DevTools shortcuts are blocked in the desktop window.

## Run

1. Install backend dependencies:

```bash
cd ../Entrance
npm install
```

2. Install desktop dependencies:

```bash
cd ../Desktop
npm install
```

3. Start desktop shell (backend auto-start):

```bash
npm start
```

Optional:

- Use `ENTRANCE_URL` to point to another local URL.
  - Example: `ENTRANCE_URL=http://127.0.0.1:3000 npm start`
- Use `ENTRANCE_AUTOSTART=0` to disable backend auto-start.

## Package

```bash
# current platform
npm run dist

# linux
npm run dist:linux

# windows
npm run dist:win

# macOS
npm run dist:mac
```

To build all platforms in one go, run GitHub Actions workflow:
`.github/workflows/build-desktop.yml`.
