#include "../runtime.hpp"
#include <windows.h>
#include <dwmapi.h>
#include <shlobj.h>
#include "callback.hpp"
#include <WebView2.h>
#include <stdexcept>

using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;
namespace {
constexpr UINT beginStartup = WM_APP + 1;
HWND frame;
HWND label;
HANDLE process;
HANDLE job;
HANDLE reader;
ComPtr<ICoreWebView2Controller> controller;
ComPtr<ICoreWebView2> browser;
std::wstring entry;
std::wstring origin;
std::string received;
bool closing = false;

fs::path folder(REFKNOWNFOLDERID id) {
    PWSTR path = nullptr;
    if (FAILED(SHGetKnownFolderPath(id, 0, nullptr, &path))) throw std::runtime_error("User folder unavailable");
    fs::path result(path);
    CoTaskMemFree(path);
    return result;
}

void showError(const wchar_t *message) {
    KillTimer(frame, 1);
    if (controller) controller->put_IsVisible(FALSE);
    SetWindowTextW(label, message);
    ShowWindow(label, SW_SHOW);
}

void navigate() {
    if (!browser || entry.empty()) return;
    origin = entry.substr(0, entry.find(L'/', entry.find(L"://") + 3));
    ShowWindow(label, SW_HIDE);
    if (FAILED(browser->Navigate(entry.c_str()))) showError(L"Could not open Entrance.");
}

void resize() {
    RECT rect{};
    GetClientRect(frame, &rect);
    if (controller) controller->put_Bounds(rect);
    if (label) MoveWindow(label, 0, rect.bottom / 2, rect.right, 40, TRUE);
}

void createBrowser() {
    const fs::path profile = folder(FOLDERID_LocalAppData) / L"Entrance Desktop/WebView2";
    const HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, profile.c_str(), nullptr,
        makeHandler<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
        +[](HRESULT hr, ICoreWebView2Environment *env) -> HRESULT {
            if (closing) return S_OK;
            if (FAILED(hr) || !env) {
                showError(L"WebView2 initialization failed. Install the Microsoft Edge WebView2 Runtime.");
                return S_OK;
            }
            HRESULT created = env->CreateCoreWebView2Controller(frame,
                makeHandler<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                    IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
                +[](HRESULT hr, ICoreWebView2Controller *result) -> HRESULT {
                    if (closing) return S_OK;
                    if (FAILED(hr) || !result || FAILED(result->get_CoreWebView2(&browser))) {
                        showError(L"Could not create the WebView2 window.");
                        return S_OK;
                    }
                    controller = result;
                    EventRegistrationToken token{};
                    browser->add_NavigationStarting(makeHandler<ICoreWebView2NavigationStartingEventHandler>(
                            IID_ICoreWebView2NavigationStartingEventHandler,
                        +[](ICoreWebView2 *, ICoreWebView2NavigationStartingEventArgs *event) -> HRESULT {
                            LPWSTR uri = nullptr;
                            event->get_Uri(&uri);
                            std::wstring value(uri ? uri : L"");
                            CoTaskMemFree(uri);
                            if (origin.empty() || value.compare(0, origin.size() + 1, origin + L"/") != 0)
                                event->put_Cancel(TRUE);
                            return S_OK;
                        }).Get(), &token);
                    browser->add_NewWindowRequested(makeHandler<ICoreWebView2NewWindowRequestedEventHandler>(
                            IID_ICoreWebView2NewWindowRequestedEventHandler,
                        +[](ICoreWebView2 *view, ICoreWebView2NewWindowRequestedEventArgs *event) -> HRESULT {
                            event->put_Handled(TRUE);
                            LPWSTR uri = nullptr;
                            event->get_Uri(&uri);
                            if (uri && std::wstring(uri).find(origin + L"/") == 0) view->Navigate(uri);
                            CoTaskMemFree(uri);
                            return S_OK;
                        }).Get(), &token);
                    resize();
                    navigate();
                    return S_OK;
                }).Get());
            if (FAILED(created)) showError(L"Could not create the WebView2 controller.");
            return S_OK;
        }).Get());
    if (FAILED(hr)) showError(L"Install the Microsoft Edge WebView2 Runtime to run Entrance Desktop.");
}

