const { spawn } = require('child_process');
const path = require('path');
const { version } = require('./package.json');

function computeLinuxOzoneHint(env) {
  const hint = String(
    env.ENTRANCE_OZONE_PLATFORM_HINT || env.ELECTRON_OZONE_PLATFORM_HINT || 'auto'
  )
    .trim()
    .toLowerCase();

  return hint || 'auto';
}

const electronBinary = require('electron');
const appDir = path.resolve(__dirname);
const env = { ...process.env };
const args = [appDir];

if (!env.ENTRANCE_DESKTOP_VERSION && version) {
  env.ENTRANCE_DESKTOP_VERSION = version;
}

if (process.platform === 'linux') {
  const hint = computeLinuxOzoneHint(env);
  env.ELECTRON_OZONE_PLATFORM_HINT = hint;

  if (env.ENTRANCE_DEBUG_OZONE === '1') {
    console.log(
      `[launcher] hint=${hint} wayland_display=${env.WAYLAND_DISPLAY || ''} xdg_session_type=${
        env.XDG_SESSION_TYPE || ''
      } display=${env.DISPLAY || ''}`
    );
  }

  if (hint === 'wayland') {
    args.push('--ozone-platform=wayland');
    args.push('--enable-features=UseOzonePlatform,WaylandWindowDecorations');
  } else if (hint === 'x11') {
    args.push('--ozone-platform=x11');
  } else {
    args.push(`--ozone-platform-hint=${hint}`);
  }
}

const child = spawn(electronBinary, args, {
  stdio: 'inherit',
  env
});

child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
