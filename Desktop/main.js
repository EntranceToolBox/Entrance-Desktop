const { app, BrowserWindow, Menu, net, session, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const ENTRANCE_URL = process.env.ENTRANCE_URL || 'http://localhost:3000';
const ENTRANCE_ORIGIN = new URL(ENTRANCE_URL).origin;
const RETRY_INTERVAL_MS = 2000;
const STARTUP_PROGRESS_BOOT_DELAY_MS = 180;
const STARTUP_PROGRESS_TRANSITION_MS = 520;
const STARTUP_WINDOW_BACKGROUND = '#eef0ec';
const DEFAULT_AUTH_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DEFAULT_SSH_PASSWORD_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SERIAL_DEBUG = process.env.ENTRANCE_DEBUG_SERIAL === '1';

let retryTimer = null;
let backendProcess = null;
let quitting = false;
let waitingPageLogoDataUrl = null;

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
  const hasExplicitPlatform = app.commandLine.hasSwitch('ozone-platform');
  const hasExplicitHint = app.commandLine.hasSwitch('ozone-platform-hint');

  if (!hasExplicitPlatform && !hasExplicitHint) {
    const requestedHint = String(
      process.env.ENTRANCE_OZONE_PLATFORM_HINT ||
        process.env.ELECTRON_OZONE_PLATFORM_HINT ||
        'auto'
    )
      .trim()
      .toLowerCase();

    if (requestedHint === 'wayland') {
      appendEnableFeatures(['UseOzonePlatform', 'WaylandWindowDecorations']);
      app.commandLine.appendSwitch('ozone-platform', 'wayland');
      app.commandLine.appendSwitch('ozone-platform-hint', 'wayland');
      process.env.ELECTRON_OZONE_PLATFORM_HINT = 'wayland';
    } else if (requestedHint === 'x11') {
      app.commandLine.appendSwitch('ozone-platform', 'x11');
      app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
      process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
    } else {
      app.commandLine.appendSwitch('ozone-platform-hint', requestedHint);
      process.env.ELECTRON_OZONE_PLATFORM_HINT = requestedHint;
    }
  }
}

function isAllowedNavigation(url) {
  try {
    return new URL(url).origin === ENTRANCE_ORIGIN;
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getShareDirectory() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'Share');
  }
  return path.resolve(__dirname, '..', 'Share');
}

function getStartupLogoPath() {
  return path.join(getShareDirectory(), 'Logo.png');
}

