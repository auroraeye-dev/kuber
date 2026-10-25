// KUBER — native macOS window for the local KUBER engine (http://127.0.0.1:8777).
// The engine and the local AI run as login services (launchd); this app only shows them. It never loads any other
// site: links to other hosts open in your default browser.
import AppKit
import WebKit
import UserNotifications

let ENGINE = URL(string: "http://127.0.0.1:8777/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var retries = 0

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        ensureServices()
        // ask once (macOS shows "KUBER would like to send notifications"); the engine's alerts then carry KUBER's logo
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()                      // keeps the PIN session cookie between launches
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = true
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "KUBER"
        window.minSize = NSSize(width: 820, height: 560)
        window.contentView = web
        window.setFrameAutosaveName("KUBER.main")
        if !window.setFrameUsingName("KUBER.main") { window.center() }
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }

    // start the launchd services if they aren't loaded (e.g. after `stop.command`)
    func ensureServices() {
        let uid = getuid(), home = FileManager.default.homeDirectoryForCurrentUser.path
        for svc in ["engine", "ollama"] {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            p.arguments = ["print", "gui/\(uid)/com.kuber.\(svc)"]; p.standardOutput = nil; p.standardError = nil
            try? p.run(); p.waitUntilExit()
            if p.terminationStatus != 0 {
                let b = Process(); b.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                b.arguments = ["bootstrap", "gui/\(uid)", "\(home)/Library/LaunchAgents/com.kuber.\(svc).plist"]
                try? b.run(); b.waitUntilExit()
            }
        }
    }

    func load() { web.load(URLRequest(url: ENGINE, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)) }

    // engine still starting: show a quiet waiting page and retry
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        retries += 1
        let msg = retries < 40 ? "Starting the KUBER engine…" : "The KUBER engine isn't responding. Open Terminal and run: launchctl kickstart -k gui/$(id -u)/com.kuber.engine"
        w.loadHTMLString("<html><body style='font:15px -apple-system;background:#0f1217;color:#9aa4b2;display:grid;place-items:center;height:95vh'><div>\(msg)</div></body></html>", baseURL: nil)
        if retries < 40 { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.load() } }
    }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { if w.url?.host == "127.0.0.1" { retries = 0 } }

    // only KUBER itself loads inside the window; everything else goes to the default browser
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = a.request.url else { return decisionHandler(.cancel) }
        if u.scheme == "about" || (u.host == "127.0.0.1" && u.port == 8777) { return decisionHandler(.allow) }
        if ["http", "https", "mailto"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
        decisionHandler(.cancel)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }   // target=_blank links
        return nil
    }
    // JavaScript alert/confirm used by a few buttons
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel"); completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows v: Bool) -> Bool { if !v { window.makeKeyAndOrderFront(nil) }; return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

    @objc func reload(_ s: Any?) { web.reload() }
    @objc func home(_ s: Any?) { web.load(URLRequest(url: ENGINE)) }
    @objc func zoomIn(_ s: Any?) { web.pageZoom = min(2, web.pageZoom + 0.1) }
    @objc func zoomOut(_ s: Any?) { web.pageZoom = max(0.6, web.pageZoom - 0.1) }
    @objc func zoomReset(_ s: Any?) { web.pageZoom = 1 }
    @objc func openFolder(_ s: Any?) { NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("KUBER")) }
    @objc func lock(_ s: Any?) { web.evaluateJavaScript("fetch('/api/logout',{method:'POST'}).then(()=>location.replace('/login'))") }

    func buildMenu() {
        let main = NSMenu()
        func item(_ t: String, _ a: Selector?, _ k: String, _ m: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem { let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = m; if let target { i.target = target }; return i }
        let app = NSMenu(); app.addItem(item("About KUBER", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""))
        app.addItem(.separator()); app.addItem(item("Lock KUBER", #selector(lock(_:)), "l", [.command, .shift], target: self))
        app.addItem(item("Open KUBER Folder", #selector(openFolder(_:)), "", target: self)); app.addItem(.separator())
        app.addItem(item("Hide KUBER", #selector(NSApplication.hide(_:)), "h")); app.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        app.addItem(.separator()); app.addItem(item("Quit KUBER (recording continues)", #selector(NSApplication.terminate(_:)), "q"))
        let edit = NSMenu(title: "Edit")
        for (t, s, k) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] { edit.addItem(item(t, Selector(s), k)) }
        let view = NSMenu(title: "View")
        view.addItem(item("Overview", #selector(home(_:)), "1", target: self)); view.addItem(item("Reload", #selector(reload(_:)), "r", target: self))
        view.addItem(.separator()); view.addItem(item("Zoom In", #selector(zoomIn(_:)), "+", target: self)); view.addItem(item("Zoom Out", #selector(zoomOut(_:)), "-", target: self)); view.addItem(item("Actual Size", #selector(zoomReset(_:)), "0", target: self))
        view.addItem(.separator()); view.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        let win = NSMenu(title: "Window"); win.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")); win.addItem(item("Close", #selector(NSWindow.performClose(_:)), "w"))
        for (t, m) in [("KUBER", app), ("Edit", edit), ("View", view), ("Window", win)] { let i = NSMenuItem(title: t, action: nil, keyEquivalent: ""); i.submenu = m; main.addItem(i) }
        NSApp.mainMenu = main; NSApp.windowsMenu = win
    }
}

// Alert mode, used by the engine: `KUBER --notify <title> <message>` posts one notification under KUBER's own name
// and icon (instead of Script Editor's, which is what osascript shows), then quits. No window, no Dock icon.
if let i = CommandLine.arguments.firstIndex(of: "--notify"), CommandLine.arguments.count > i + 2 {
    let title = CommandLine.arguments[i + 1], body = CommandLine.arguments[i + 2]
    NSApplication.shared.setActivationPolicy(.prohibited)
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound]) { ok, err in
        guard ok else { FileHandle.standardError.write("KUBER notify: not allowed \(err.map { "\($0)" } ?? "")\n".data(using: .utf8)!); exit(2) }   // notifications off for KUBER in System Settings
        let n = UNMutableNotificationContent(); n.title = title; n.body = body; n.sound = .default
        center.add(UNNotificationRequest(identifier: UUID().uuidString, content: n, trigger: nil)) { err in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(err == nil ? 0 : 1) }
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 120) { exit(3) }   // never linger (e.g. permission prompt unanswered)
    NSApplication.shared.run()
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
