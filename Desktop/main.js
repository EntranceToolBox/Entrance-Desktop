const { app, BrowserWindow, Menu, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, fork } = require('child_process');

const ENTRANCE_URL = process.env.ENTRANCE_URL || 'http://localhost:3000';
const ENTRANCE_ORIGIN = new URL(ENTRANCE_URL).origin;
const RETRY_INTERVAL_MS = 2000;
const DEFAULT_AUTH_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DEFAULT_SSH_PASSWORD_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let retryTimer = null;
let backendProcess = null;
let quitting = false;

function appendEnableFeatures(features) {
  const existing = app.commandLine.getSwitchValue('enable-features');
  const merged = new Set(
    String(existing || '')
      .split(',')
      .concat(features)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  app.commandLine.appendSwitch('enable-features', Array.from(merged).join(','));
}

if (process.platform === 'linux') {
  const requestedHint = String(
    process.env.ENTRANCE_OZONE_PLATFORM_HINT ||
      process.env.ELECTRON_OZONE_PLATFORM_HINT ||
      'auto'
  )
    .trim()
    .toLowerCase();

  const inWaylandSession =
    Boolean(process.env.WAYLAND_DISPLAY) ||
    String(process.env.XDG_SESSION_TYPE || '')
      .trim()
      .toLowerCase() === 'wayland';

  const effectiveHint =
    requestedHint === 'auto' ? (inWaylandSession ? 'wayland' : 'x11') : requestedHint;

  if (effectiveHint === 'wayland') {
    appendEnableFeatures(['UseOzonePlatform', 'WaylandWindowDecorations']);
    app.commandLine.appendSwitch('ozone-platform', 'wayland');
    app.commandLine.appendSwitch('ozone-platform-hint', 'wayland');
    process.env.ELECTRON_OZONE_PLATFORM_HINT = 'wayland';
  } else if (effectiveHint === 'x11') {
    app.commandLine.appendSwitch('ozone-platform', 'x11');
    app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
    process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  } else {
    app.commandLine.appendSwitch('ozone-platform-hint', requestedHint);
    process.env.ELECTRON_OZONE_PLATFORM_HINT = requestedHint;
  }
}

function isAllowedNavigation(url) {
  try {
    return new URL(url).origin === ENTRANCE_ORIGIN;
  } catch {
    return false;
  }
}

function isEntranceReachable() {
  return new Promise((resolve) => {
    const request = net.request(ENTRANCE_URL);
    request.on('response', () => resolve(true));
    request.on('error', () => resolve(false));
    request.end();
  });
}

function getBackendDirectory() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'Entrance');
  }
  return path.resolve(__dirname, '..', 'Entrance');
}

function getBackendEntrypoint() {
  return path.join(getBackendDirectory(), 'server.js');
}

function getBackendDataDirectory() {
  return process.env.ENTRANCE_DATA_DIR || path.join(app.getPath('userData'), 'backend-data');
}

function getBackendEnv() {
  const port = new URL(ENTRANCE_URL).port || '3000';
  const dataDir = getBackendDataDirectory();
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    ...process.env,
    PORT: process.env.PORT || port,
    AUTH_SECRET: process.env.AUTH_SECRET || DEFAULT_AUTH_SECRET,
    SSH_PASSWORD_KEY: process.env.SSH_PASSWORD_KEY || DEFAULT_SSH_PASSWORD_KEY,
    ENTRANCE_DATA_DIR: dataDir
  };
}

function attachBackendLogs(child, source) {
  if (!child) {
    return;
  }

  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      process.stdout.write(`[backend:${source}] ${chunk}`);
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[backend:${source}] ${chunk}`);
    });
  }

  child.on('exit', (code, signal) => {
    if (quitting) {
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`Backend exited with ${reason}.`);
  });
}

function launchBackendWithFork() {
  const entrypoint = getBackendEntrypoint();
  const backendDir = getBackendDirectory();
  if (!fs.existsSync(entrypoint)) {
    console.error(`Backend entrypoint not found: ${entrypoint}`);
    return;
  }

  backendProcess = fork(entrypoint, [], {
    cwd: backendDir,
    env: getBackendEnv(),
    silent: true
  });

  attachBackendLogs(backendProcess, 'fork');
}

function launchBackendWithNpm() {
  const backendDir = getBackendDirectory();
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  const child = spawn(npmCmd, ['start'], {
    cwd: backendDir,
    env: getBackendEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.on('error', (err) => {
    // Fallback for packaged environments where npm may not exist.
    if (err && err.code === 'ENOENT') {
      launchBackendWithFork();
      return;
    }
    console.error(`Failed to start backend with npm: ${err.message}`);
  });

  backendProcess = child;
  attachBackendLogs(backendProcess, 'npm');
}

function startBackend() {
  if (process.env.ENTRANCE_AUTOSTART === '0') {
    return;
  }

  if (app.isPackaged) {
    launchBackendWithFork();
    return;
  }

  launchBackendWithNpm();
}

function stopBackend() {
  if (!backendProcess || backendProcess.killed) {
    return;
  }

  const target = backendProcess;
  backendProcess = null;

  if (process.platform === 'win32') {
    target.kill();
    return;
  }

  target.kill('SIGTERM');
}

function stopRetryLoop() {
  if (retryTimer !== null) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

function showWaitingPage(win) {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Entrance Desktop</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        font-family: "Noto Sans", "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      .card {
        padding: 24px 28px;
        border-radius: 12px;
        border: 1px solid rgba(128, 128, 128, 0.4);
        max-width: 520px;
      }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p { margin: 0; line-height: 1.5; opacity: 0.88; }
      code { font-size: 0.95em; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Waiting For Entrance</h1>
      <p>
        Cannot reach <code>${ENTRANCE_URL}</code>.
        Desktop is auto-starting backend service and will reconnect automatically.
      </p>
    </div>
  </body>
</html>`;

  return win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function startRetryLoop(win) {
  if (retryTimer !== null) {
    return;
  }

  retryTimer = setInterval(async () => {
    if (win.isDestroyed()) {
      stopRetryLoop();
      return;
    }

    const reachable = await isEntranceReachable();
    if (!reachable) {
      return;
    }

    stopRetryLoop();

    try {
      await win.loadURL(ENTRANCE_URL);
    } catch {
      await showWaitingPage(win);
      startRetryLoop(win);
    }
  }, RETRY_INTERVAL_MS);
}

function lockToEntrance(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) {
      void win.loadURL(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if ((input.control || input.meta) && key === 'r') {
      event.preventDefault();
    }
    if ((input.control || input.meta) && input.shift && key === 'i') {
      event.preventDefault();
    }
    if (key === 'f12') {
      event.preventDefault();
    }
  });
}

async function openEntrance(win) {
  const reachable = await isEntranceReachable();
  if (reachable) {
    try {
      await win.loadURL(ENTRANCE_URL);
      return;
    } catch {
      // Fall through to waiting page
    }
  }

  await showWaitingPage(win);
  startRetryLoop(win);
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  });

  win.removeMenu();
  lockToEntrance(win);

  win.webContents.on('did-fail-load', async (_event, _code, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    if (!isAllowedNavigation(validatedURL)) {
      return;
    }

    await showWaitingPage(win);
    startRetryLoop(win);
  });

  void openEntrance(win);
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  startBackend();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopRetryLoop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  stopBackend();
});