function getStartupLogoDataUrl() {
  if (waitingPageLogoDataUrl !== null) {
    return waitingPageLogoDataUrl;
  }

  try {
    const buffer = fs.readFileSync(getStartupLogoPath());
    waitingPageLogoDataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (error) {
    waitingPageLogoDataUrl = '';
    if (!quitting) {
      console.warn(`Failed to load startup logo: ${error.message}`);
    }
  }

  return waitingPageLogoDataUrl;
}

function getAllowedSerialOrigins() {
  const base = new URL(ENTRANCE_URL);
  const port = base.port ? `:${base.port}` : '';
  const allowed = new Set([base.origin]);

  if (base.hostname === 'localhost') {
    allowed.add(`http://127.0.0.1${port}`);
  } else if (base.hostname === '127.0.0.1') {
    allowed.add(`http://localhost${port}`);
  }

  return allowed;
}

function isAllowedSerialOrigin(url) {
  try {
    const origin = new URL(url).origin;
    return getAllowedSerialOrigins().has(origin);
  } catch {
    return false;
  }
}

function configureSerialPermissions() {
  const ses = session.defaultSession;
  if (!ses) {
    return;
  }

  const isBluetoothMacLike = (name) => /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i.test(String(name || ''));
  const normalizePortName = (name) => String(name || '')
    .replace(/^\/dev\//, '')
    .replace(/^\\\\.\\/, '');
  const isLinuxSerialName = (name) => {
    const text = String(name || '');
    return /^\/dev\/tty[A-Za-z0-9._-]+$/.test(text) || /^tty[A-Za-z0-9._-]+$/.test(text);
  };
  const isWindowsSerialName = (name) => {
    const text = String(name || '');
    return /^(?:\\\\.\\)?COM\d+$/i.test(text) || /^COM\d+$/i.test(text);
  };
  const isDarwinSerialName = (name) => {
    const text = String(name || '');
    return /^\/dev\/(cu|tty)\.[A-Za-z0-9._-]+$/.test(text) || /^(cu|tty)\.[A-Za-z0-9._-]+$/.test(text);
  };
  const isSerialName = (name) => {
    if (process.platform === 'win32') {
      return isWindowsSerialName(name);
    }
    if (process.platform === 'darwin') {
      return isDarwinSerialName(name);
    }
    return isLinuxSerialName(name);
  };
  const preferredPrefixOrder = process.platform === 'win32'
    ? ['COM']
    : process.platform === 'darwin'
      ? ['cu.', 'tty.']
      : ['ttyUSB', 'ttyACM', 'ttyAMA', 'ttyTHS', 'ttyS'];

  const parseWindowsComIndex = (name) => {
    const match = /^COM(\d+)$/i.exec(normalizePortName(name));
    if (!match) {
      return null;
    }
    return Number.parseInt(match[1], 10);
  };

  const sortSerialPorts = (ports) => {
    const copy = [...ports];
    copy.sort((a, b) => {
      const aName = normalizePortName(a.portName);
      const bName = normalizePortName(b.portName);
      if (process.platform === 'win32') {
        const aNum = parseWindowsComIndex(aName);
        const bNum = parseWindowsComIndex(bName);
        if (aNum != null && bNum != null && aNum !== bNum) {
          return aNum - bNum;
        }
      }
      const aIdx = preferredPrefixOrder.findIndex((prefix) => aName.startsWith(prefix));
      const bIdx = preferredPrefixOrder.findIndex((prefix) => bName.startsWith(prefix));
      const aScore = aIdx === -1 ? preferredPrefixOrder.length : aIdx;
      const bScore = bIdx === -1 ? preferredPrefixOrder.length : bIdx;
      if (aScore !== bScore) {
        return aScore - bScore;
      }
      return aName.localeCompare(bName);
    });
    return copy;
  };

  const getRealPorts = (portList) => {
    if (process.platform === 'win32') {
      return portList.filter((port) => Boolean(port && (port.portName || port.portId)));
    }
    return portList.filter((port) => {
      const portName = String(port && port.portName);
      const portId = String(port && port.portId);
      if (!portName) {
        return Boolean(portId);
      }
      return isSerialName(portName) && !isBluetoothMacLike(portName);
    });
  };

  const escapeHtml = (value) => {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll('\'', '&#39;');
  };

  const showSerialPortPicker = (ports, webContents) => {
    return new Promise((resolve) => {
      const requestId = `serial-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const selectChannel = `entrance-serial-picker-select-${requestId}`;
      const cancelChannel = `entrance-serial-picker-cancel-${requestId}`;
      const parentWindow = webContents && !webContents.isDestroyed()
        ? BrowserWindow.fromWebContents(webContents)
        : null;

      const rows = ports.map((port, index) => {
        const checked = index === 0 ? 'checked' : '';
        const name = escapeHtml(port.portName || port.portId || '<unknown>');
        const display = escapeHtml(port.displayName || '');
        const detail = escapeHtml([port.vendorId, port.productId].filter(Boolean).join(':'));
        const portId = escapeHtml(port.portId || '');

        return `<label class="item">
  <input type="radio" name="port" value="${portId}" ${checked} />
  <span class="name">${name}</span>
  <span class="meta">${display || detail || '&nbsp;'}</span>
</label>`;
      }).join('\n');

      const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Select Serial Port</title>
    <style>
      body {
        margin: 0;
        font-family: "Noto Sans", "Segoe UI", sans-serif;
        background: #f6f7fb;
        color: #121212;
      }
      .wrap {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
      .header {
        padding: 16px 18px 10px;
      }
      .title {
        margin: 0;
        font-size: 18px;
      }
      .desc {
        margin: 8px 0 0;
        font-size: 13px;
        color: #555;
      }
      .list {
        flex: 1;
        overflow: auto;
        padding: 0 14px 14px;
      }
      .item {
        display: grid;
        grid-template-columns: auto 1fr;
        grid-template-areas:
          "radio name"
          "radio meta";
        gap: 2px 10px;
        align-items: start;
        margin: 8px 0;
        padding: 10px 12px;
        border: 1px solid #dde0ea;
        border-radius: 10px;
        background: #fff;
      }
      .item input {
        grid-area: radio;
        margin-top: 4px;
      }
      .item .name {
        grid-area: name;
        font-weight: 600;
      }
      .item .meta {
        grid-area: meta;
        color: #5f6472;
        font-size: 12px;
      }
      .empty {
        margin: 12px;
        padding: 16px;
        border-radius: 10px;
        border: 1px dashed #c7ccda;
        background: #fff;
        color: #6a7182;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 12px 16px 16px;
        border-top: 1px solid #e4e7f0;
        background: #fff;
      }
      button {
        border: 1px solid #c9cfde;
        background: #fff;
        padding: 8px 14px;
        border-radius: 8px;
        cursor: pointer;
      }
      button.primary {
        background: #0b66ff;
        border-color: #0b66ff;
        color: #fff;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <h1 class="title">选择串口设备</h1>
        <p class="desc">请选择要连接的串口，然后点击“连接”。</p>
      </div>
      <div class="list">
        ${rows || '<div class="empty">未发现可用串口设备。</div>'}
      </div>
      <div class="actions">
        <button id="cancel">取消</button>
        <button id="confirm" class="primary">连接</button>
      </div>
    </div>
    <script>
      const { ipcRenderer } = require('electron');
      const selectChannel = ${JSON.stringify(selectChannel)};
      const cancelChannel = ${JSON.stringify(cancelChannel)};
      const confirmBtn = document.getElementById('confirm');
      const cancelBtn = document.getElementById('cancel');

      function selectedPortId() {
        const checked = document.querySelector('input[name="port"]:checked');
        return checked ? checked.value : '';
      }

      if (!selectedPortId()) {
        confirmBtn.disabled = true;
      }

      confirmBtn.addEventListener('click', () => {
        ipcRenderer.send(selectChannel, selectedPortId());
      });

      cancelBtn.addEventListener('click', () => {
        ipcRenderer.send(cancelChannel);
      });

      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          ipcRenderer.send(cancelChannel);
        } else if (event.key === 'Enter' && !confirmBtn.disabled) {
          event.preventDefault();
          ipcRenderer.send(selectChannel, selectedPortId());
        }
      });
    </script>
  </body>
</html>`;

      let pickerWindow = null;
      let settled = false;

      const finish = (portId = '') => {
        if (settled) {
          return;
        }
        settled = true;
        ipcMain.removeListener(selectChannel, onSelect);
        ipcMain.removeListener(cancelChannel, onCancel);
        if (pickerWindow && !pickerWindow.isDestroyed()) {
          pickerWindow.close();
        }
        resolve(String(portId || ''));
      };

      const onSelect = (_event, portId) => finish(portId);
      const onCancel = () => finish('');

      ipcMain.on(selectChannel, onSelect);
      ipcMain.on(cancelChannel, onCancel);

      try {
        pickerWindow = new BrowserWindow({
          width: 680,
          height: 520,
          minWidth: 560,
          minHeight: 420,
          modal: Boolean(parentWindow),
          parent: parentWindow || undefined,
          show: false,
          resizable: true,
          autoHideMenuBar: true,
          title: 'Select Serial Port',
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false
          }
        });

        pickerWindow.removeMenu();
        pickerWindow.once('ready-to-show', () => {
          if (pickerWindow && !pickerWindow.isDestroyed()) {
            pickerWindow.show();
          }
        });
        pickerWindow.on('closed', () => {
          pickerWindow = null;
          finish('');
        });

        void pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((error) => {
          if (!quitting) {
            console.error(`Failed to open serial picker window: ${error.message}`);
          }
          finish('');
        });
      } catch (error) {
        if (!quitting) {
          console.error(`Failed to create serial picker window: ${error.message}`);
        }
        finish('');
      }
    });
  };

  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();

    let callbackCalled = false;
    const finalize = (portId = '') => {
      if (callbackCalled) {
        return;
      }
      callbackCalled = true;
      callback(String(portId || ''));
    };

    void (async () => {
      const realPorts = sortSerialPorts(getRealPorts(portList));
      if (realPorts.length === 0) {
        if (SERIAL_DEBUG) {
          const currentUrl = webContents && !webContents.isDestroyed()
            ? webContents.getURL()
            : '<destroyed>';
          const portNames = portList.map((port) => port.portName || port.portId).join(', ');
          console.log(`[serial] select-serial-port url=${currentUrl} ports=[${portNames}] mode=picker selected=<none>`);
        }
        finalize('');
        return;
      }
      const selectedPortId = await showSerialPortPicker(realPorts, webContents);

      if (SERIAL_DEBUG) {
        const currentUrl = webContents && !webContents.isDestroyed()
          ? webContents.getURL()
          : '<destroyed>';
        const portNames = portList.map((port) => port.portName || port.portId).join(', ');
        const selectedPort = portList.find((port) => port.portId === selectedPortId);
        const selectedName = selectedPort ? (selectedPort.portName || selectedPort.portId) : '<none>';
        console.log(
          `[serial] select-serial-port url=${currentUrl} ` +
          `ports=[${portNames}] mode=picker selected=${selectedName}`
        );
      }

      finalize(selectedPortId);
    })().catch((error) => {
      if (!quitting) {
        console.error(`Serial port selection failed: ${error.message}`);
      }
      finalize('');
    });
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission !== 'serial') {
      return true;
    }

    const allowed = isAllowedSerialOrigin(requestingOrigin);
    if (SERIAL_DEBUG) {
      const currentUrl = webContents && !webContents.isDestroyed()
        ? webContents.getURL()
        : '<destroyed>';
      console.log(`[serial] permission check origin=${requestingOrigin} url=${currentUrl} allowed=${allowed}`);
    }
    return allowed;
  });

  ses.setDevicePermissionHandler((details) => {
    if (!details || details.deviceType !== 'serial') {
      return false;
    }

    const originAllowed = isAllowedSerialOrigin(details.origin);
    const portName = String((details.device && details.device.portName) || '');
    const portId = String((details.device && details.device.portId) || '');

    // Device permission callback may not include a resolvable serial device name on Linux.
    // Port filtering/selection is already enforced in select-serial-port.
    const hasPortIdentity = Boolean(portName || portId);
    const linuxPortAllowed = !hasPortIdentity
      || /^\/dev\/tty[A-Za-z0-9._-]+$/.test(portName)
      || /^tty[A-Za-z0-9._-]+$/.test(portName);
    const portAllowed = process.platform !== 'linux' || linuxPortAllowed;
    const allowed = originAllowed && portAllowed;

    if (SERIAL_DEBUG) {
      console.log(
        `[serial] device permission origin=${details.origin} ` +
        `port=${portName || '<unknown>'} portId=${portId || '<unknown>'} ` +
        `originAllowed=${originAllowed} portAllowed=${portAllowed} allowed=${allowed}`
      );
    }

    return allowed;
  });

  if (SERIAL_DEBUG) {
    ses.on('serial-port-added', (_event, port, webContents) => {
      const currentUrl = webContents && !webContents.isDestroyed()
        ? webContents.getURL()
        : '<destroyed>';
      const id = (port && (port.portName || port.portId)) || '<unknown>';
      console.log(`[serial] port added url=${currentUrl} port=${id}`);
    });

    ses.on('serial-port-removed', (_event, port, webContents) => {
      const currentUrl = webContents && !webContents.isDestroyed()
        ? webContents.getURL()
        : '<destroyed>';
      const id = (port && (port.portName || port.portId)) || '<unknown>';
      console.log(`[serial] port removed url=${currentUrl} port=${id}`);
    });
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
    ENTRANCE_DESKTOP_NOLOGIN: process.env.ENTRANCE_DESKTOP_NOLOGIN || '1',
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

function startBackend() {
  if (process.env.ENTRANCE_AUTOSTART === '0') {
    return;
  }

  launchBackendWithFork();
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

function isWindowUsable(win) {
  return Boolean(
    win &&
      !win.isDestroyed() &&
      win.webContents &&
      !win.webContents.isDestroyed()
  );
}

async function safeLoadURL(win, url) {
  if (!isWindowUsable(win)) {
    return false;
  }

  try {
    await win.loadURL(url);
    return true;
  } catch (error) {
    if (!isWindowUsable(win)) {
      return false;
    }
    throw error;
  }
}

async function setWaitingPageState(win, state, options = {}) {
  if (!isWindowUsable(win)) {
    return false;
  }

  const payload = typeof state === 'string' ? { state } : state;
  const config = {
    waitForSettle: Boolean(options.waitForSettle)
  };

  try {
    return await win.webContents.executeJavaScript(
      `(() => {
        const controller = window.__entranceDesktopStartup;
        if (!controller || typeof controller.setState !== 'function') {
          return false;
        }
        return Promise.resolve(
          controller.setState(${JSON.stringify(payload)}, ${JSON.stringify(config)})
        ).then(() => true);
      })();`,
      true
    );
  } catch {
    return false;
  }
}

async function loadEntranceWithStartupTransition(win) {
  const renderingShown = await setWaitingPageState(win, {
    state: 'rendering',
    progress: 84,
    completedSteps: 3,
    activeStep: 3,
    status: '正在载入控制台界面',
    hint: '已完成 3 / 4 个启动阶段，正在加载已就绪的界面部分'
  });
  if (renderingShown) {
    await wait(120);
  }

  const finishingShown = await setWaitingPageState(win, {
    state: 'finishing',
    progress: 100,
    completedSteps: 4,
    activeStep: -1,
    status: '即将进入 Entrance',
    hint: '启动阶段已完成，正在切换到主界面'
  }, {
    waitForSettle: true
  });

  const waitingPageVisible = await setWaitingPageState(win, {
    state: 'complete',
    progress: 100,
    completedSteps: 4,
    activeStep: -1,
    status: '即将进入 Entrance',
    hint: '启动阶段已完成，正在切换到主界面'
  });
  if (finishingShown && waitingPageVisible) {
    await wait(STARTUP_PROGRESS_TRANSITION_MS);
  }

  return safeLoadURL(win, ENTRANCE_URL);
}

async function showWaitingPage(win) {
  const logoSrc = getStartupLogoDataUrl();
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Entrance Desktop</title>
    <style>
      :root {
        color-scheme: light;
        --bg-1: #fbfbf8;
        --bg-2: #eceeeb;
        --bg-3: #d8dcda;
        --panel: rgba(255, 255, 255, 0.82);
        --border: rgba(126, 133, 141, 0.16);
        --text: #20242b;
        --text-muted: rgba(32, 36, 43, 0.7);
        --text-soft: rgba(32, 36, 43, 0.48);
        --track: rgba(153, 160, 168, 0.2);
        --fill-start: #636b76;
        --fill-mid: #8b95a1;
        --fill-end: #c4cad2;
      }
      body {
        margin: 0;
        font-family: "Noto Sans", "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
        overflow: hidden;
        background:
          radial-gradient(circle at 16% 18%, rgba(255, 255, 255, 0.98), transparent 34%),
          radial-gradient(circle at 84% 20%, rgba(228, 231, 233, 0.92), transparent 30%),
          linear-gradient(145deg, var(--bg-1), var(--bg-2) 58%, var(--bg-3));
        color: var(--text);
        opacity: 1;
        transition: opacity ${STARTUP_PROGRESS_TRANSITION_MS}ms ease;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background:
          linear-gradient(120deg, rgba(255, 255, 255, 0.55), transparent 42%),
          radial-gradient(circle at 78% 78%, rgba(203, 207, 211, 0.42), transparent 24%);
        pointer-events: none;
        opacity: 1;
        transition: opacity ${STARTUP_PROGRESS_TRANSITION_MS}ms ease;
      }
      .card {
        width: min(420px, calc(100vw - 48px));
        padding: 36px 28px 26px;
        border-radius: 24px;
        border: 1px solid var(--border);
        background: var(--panel);
        backdrop-filter: blur(22px);
        box-shadow: 0 24px 72px rgba(138, 143, 150, 0.18);
        text-align: center;
        transform: translateY(0) scale(1);
        opacity: 1;
        transition: transform ${STARTUP_PROGRESS_TRANSITION_MS}ms ease, opacity ${STARTUP_PROGRESS_TRANSITION_MS}ms ease;
      }
      body[data-state="complete"] {
        opacity: 0;
      }
      body[data-state="complete"]::before {
        opacity: 0;
      }
      body[data-state="complete"] .card {
        opacity: 0;
        transform: translateY(24px) scale(0.96);
      }
      .logo-wrap {
        width: 132px;
        height: 132px;
        margin: 0 auto 20px;
        display: grid;
        place-items: center;
        border-radius: 28px;
        background: linear-gradient(145deg, rgba(255, 255, 255, 0.96), rgba(236, 238, 239, 0.72));
        border: 1px solid rgba(137, 144, 153, 0.12);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.94),
          0 18px 34px rgba(173, 177, 183, 0.18);
      }
      .logo {
        width: 96px;
        height: 96px;
        object-fit: contain;
        filter: drop-shadow(0 8px 14px rgba(120, 126, 133, 0.16));
      }
      .title {
        margin: 0;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: 0.02em;
      }
      .status {
        margin: 10px 0 18px;
        font-size: 16px;
        color: var(--text-muted);
        letter-spacing: 0.08em;
      }
      .progress-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .progress-label {
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--text-soft);
      }
      .progress-value {
        font-size: 14px;
        font-variant-numeric: tabular-nums;
        color: var(--text);
      }
      .progress {
        position: relative;
        height: 20px;
        overflow: hidden;
        background: transparent;
      }
      .progress::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        height: 2px;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(153, 160, 168, 0.32), rgba(153, 160, 168, 0.18));
        transform: translateY(-50%);
      }
      .progress-fill {
        position: relative;
        height: 100%;
        width: 0%;
        overflow: hidden;
        background: transparent;
        box-shadow: none;
        transition: width 220ms cubic-bezier(.22,.61,.36,1);
      }
      .progress-fill::before {
        content: "";
        position: absolute;
        left: 0;
        right: -64px;
        top: 50%;
        height: 16px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 16' preserveAspectRatio='none'%3E%3Cpath d='M0 8C8 8 8 3 16 3S24 13 32 13S40 3 48 3S56 8 64 8' fill='none' stroke='%23636b76' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: repeat-x;
        background-size: 64px 16px;
        filter: drop-shadow(0 3px 8px rgba(99, 107, 118, 0.18));
        transform: translateY(-50%);
        animation: waveDrift 1.3s linear infinite, waveBob 2.4s ease-in-out infinite;
      }
      .progress-fill::after {
        content: "";
        position: absolute;
        left: 0;
        right: -64px;
        top: 50%;
        height: 16px;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 16' preserveAspectRatio='none'%3E%3Cpath d='M0 8C8 8 8 3 16 3S24 13 32 13S40 3 48 3S56 8 64 8' fill='none' stroke='%23eef0ec' stroke-opacity='0.45' stroke-width='1.1' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: repeat-x;
        background-size: 64px 16px;
        transform: translateY(calc(-50% - 1px));
        animation: waveDrift 1.3s linear infinite, waveBob 2.4s ease-in-out infinite;
      }
      .stage-list {
        display: grid;
        gap: 10px;
        margin-top: 18px;
        text-align: left;
      }
      .stage-item {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 10px;
        align-items: center;
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(248, 249, 249, 0.74);
        border: 1px solid rgba(151, 156, 163, 0.1);
        transition:
          transform 240ms ease,
          background 240ms ease,
          border-color 240ms ease,
          box-shadow 240ms ease;
      }
      .stage-dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #c7ccd2;
        box-shadow: 0 0 0 6px rgba(199, 204, 210, 0.18);
      }
      .stage-label {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-soft);
      }
      .stage-meta {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--text-soft);
      }
      .stage-item.is-active {
        background: rgba(255, 255, 255, 0.96);
        border-color: rgba(119, 126, 136, 0.18);
        box-shadow: 0 10px 20px rgba(151, 156, 163, 0.12);
        transform: translateX(4px);
      }
      .stage-item.is-active .stage-dot {
        background: #68707b;
        box-shadow: 0 0 0 8px rgba(104, 112, 123, 0.12);
      }
      .stage-item.is-active .stage-label,
      .stage-item.is-active .stage-meta,
      .stage-item.is-done .stage-label,
      .stage-item.is-done .stage-meta {
        color: var(--text);
      }
      .stage-item.is-done .stage-dot {
        background: #97a0aa;
        box-shadow: 0 0 0 6px rgba(151, 160, 170, 0.14);
      }
      .hint {
        margin: 14px 0 0;
        font-size: 13px;
        color: var(--text-muted);
      }
      @keyframes waveDrift {
        0% { background-position: 0 0; }
        100% { background-position: 64px 0; }
      }
      @keyframes waveBob {
        0%, 100% { transform: translateY(calc(-50% - 1px)); }
        50% { transform: translateY(calc(-50% + 1px)); }
      }
    </style>
  </head>
  <body data-state="idle">
    <div class="card">
      <div class="logo-wrap">
        <img class="logo" src="${logoSrc}" alt="Entrance Desktop logo" />
      </div>
      <h1 class="title">Entrance</h1>
      <p class="status" id="statusText">准备启动窗口</p>
      <div class="progress-row">
        <span class="progress-label">启动进度</span>
        <span class="progress-value" id="progressValue">08%</span>
      </div>
      <div class="progress" aria-hidden="true">
        <div class="progress-fill" id="progressFill"></div>
      </div>
      <div class="stage-list">
        <div class="stage-item" data-step="0">
          <span class="stage-dot"></span>
          <span class="stage-label">桌面窗口初始化</span>
          <span class="stage-meta">待命</span>
        </div>
        <div class="stage-item" data-step="1">
          <span class="stage-dot"></span>
          <span class="stage-label">本地服务启动</span>
          <span class="stage-meta">待命</span>
        </div>
        <div class="stage-item" data-step="2">
          <span class="stage-dot"></span>
          <span class="stage-label">服务状态检测</span>
          <span class="stage-meta">待命</span>
        </div>
        <div class="stage-item" data-step="3">
          <span class="stage-dot"></span>
          <span class="stage-label">控制台界面渲染</span>
          <span class="stage-meta">待命</span>
        </div>
      </div>
      <p class="hint" id="hintText">按已完成阶段实时推进启动进度</p>
    </div>
    <script>
      (() => {
        const fill = document.getElementById('progressFill');
        const progressValue = document.getElementById('progressValue');
        const statusText = document.getElementById('statusText');
        const hintText = document.getElementById('hintText');
        const stages = Array.from(document.querySelectorAll('.stage-item'));
        const statePresets = {
          idle: {
            state: 'idle',
            progress: 8,
            completedSteps: 0,
            activeStep: 0,
            status: '准备启动窗口',
            hint: '正在初始化桌面窗口与启动视图'
          },
          starting: {
            state: 'starting',
            progress: 28,
            completedSteps: 1,
            activeStep: 1,
            status: '正在启动本地服务',
            hint: '已完成 1 / 4 个启动阶段，正在装载本地服务选项'
          },
          checking: {
            state: 'checking',
            progress: 54,
            completedSteps: 2,
            activeStep: 2,
            status: '正在检测服务状态',
            hint: '已完成 2 / 4 个启动阶段，正在实时轮询本地服务'
          },
          rendering: {
            state: 'rendering',
            progress: 84,
            completedSteps: 3,
            activeStep: 3,
            status: '正在载入控制台界面',
            hint: '已完成 3 / 4 个启动阶段，正在加载已就绪的界面部分'
          },
          finishing: {
            state: 'finishing',
            progress: 100,
            completedSteps: 4,
            activeStep: -1,
            status: '即将进入 Entrance',
            hint: '启动阶段已完成，正在切换到主界面'
          },
          complete: {
            state: 'complete',
            progress: 100,
            completedSteps: 4,
            activeStep: -1,
            status: '即将进入 Entrance',
            hint: '启动阶段已完成，正在切换到主界面'
          }
        };
        let current = { ...statePresets.idle };
        let target = { ...current };
        let rafId = 0;
        let settleResolvers = [];

        const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));

        const resolveSettled = () => {
          if (settleResolvers.length === 0) {
            return;
          }
          const resolvers = settleResolvers;
          settleResolvers = [];
          for (const resolve of resolvers) {
            resolve(true);
          }
        };

        const render = (model) => {
          const percent = clamp(model.progress);
          document.body.dataset.state = model.state || 'idle';
          fill.style.width = String(percent) + '%';
          progressValue.textContent = String(Math.round(percent)).padStart(2, '0') + '%';
          statusText.textContent = model.status || '';
          hintText.textContent = model.hint || '';

          for (const [index, stage] of stages.entries()) {
            const meta = stage.querySelector('.stage-meta');
            const isDone = index < (model.completedSteps || 0);
            const isActive = index === model.activeStep;
            stage.classList.toggle('is-done', isDone);
            stage.classList.toggle('is-active', isActive);
            meta.textContent = isDone ? '完成' : isActive ? '进行中' : '待命';
          }
        };

        const animate = () => {
          const delta = clamp(target.progress) - clamp(current.progress);
          if (Math.abs(delta) <= 0.2) {
            current = { ...target, progress: clamp(target.progress) };
            render(current);
            rafId = 0;
            resolveSettled();
            return;
          }

          current = {
            ...target,
            progress: clamp(current.progress) + delta * 0.14
          };
          render(current);
          rafId = window.requestAnimationFrame(animate);
        };

        const waitForSettle = () => {
          if (!rafId) {
            return Promise.resolve(true);
          }
          return new Promise((resolve) => {
            settleResolvers.push(resolve);
          });
        };

        const setState = (update, options = {}) => {
          const input = typeof update === 'string' ? { state: update } : (update || {});
          const preset = input.state && statePresets[input.state] ? statePresets[input.state] : null;
          target = {
            ...(preset || target),
            ...input
          };
          if (typeof target.progress !== 'number') {
            target.progress = preset ? preset.progress : current.progress;
          }
          if (typeof target.completedSteps !== 'number') {
            target.completedSteps = preset ? preset.completedSteps : current.completedSteps;
          }
          if (typeof target.activeStep !== 'number') {
            target.activeStep = preset ? preset.activeStep : current.activeStep;
          }
          if (!target.status) {
            target.status = preset ? preset.status : current.status;
          }
          if (!target.hint) {
            target.hint = preset ? preset.hint : current.hint;
          }
          if (!rafId) {
            rafId = window.requestAnimationFrame(animate);
          }
          if (options.waitForSettle) {
            return waitForSettle();
          }
          return true;
        };

        render(current);
        window.__entranceDesktopStartup = { setState };

        requestAnimationFrame(() => {
          window.setTimeout(() => {
            if (current.state === 'idle' && target.state === 'idle') {
              setState('starting');
            }
          }, ${STARTUP_PROGRESS_BOOT_DELAY_MS});
        });
      })();
    </script>
  </body>
