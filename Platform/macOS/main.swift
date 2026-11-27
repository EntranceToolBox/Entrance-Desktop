import AppKit
import WebKit

@main
@MainActor
final class Desktop: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private let window = NSWindow(contentRect: NSMakeRect(0, 0, 1280, 800),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered, defer: false)
    private let browser = WKWebView()
    private let status = NSTextField(wrappingLabelWithString: "Starting Entrance…")
    private var entry: URL?
    private var backend: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenu()
        menu.addItem(withTitle: "Entrance Desktop", action: nil, keyEquivalent: "").submenu = appMenu
        appMenu.addItem(withTitle: "Quit Entrance Desktop", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenu(title: "Edit")
        menu.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = edit
        for (title, key) in [("Cut", "x"), ("Copy", "c"), ("Paste", "v"), ("Select All", "a")] {
            let action = title == "Select All" ? "selectAll:" : title.lowercased() + ":"
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        NSApp.mainMenu = menu
        window.title = "Entrance Desktop"
        window.isReleasedWhenClosed = false
        let content = NSView()
        window.contentView = content
        browser.navigationDelegate = self
        browser.uiDelegate = self
        browser.frame = content.bounds
        browser.autoresizingMask = [.width, .height]
        content.addSubview(browser)
        status.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(status)
        NSLayoutConstraint.activate([status.centerXAnchor.constraint(equalTo: content.centerXAnchor),
                                     status.centerYAnchor.constraint(equalTo: content.centerYAnchor),
                                     status.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -48)])
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        start()
    }

    private func showStatus(_ message: String) {
        browser.isHidden = true
        status.stringValue = message
        status.isHidden = false
    }

    private func open(_ url: URL) {
        entry = url
        browser.load(URLRequest(url: url))
    }

    private func start() {
        var env = ProcessInfo.processInfo.environment
        showStatus("Starting Entrance…")
        if env["ENTRANCE_AUTOSTART"] == "0" {
            guard let url = URL(string: env["ENTRANCE_URL"] ?? "http://127.0.0.1:3000"),
                  ["http", "https"].contains(url.scheme), url.host != nil else {
                showStatus("ENTRANCE_URL must be an HTTP or HTTPS URL.")
                return
            }
            open(url)
            return
        }

        // The development launcher supplies paths. Finder launches the self-contained bundle.
        let resources = Bundle.main.resourceURL!
        let arguments = CommandLine.arguments
        let developing = arguments.count == 5 && arguments[1] == "--development"
        let node = developing ? URL(fileURLWithPath: arguments[2]) :
            Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node")
        let adapter = developing ? URL(fileURLWithPath: arguments[3]) : resources.appendingPathComponent("backend.cjs")
        let directory = developing ? URL(fileURLWithPath: arguments[4]) : resources.appendingPathComponent("Entrance")
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        // Preserve profiles from both the packaged app and the development launcher.
        let profile = ["entrance-desktop/backend-data", "Entrance Desktop/backend-data"]
            .first { FileManager.default.fileExists(atPath: support.appendingPathComponent($0).path) }
        env["ENTRANCE_DATA_DIR"] = env["ENTRANCE_DATA_DIR"] ?? support.appendingPathComponent(profile ?? "entrance-desktop/backend-data").path

        if env["ENTRANCE_DESKTOP_VERSION"] == nil {
            env["ENTRANCE_DESKTOP_VERSION"] = Bundle.main.object(forInfoDictionaryKey: "EntranceDesktopVersion") as? String
        }
        let child = Process()
        let pipe = Pipe()
        child.executableURL = node
        child.arguments = [adapter.path, directory.path, "--parent-pipe"]
        child.standardInput = Pipe()
        child.currentDirectoryURL = directory
        child.environment = env
        child.standardOutput = pipe
        child.terminationHandler = { [weak self] stopped in
            DispatchQueue.main.async {
                guard let self = self, self.backend === stopped else { return }
                self.backend = nil
                self.showStatus("Entrance backend stopped (exit \(stopped.terminationStatus)). Check whether the configured port is already in use.")
            }
        }
        do {
            try child.run()
            backend = child
        } catch {
            showStatus("Could not start Entrance: " + error.localizedDescription)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            var data = Data()
            let reader = pipe.fileHandleForReading
            while data.count < 4096 && !data.contains(10) {
                let chunk = reader.availableData
                if chunk.isEmpty { break }
                data.append(chunk)
            }
            let line = String(data: data.prefix(while: { $0 != 10 }), encoding: .utf8)
            DispatchQueue.main.async {
                guard self.backend === child else { return }
                guard let line = line, let url = URL(string: line), url.scheme == "http",
                      url.host == "127.0.0.1", url.port != nil, url.path.count > 1 else {
                    self.showStatus("Entrance did not send a valid startup URL.")
                    return
                }
                self.open(url)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        if let child = backend, child.isRunning {
            child.terminate()
            child.waitUntilExit()
        }
    }

    private func sameOrigin(_ url: URL?) -> Bool {
        guard let url = url, let entry = entry else { return false }
        let defaultPort = entry.scheme == "https" ? 443 : 80
        return url.scheme == entry.scheme && url.host == entry.host &&
               (url.port ?? defaultPort) == (entry.port ?? defaultPort)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if action.shouldPerformDownload && (sameOrigin(url) ||
            (url?.scheme == "blob" && sameOrigin(action.sourceFrame.request.url))) {
            decisionHandler(.download)
        } else if sameOrigin(url) {
            if action.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(action.request)
            } else {
                decisionHandler(.allow)
            }
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard sameOrigin(response.response.url) else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        status.isHidden = true
        browser.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showStatus(error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.url : nil) }
    }

    static func main() {
        let app = NSApplication.shared
        let desktop = Desktop()
        app.setActivationPolicy(.regular)
        app.delegate = desktop
        withExtendedLifetime(desktop) { app.run() }
    }
}
