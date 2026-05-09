# Desktop

Electron shell for the Entrance backend.

## Behavior

- The app renders the frontend from a local `app://...` origin and talks to the backend over loopback HTTP/WebSocket by default.
- Electron auto-starts the `Entrance` backend process.
- Backend startup defaults to `ENTRANCE_DESKTOP_API_ONLY=1` and `ENTRANCE_DESKTOP_NOLOGIN=1`.
- In desktop API-only mode, Electron bootstraps a protected desktop no-login session through `POST /api/auth/desktop/bootstrap` and keeps the auth token in the main process.
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
- Use `ENTRANCE_DESKTOP_API_ONLY=0` if you need the old backend-served frontend path.
- Use `ENTRANCE_DESKTOP_NOLOGIN=0` if you want the desktop wrapper to show the normal login screen.
- `ENTRANCE_DESKTOP_ALLOWED_ORIGIN` defaults to `app://entrance`.
- `ENTRANCE_DESKTOP_BOOTSTRAP_SECRET` is auto-generated when Electron starts the backend itself. If `ENTRANCE_AUTOSTART=0` and desktop API-only no-login mode is still enabled, set the same explicit secret for both the wrapper and the backend.
- `ENTRANCE_DESKTOP_VERSION` defaults to the desktop app's `package.json.version`; set it explicitly only if you need to override that value.
- Linux auto-detects display backend:
  - Wayland session (`WAYLAND_DISPLAY` or `XDG_SESSION_TYPE=wayland`) uses `ozone-platform=wayland`.
  - Otherwise it falls back to `ozone-platform=x11`.
  - Override via `ENTRANCE_OZONE_PLATFORM_HINT` (e.g. `x11`, `wayland`, `auto`).

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

The Windows package target produces a single portable `.exe` rather than an installer.
