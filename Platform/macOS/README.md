# Entrance Desktop for macOS

The Swift client opens Entrance in a WKWebView inside an AppKit window. It starts Node.js with the shared desktop adapter, reads a one-time loopback URL from its private pipe and stops the child process when the app quits. Backend data lives under the user's Application Support directory. An existing desktop profile or an explicit `ENTRANCE_DATA_DIR` takes precedence. For local serial devices, select the server-side serial mode. WKWebView uses the bundled backend for serial access.

## Development

Install Node.js and the Xcode Command Line Tools. From the repository root run `npm run install:all` and then `npm start`. Set `PORT` to change the backend port (default 3000). To open an existing frontend, set `ENTRANCE_AUTOSTART=0` and `ENTRANCE_URL`.

## Packaging

Run `npm run dist:darwin` to build the Intel and Apple Silicon archives together. On macOS, `npm run dist` does the same thing and `npm run pack` creates an unpacked app for the host architecture. Both ZIPs contain an app with its own Node.js runtime and locked backend dependencies. The runtime requires macOS 13.5 or newer. Extract the appropriate ZIP and drag the app to Applications.

- `Desktop/dist/Entrance-Desktop-<version>-macOS-x86_64.zip`
- `Desktop/dist/Entrance-Desktop-<version>-macOS-arm64.zip`

For a Linux cross-build, install Swift with Darwin target support, a compatible macOS SDK containing Swift module interfaces, LLVM's Mach-O linker and `llvm-lipo`, `rcodesign`, `curl`, `tar` and `zip`. Set `MACOS_SDKROOT` or `SDKROOT` to the SDK directory. Use `LD64_LLD` and `RCODESIGN` to select specific tool binaries if needed. The build also looks for `rcodesign` under `Platform/build/macos/tools/`.

The first build downloads the official Node archives and checks their SHA-256 digests. Completed apps carry an ad hoc signature. Developer ID signing and Apple notarization require a separate release step.
