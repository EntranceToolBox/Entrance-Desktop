# Desktop

Electron shell for the Entrance backend.

## Behavior

- The app renders the frontend from a local `app://...` origin and talks to the backend over loopback HTTP/WebSocket by default.
- Electron auto-starts the `Entrance` backend process.
- Electron always sets `ENTRANCE_DESKTOP_NOLOGIN=1` when starting the backend, overriding any inherited value.
- Desktop API-only mode is enabled by default. In this mode, Electron bootstraps a protected desktop no-login session through `POST /api/auth/desktop/bootstrap` and keeps the auth token in the main process.
- If backend is still booting, Electron shows a waiting page and retries every 2 seconds.
- DevTools shortcuts are blocked in the desktop window.

## Run

1. Install backend dependencies:

```bash
cd Entrance
npm install
```

2. Install desktop dependencies:

```bash
cd Platform/macOS
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
- `ENTRANCE_DESKTOP_ALLOWED_ORIGIN` defaults to `app://entrance`.
- Electron generates `ENTRANCE_DESKTOP_BOOTSTRAP_SECRET` when it starts the backend. With `ENTRANCE_AUTOSTART=0` in API-only mode, set the same secret on both processes and start the external backend with `ENTRANCE_DESKTOP_NOLOGIN=1`.
- `ENTRANCE_DESKTOP_VERSION` defaults to the desktop app's `package.json.version`; set it explicitly only if you need to override that value.

## Package

Run `npm run dist:darwin` from the repository root. The build writes `Entrance Desktop.app` and `Entrance Desktop.app.zip` to `Desktop/dist/`.
