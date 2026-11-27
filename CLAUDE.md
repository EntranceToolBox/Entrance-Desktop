# Entrance-Desktop Notes

## Repository Layout
- `Entrance/`: backend submodule. Keep this folder name exactly as `Entrance`.
- `Platform/`: Linux, Windows and macOS desktop clients.
- `Share/Linux/`: Linux desktop icons and `.desktop` files.
- `Share/Windows/`: Windows icons and shortcut assets.

## Startup Model
- Root `npm start` dispatches to the host platform via `Platform/build.js`.
- macOS uses Swift, AppKit and WKWebView with `Platform/macOS/main.swift`.
- Linux uses GTK4, libadwaita and WebKitGTK. Windows uses Win32 and WebView2.
- The native clients start Node.js with `Platform/backend.cjs`, which loads the Entrance backend, and wait for its startup URL on a private pipe.
- `Entrance/start.sh` is for running the backend submodule independently.

## Collaboration Preference
When the user provides a numbered list of requirements such as `1.` and `2.`, first reply with the implementation plan and wait for approval before making changes.
