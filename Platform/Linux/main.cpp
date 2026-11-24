#include "../runtime.hpp"
#include <adwaita.h>
#include <webkit/webkit.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <csignal>

namespace {
struct Window {
    GtkWindow *window = nullptr;
    GtkWidget *stack = nullptr;
    GtkLabel *status = nullptr;
    WebKitWebView *view = nullptr;
    GSubprocess *child = nullptr;
    std::string origin;
    bool closing = false;
};

void status(Window *state, const char *message) {
    if (state->closing) return;
    gtk_label_set_text(state->status, message);
    gtk_stack_set_visible_child_name(GTK_STACK(state->stack), "status");
}

void open(Window *state, const char *url) {
    state->origin = desktop::origin(url);
    gtk_stack_set_visible_child_name(GTK_STACK(state->stack), "browser");
    webkit_web_view_load_uri(state->view, url);
}

gboolean decide(WebKitWebView *, WebKitPolicyDecision *decision,
                WebKitPolicyDecisionType type, gpointer data) {
    if (type == WEBKIT_POLICY_DECISION_TYPE_RESPONSE) return FALSE;
    WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(
        WEBKIT_NAVIGATION_POLICY_DECISION(decision));
    const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
    Window *state = static_cast<Window *>(data);
    if (uri && desktop::origin(uri) == state->origin) {
        if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) return FALSE;
        webkit_web_view_load_uri(state->view, uri);
    }
    webkit_policy_decision_ignore(decision);
    return TRUE;
}

void ready(GObject *stream, GAsyncResult *result, gpointer data) {
    Window *state = static_cast<Window *>(data);
    GError *error = nullptr;
    gchar *line = g_data_input_stream_read_line_finish(G_DATA_INPUT_STREAM(stream), result, nullptr, &error);
    if (!state->closing && line && g_str_has_prefix(line, "http://127.0.0.1:")) open(state, line);
    else status(state, error ? error->message : "Entrance backend failed to start. Check its logs and port.");
    g_free(line);
    g_clear_error(&error);
}

void start(Window *state) {
    if (g_strcmp0(g_getenv("ENTRANCE_AUTOSTART"), "0") == 0) {
        const char *url = g_getenv("ENTRANCE_URL");
        open(state, url ? url : "http://127.0.0.1:3000");
        return;
    }
    const desktop::Runtime runtime = desktop::runtime(std::filesystem::read_symlink("/proc/self/exe"));
    GSubprocessLauncher *launcher = g_subprocess_launcher_new(G_SUBPROCESS_FLAGS_STDOUT_PIPE);
    g_subprocess_launcher_set_cwd(launcher, runtime.backend.c_str());
    const std::filesystem::path dir = std::filesystem::path(g_get_user_config_dir()) / "entrance-desktop/backend-data";
    g_subprocess_launcher_setenv(launcher, "ENTRANCE_DATA_DIR", dir.c_str(), FALSE);
    // Ensure the private backend also exits if the UI process crashes.
    g_subprocess_launcher_set_child_setup(launcher, [](gpointer) {
        prctl(PR_SET_PDEATHSIG, SIGTERM);
        if (getppid() == 1) _exit(1);
    }, nullptr, nullptr);
    GError *error = nullptr;
    state->child = g_subprocess_launcher_spawn(launcher, &error, runtime.node.c_str(),
        runtime.adapter.c_str(), runtime.backend.c_str(), nullptr);
    g_object_unref(launcher);
    if (!state->child) {
        status(state, error->message);
        g_error_free(error);
        return;
    }
    GDataInputStream *stream = g_data_input_stream_new(g_subprocess_get_stdout_pipe(state->child));
    g_data_input_stream_read_line_async(stream, G_PRIORITY_DEFAULT, nullptr, ready, state);
    g_object_unref(stream);
    g_subprocess_wait_async(state->child, nullptr, [](GObject *child, GAsyncResult *result, gpointer data) {
        g_subprocess_wait_finish(G_SUBPROCESS(child), result, nullptr);
        status(static_cast<Window *>(data), "Entrance backend stopped. Check its logs and port.");
    }, state);
}

void firstFramePainted(GdkFrameClock *clock, gpointer data) {
    g_signal_handlers_disconnect_by_func(clock, reinterpret_cast<gpointer>(firstFramePainted), data);
    Window *state = static_cast<Window *>(data);
    if (state->closing) return;
    state->view = WEBKIT_WEB_VIEW(webkit_web_view_new());
    g_signal_connect(state->view, "decide-policy", G_CALLBACK(decide), state);
    gtk_stack_add_named(GTK_STACK(state->stack), GTK_WIDGET(state->view), "browser");
    start(state);
}

void activate(GtkApplication *app, gpointer data) {
    Window *state = static_cast<Window *>(data);
    if (state->window) {
        gtk_window_present(state->window);
        return;
    }
    state->window = GTK_WINDOW(adw_application_window_new(app));
    gtk_window_set_title(state->window, "Entrance Desktop");
    gtk_window_set_default_size(state->window, 1280, 800);
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_box_append(GTK_BOX(box), adw_header_bar_new());
    state->stack = gtk_stack_new();
    gtk_widget_set_vexpand(state->stack, TRUE);
    state->status = GTK_LABEL(gtk_label_new("Starting Entrance…"));
    gtk_stack_add_named(GTK_STACK(state->stack), GTK_WIDGET(state->status), "status");
    gtk_box_append(GTK_BOX(box), state->stack);
    adw_application_window_set_content(ADW_APPLICATION_WINDOW(state->window), box);
    g_signal_connect(state->window, "close-request", G_CALLBACK(+[](GtkWindow *, gpointer data) -> gboolean {
        static_cast<Window *>(data)->closing = true;
        return FALSE;
    }), state);
    gtk_widget_realize(GTK_WIDGET(state->window));
    GdkFrameClock *clock = gtk_widget_get_frame_clock(GTK_WIDGET(state->window));
    g_signal_connect_after(clock, "after-paint", G_CALLBACK(firstFramePainted), state);
    gtk_window_present(state->window);
}
}

int main(int argc, char **argv) {
    Window state;
    AdwApplication *app = adw_application_new("com.entrance.desktop", G_APPLICATION_DEFAULT_FLAGS);
    g_signal_connect(app, "activate", G_CALLBACK(activate), &state);
    const int result = g_application_run(G_APPLICATION(app), argc, argv);
    state.closing = true;
    if (state.child) {
        g_subprocess_force_exit(state.child);
        g_subprocess_wait(state.child, nullptr, nullptr);
        g_object_unref(state.child);
    }
    g_object_unref(app);
    return result;
}
