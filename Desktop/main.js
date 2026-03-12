const { app, BrowserWindow, Menu, dialog, net, session, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, fork } = require('child_process');

const ENTRANCE_URL = process.env.ENTRANCE_URL || 'http://localhost:3000';
const ENTRANCE_ORIGIN = new URL(ENTRANCE_URL).origin;
const DESKTOP_HOMEPAGE = 'https://github.com/EntranceToolBox/Entrance-Desktop';
const RETRY_INTERVAL_MS = 2000;
const STARTUP_PROGRESS_BOOT_DELAY_MS = 180;
const STARTUP_PROGRESS_TRANSITION_MS = 520;
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

function openDesktopHomepage() {
  void shell.openExternal(DESKTOP_HOMEPAGE).catch((error) => {
    if (!quitting) {
      console.warn(`Failed to open desktop homepage: ${error.message}`);
    }
  });
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

async function showAboutDialog(browserWindow) {
  const detail = [
    `当前版本: ${app.getVersion()}`,
    `项目主页: ${DESKTOP_HOMEPAGE}`,
    '',
    '欢迎提交issue和pr'
  ].join('\n');

  try {
    const { response } = await dialog.showMessageBox(browserWindow, {
      type: 'info',
      title: 'About Entrance Desktop',
      message: 'Entrance Desktop',
      detail,
      buttons: ['打开项目主页', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    if (response === 0) {
      openDesktopHomepage();
    }
  } catch (error) {
    if (!quitting) {
      console.warn(`Failed to show about dialog: ${error.message}`);
    }
  }
}

function buildApplicationMenu() {
  const openAbout = () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const fallbackWindow = BrowserWindow.getAllWindows()[0] || null;
    void showAboutDialog(focusedWindow || fallbackWindow);
  };

  const template = [];

  if (process.platform === 'darwin') {
    template.push({
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: openAbout },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  template.push({
    label: 'About',
    submenu: [
      { label: 'Entrance Desktop', click: openAbout },
      { label: '项目主页', click: openDesktopHomepage },
      { type: 'separator' },
      { role: 'quit', label: '退出' }
    ]
  });

  if (process.platform !== 'darwin') {
    template.push({
      label: 'Window',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' }
      ]
    });
  }

  return Menu.buildFromTemplate(template);
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

async function setWaitingPageState(win, state) {
  if (!isWindowUsable(win)) {
    return false;
  }

  try {
    return await win.webContents.executeJavaScript(
      `(() => {
        const controller = window.__entranceDesktopStartup;
        if (!controller || typeof controller.setState !== 'function') {
          return false;
        }
        controller.setState(${JSON.stringify(state)});
        return true;
      })();`,
      true
    );
  } catch {
    return false;
  }
}

async function loadEntranceWithStartupTransition(win) {
  const waitingPageVisible = await setWaitingPageState(win, 'complete');
  if (waitingPageVisible) {
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
        color-scheme: dark;
        --bg-1: #0e131b;
        --bg-2: #131c28;
        --panel: rgba(14, 19, 27, 0.74);
        --border: rgba(130, 156, 194, 0.18);
        --text: #f5f8ff;
        --text-muted: rgba(245, 248, 255, 0.68);
        --track: rgba(255, 255, 255, 0.12);
        --fill-start: #7cc7ff;
        --fill-end: #2d8cff;
      }
      body {
        margin: 0;
        font-family: "Noto Sans", "Segoe UI", sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
        overflow: hidden;
        background:
          radial-gradient(circle at top, rgba(45, 140, 255, 0.18), transparent 36%),
          linear-gradient(160deg, var(--bg-1), var(--bg-2));
        color: var(--text);
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background:
          radial-gradient(circle at 20% 20%, rgba(124, 199, 255, 0.12), transparent 28%),
          radial-gradient(circle at 80% 78%, rgba(45, 140, 255, 0.12), transparent 22%);
        pointer-events: none;
      }
      .card {
        width: min(360px, calc(100vw - 48px));
        padding: 36px 28px 28px;
        border-radius: 24px;
        border: 1px solid var(--border);
        background: var(--panel);
        backdrop-filter: blur(22px);
        box-shadow: 0 28px 80px rgba(0, 0, 0, 0.34);
        text-align: center;
        transform: translateY(0) scale(1);
        opacity: 1;
        transition: transform ${STARTUP_PROGRESS_TRANSITION_MS}ms ease, opacity ${STARTUP_PROGRESS_TRANSITION_MS}ms ease;
      }
      body[data-state="complete"] .card {
        transform: translateY(-8px) scale(1.02);
      }
      .logo-wrap {
        width: 132px;
        height: 132px;
        margin: 0 auto 20px;
        display: grid;
        place-items: center;
        border-radius: 28px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
      }
      .logo {
        width: 96px;
        height: 96px;
        object-fit: contain;
        filter: drop-shadow(0 8px 14px rgba(0, 0, 0, 0.18));
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
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      .progress {
        position: relative;
        height: 10px;
        border-radius: 999px;
        overflow: hidden;
        background: var(--track);
      }
      .progress-fill {
        position: relative;
        height: 100%;
        width: 0%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--fill-start), var(--fill-end));
        box-shadow: 0 0 18px rgba(45, 140, 255, 0.4);
        transition: width ${STARTUP_PROGRESS_TRANSITION_MS}ms cubic-bezier(.22,.61,.36,1);
      }
      .progress-fill::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.46), transparent);
        transform: translateX(-100%);
        animation: shine 1.8s ease-in-out infinite;
      }
      .hint {
        margin: 14px 0 0;
        font-size: 13px;
        color: var(--text-muted);
      }
      @keyframes shine {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(220%); }
      }
    </style>
  </head>
  <body data-state="idle">
    <div class="card">
      <div class="logo-wrap">
        <img class="logo" src="${logoSrc}" alt="Entrance Desktop logo" />
      </div>
      <h1 class="title">Entrance</h1>
      <p class="status">Starting...</p>
      <div class="progress" aria-hidden="true">
        <div class="progress-fill" id="progressFill"></div>
      </div>
      <p class="hint">Waiting for the local Entrance service to become ready</p>
    </div>
    <script>
      (() => {
        const fill = document.getElementById('progressFill');
        const states = {
          idle: '0%',
          starting: '50%',
          complete: '100%'
        };

        const setState = (state) => {
          if (!states[state]) {
            return;
          }
          document.body.dataset.state = state;
          fill.style.width = states[state];
        };

        window.__entranceDesktopStartup = { setState };

        requestAnimationFrame(() => {
          window.setTimeout(() => {
            setState('starting');
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

  retryTimer = setInterval(() => {
    if (inFlight) {
      return;
    }

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

async function openEntrance(win) {
  if (!isWindowUsable(win)) {
    return;
  }

  try {
    const reachable = await isEntranceReachable();
    if (reachable) {
      try {
        const loaded = await loadEntranceWithStartupTransition(win);
        if (loaded) {
          return;
        }
      } catch (error) {
        if (!quitting) {
          console.warn(`Initial load failed, falling back to waiting page: ${error.message}`);
        }
      }
    }

    const waitingShown = await showWaitingPage(win);
    if (waitingShown) {
      startRetryLoop(win);
    }
  } catch (error) {
    if (!quitting) {
      console.error(`Failed to open Entrance: ${error.message}`);
    }
  }
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  });

  lockToEntrance(win);

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

  void openEntrance(win);
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildApplicationMenu());
  configureSerialPermissions();
  startBackend();
  createMainWindow();

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
