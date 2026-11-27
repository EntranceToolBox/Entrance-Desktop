**Repository Layout Plan**
1. Use `https://github.com/fcanlnony/Entrance` as a git submodule.
2. Clone the backend as a submodule and keep the folder name exactly `Entrance` (do not rename it).
3. Place the desktop implementations in `Platform/macOS`, `Platform/Windows`, and `Platform/Linux`.
4. Create a top-level folder named `Share`.
5. Use `Share/Linux` for desktop icons and `.desktop` files.
6. Use `Share/Windows` for desktop icons and Windows shortcuts/assets.

## Startup Model
- Root `npm start` dispatches to the host platform via `Platform/build.js`.
- macOS uses Swift, AppKit and WKWebView with `Platform/macOS/main.swift`.
- Linux uses GTK4, libadwaita and WebKitGTK. Windows uses Win32 and WebView2.
- The native clients start Node.js with `Platform/backend.cjs`, which loads the Entrance backend, and wait for its startup URL on a private pipe.
- `Entrance/start.sh` is for running the backend submodule independently.

## Collaboration Preference
When the user provides a numbered list of requirements such as `1.` and `2.`, first reply with the implementation plan and wait for approval before making changes.