void startBackend() {
    if (_wgetenv(L"ENTRANCE_AUTOSTART") && std::wstring(_wgetenv(L"ENTRANCE_AUTOSTART")) == L"0") {
        const wchar_t *url = _wgetenv(L"ENTRANCE_URL");
        entry = url ? url : L"http://127.0.0.1:3000/";
        return;
    }
    wchar_t module[32768];
    if (!GetModuleFileNameW(nullptr, module, 32768)) throw std::runtime_error("Executable path unavailable");
    const desktop::Runtime runtime = desktop::runtime(module);
    if (!_wgetenv(L"ENTRANCE_DATA_DIR")) {
        const fs::path dir = folder(FOLDERID_RoamingAppData) / L"entrance-desktop/backend-data";
        SetEnvironmentVariableW(L"ENTRANCE_DATA_DIR", dir.c_str());
    }
    job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        throw std::runtime_error("Could not manage backend process");
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE writer = nullptr;
    if (!CreatePipe(&reader, &writer, &security, 0)) throw std::runtime_error("Could not create backend pipe");
    SetHandleInformation(reader, HANDLE_FLAG_INHERIT, 0);
    HANDLE nullDevice = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                     &security, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = writer;
    startup.hStdError = nullDevice;
    startup.hStdInput = nullDevice;
    PROCESS_INFORMATION child{};
    std::wstring command = L"\"" + runtime.node.wstring() + L"\" \"" + runtime.adapter.wstring() +
                           L"\" \"" + runtime.backend.wstring() + L"\"";
    BOOL spawned = CreateProcessW(runtime.node.c_str(), command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, runtime.backend.c_str(), &startup, &child);
    CloseHandle(writer);
    if (nullDevice != INVALID_HANDLE_VALUE) CloseHandle(nullDevice);
    if (!spawned) throw std::runtime_error("Could not launch Node.js");
    process = child.hProcess;
    if (!AssignProcessToJobObject(job, process) || ResumeThread(child.hThread) == DWORD(-1)) {
        TerminateProcess(process, 1);
        CloseHandle(child.hThread);
        throw std::runtime_error("Could not start managed backend");
    }
    CloseHandle(child.hThread);
    SetTimer(frame, 1, 100, nullptr);
}

void pollBackend() {
    if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
        showError(L"Entrance backend stopped. Check its dependencies and port.");
        return;
    }
    if (!entry.empty()) return;
    DWORD available = 0;
    if (!PeekNamedPipe(reader, nullptr, 0, nullptr, &available, nullptr) || !available) return;
    char buffer[256];
    DWORD count = 0;
    if (!ReadFile(reader, buffer, sizeof(buffer), &count, nullptr)) return;
    received.append(buffer, count);
    std::size_t end = received.find('\n');
    if (end == std::string::npos && received.size() < 1024) return;
    if (received.find("http://127.0.0.1:") != 0 || end == std::string::npos) {
        showError(L"Invalid response from Entrance backend.");
        return;
    }
    entry.assign(received.begin(), received.begin() + end);
    navigate();
}

LRESULT CALLBACK handle(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
    switch (message) {
        case beginStartup:
            try {
                startBackend();
                createBrowser();
            } catch (const std::exception &error) {
                MessageBoxA(hwnd, error.what(), "Entrance Desktop", MB_ICONERROR);
                DestroyWindow(hwnd);
            }
            return 0;
        case WM_SIZE: if (frame) resize(); return 0;
        case WM_SETFOCUS: if (controller) controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC); return 0;
        case WM_TIMER: pollBackend(); return 0;
        case WM_DESTROY:
            closing = true;
            if (controller) controller->Close();
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, message, w, l);
}
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    WNDCLASSW wc{};
    wc.lpfnWndProc = handle;
    wc.hInstance = instance;
    wc.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
    wc.lpszClassName = L"EntranceDesktop";
    RegisterClassW(&wc);
    frame = CreateWindowW(wc.lpszClassName, L"Entrance Desktop", WS_OVERLAPPEDWINDOW,
                          CW_USEDEFAULT, CW_USEDEFAULT, 1280, 800, nullptr, nullptr, instance, nullptr);
    if (!frame) { CoUninitialize(); return 1; }
    // Windows 11 22H2+ draws Mica in the non-client frame. Older DWM keeps its system frame.
    const DWORD mica = 2; // DWMSBT_MAINWINDOW
    DwmSetWindowAttribute(frame, 38 /* DWMWA_SYSTEMBACKDROP_TYPE */, &mica, sizeof(mica));
    label = CreateWindowW(L"STATIC", L"Starting Entrance…", WS_CHILD | WS_VISIBLE | SS_CENTER,
                          0, 0, 1, 1, frame, nullptr, instance, nullptr);
    resize();
    ShowWindow(frame, show);
    RedrawWindow(frame, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW);
    PostMessageW(frame, beginStartup, 0, 0);
    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    browser.Reset();
    controller.Reset();
    if (job) CloseHandle(job);
    if (reader) CloseHandle(reader);
    if (process) CloseHandle(process);
    CoUninitialize();
    return 0;
}