</html>`;

  try {
    return await safeLoadURL(win, `data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } catch (error) {
    if (!quitting) {
      console.error(`Failed to show waiting page: ${error.message}`);
    }
    return false;
  }
}

function startRetryLoop(win) {
  if (retryTimer !== null) {
    return;
  }

  let inFlight = false;
  let attemptCount = 0;

  const attemptLoad = () => {
    if (inFlight) {
      return;
    }

    attemptCount += 1;
    void setWaitingPageState(
      win,
      attemptCount === 1
        ? {
            state: 'starting',
            progress: 28,
            completedSteps: 1,
            activeStep: 1,
            status: '正在启动本地服务',
            hint: '已完成 1 / 4 个启动阶段，正在装载本地服务选项'
          }
        : {
            state: 'checking',
            progress: Math.min(76, 46 + (attemptCount - 2) * 8),
            completedSteps: 2,
            activeStep: 2,
            status: '正在检测服务状态',
            hint: '已完成 2 / 4 个启动阶段，正在实时轮询本地服务'
          }
    );

    inFlight = true;
    void (async () => {
      try {
        if (!isWindowUsable(win)) {
          stopRetryLoop();
          return;
        }

        const reachable = await isEntranceReachable();
        if (!reachable) {
          return;
        }

        await setWaitingPageState(win, {
          state: 'rendering',
          progress: 84,
          completedSteps: 3,
          activeStep: 3,
          status: '正在载入控制台界面',
          hint: '已完成 3 / 4 个启动阶段，正在加载已就绪的界面部分'
        });

        stopRetryLoop();

        try {
          const loaded = await loadEntranceWithStartupTransition(win);
          if (loaded) {
            return;
          }
        } catch (error) {
          if (!quitting) {
            console.warn(`Entrance load failed, showing waiting page: ${error.message}`);
          }
        }

        const waitingShown = await showWaitingPage(win);
        if (waitingShown) {
          startRetryLoop(win);
        }
      } catch (error) {
        if (!quitting) {
          console.error(`Retry loop error: ${error.message}`);
        }
      } finally {
        inFlight = false;
      }
    })();
  };

  attemptLoad();
  retryTimer = setInterval(attemptLoad, RETRY_INTERVAL_MS);
}

