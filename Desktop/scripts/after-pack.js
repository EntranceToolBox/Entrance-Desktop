const fs = require('fs/promises');
const path = require('path');

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') {
    return;
  }

  const executableName = context.packager && context.packager.executableName;
  if (!executableName) {
    return;
  }

  const appOutDir = context.appOutDir;
  const launcherPath = path.join(appOutDir, executableName);
  const binaryPath = path.join(appOutDir, `${executableName}.bin`);

  if (await pathExists(binaryPath)) {
    return;
  }

  let launcherStat;
  try {
    launcherStat = await fs.stat(launcherPath);
  } catch {
    return;
  }

  if (!launcherStat.isFile()) {
    return;
  }

  await fs.rename(launcherPath, binaryPath);
  await fs.chmod(binaryPath, 0o755);

  const wrapperScript = `#!/usr/bin/env bash
set -euo pipefail

has_switch() {
  local switch_name="\$1"
  shift
  local arg
  for arg in "\$@"; do
    if [[ "\${arg}" == "\${switch_name}" || "\${arg}" == "\${switch_name}="* ]]; then
      return 0
    fi
  done
  return 1
}

has_wayland=0
if [[ -n "\${WAYLAND_DISPLAY:-}" && -n "\${XDG_RUNTIME_DIR:-}" ]]; then
  if [[ -S "\${XDG_RUNTIME_DIR}/\${WAYLAND_DISPLAY}" ]]; then
    has_wayland=1
  fi
fi

has_x11=0
if [[ -n "\${DISPLAY:-}" ]]; then
  if [[ "\${DISPLAY}" == :* || "\${DISPLAY}" == unix:* ]]; then
    x_display="\${DISPLAY#unix:}"
    x_display="\${x_display#:}"
    x_display="\${x_display%%.*}"
    if [[ -S "/tmp/.X11-unix/X\${x_display}" ]]; then
      has_x11=1
    fi
  else
    # For forwarded/remote displays (e.g. localhost:10.0), rely on DISPLAY presence.
    has_x11=1
  fi
fi

if [[ "\${has_wayland}" -eq 0 && "\${has_x11}" -eq 0 ]]; then
  echo "[Entrance Desktop] No usable graphical session detected." >&2
  echo "Please run this app from a desktop session (Wayland or X11)." >&2
  echo "XDG_SESSION_TYPE=\${XDG_SESSION_TYPE:-<empty>} DISPLAY=\${DISPLAY:-<empty>} WAYLAND_DISPLAY=\${WAYLAND_DISPLAY:-<empty>} XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-<empty>}" >&2
  echo "If you are using SSH, connect with -X/-Y or run this app locally." >&2
  exit 1
fi

requested_hint="<arg>"
extra_args=()

if ! has_switch "--no-sandbox" "\$@" && ! has_switch "--enable-sandbox" "\$@"; then
  extra_args+=("--no-sandbox")
fi

if ! has_switch "--ozone-platform" "\$@" && ! has_switch "--ozone-platform-hint" "\$@"; then
  requested_hint="\${ENTRANCE_OZONE_PLATFORM_HINT:-\${ELECTRON_OZONE_PLATFORM_HINT:-auto}}"
  requested_hint="\$(printf '%s' "\${requested_hint}" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "\${requested_hint}" ]]; then
    requested_hint="auto"
  fi

  selected_hint="\${requested_hint}"
  if [[ "\${selected_hint}" == "auto" ]]; then
    if [[ "\${has_wayland}" -eq 1 ]]; then
      selected_hint="wayland"
    elif [[ "\${has_x11}" -eq 1 ]]; then
      selected_hint="x11"
    fi
  fi

  case "\${selected_hint}" in
    wayland)
      extra_args+=(
        "--enable-features=UseOzonePlatform,WaylandWindowDecorations"
        "--ozone-platform=wayland"
        "--ozone-platform-hint=wayland"
      )
      ;;
    x11)
      extra_args+=(
        "--ozone-platform=x11"
        "--ozone-platform-hint=x11"
      )
      ;;
    *)
      extra_args+=("--ozone-platform-hint=auto")
      ;;
  esac
fi

if [[ "\${ENTRANCE_DEBUG_OZONE:-0}" == "1" ]]; then
  echo "[launcher] requested_hint=\${requested_hint} has_wayland=\${has_wayland} has_x11=\${has_x11} args=\${extra_args[*]:-<none>}" >&2
fi

exec "\$(dirname "\$0")/${executableName}.bin" "\${extra_args[@]}" "\$@"
`;

  await fs.writeFile(launcherPath, wrapperScript, { mode: 0o755 });
};