function lockToEntrance(win) {
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) {
      void safeLoadURL(win, url).catch((error) => {
        if (!quitting && isWindowUsable(win)) {
          console.warn(`Failed to open popup URL: ${error.message}`);
        }
      });
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

function createMainWindow() {
  const titleBarOptions = process.platform === 'darwin'
    ? {}
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: STARTUP_WINDOW_BACKGROUND,
          symbolColor: '#20242b',
          height: 32
        }
      };

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: STARTUP_WINDOW_BACKGROUND,
    show: false,
    ...titleBarOptions,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  });

  win.removeMenu();
  lockToEntrance(win);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  win.webContents.on('did-fail-load', (_event, _code, _desc, validatedURL, isMainFrame) => {
    void (async () => {
      if (!isMainFrame) {
        return;
      }
      if (!isAllowedNavigation(validatedURL)) {
        return;
      }
      if (!isWindowUsable(win)) {
        return;
      }

      const waitingShown = await showWaitingPage(win);
      if (waitingShown) {
        startRetryLoop(win);
      }
    })().catch((error) => {
      if (!quitting) {
        console.error(`did-fail-load handler error: ${error.message}`);
      }
    });
  });

  void showWaitingPage(win)
    .then((waitingShown) => {
      if (waitingShown) {
        startRetryLoop(win);
      }
    })
    .catch((error) => {
      if (!quitting) {
        console.error(`Failed to initialize waiting page: ${error.message}`);
      }
    });

  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  configureSerialPermissions();
  createMainWindow();
  startBackend();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}).catch((error) => {
  console.error(`Failed to initialize app: ${error.message}`);
  app.quit();
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
