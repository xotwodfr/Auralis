// Hides the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use gtk::gio::prelude::TlsBackendExt;

/// Appends the colon-separated `baked` entries to an existing path list, skipping ones already listed.
#[cfg(target_os = "linux")]
fn merge_module_paths(existing: Option<&str>, baked: &str) -> String {
    let mut parts: Vec<&str> = existing.unwrap_or_default().split(':').filter(|p| !p.is_empty()).collect();
    for p in baked.split(':').filter(|p| !p.is_empty()) {
        if !parts.contains(&p) {
            parts.push(p);
        }
    }
    parts.join(":")
}

fn main() {
    // WebKitGTK's DMABUF renderer crashes on some Wayland/GBM setups (Wayland protocol error, GBM buffer failures).
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // Without a GIO TLS backend (glib-networking) every https:// request from the webview fails as a generic
    // network error. Nix keeps it in a store path, so add the one recorded at build time (before GTK/GIO start).
    #[cfg(target_os = "linux")]
    if let Some(dir) = option_env!("AURALIS_GIO_EXTRA_MODULES") {
        let merged = merge_module_paths(std::env::var("GIO_EXTRA_MODULES").ok().as_deref(), dir);
        std::env::set_var("GIO_EXTRA_MODULES", merged);
    }
    // Same for GStreamer: WebKitGTK needs appsink (gst-plugins-base) and autoaudiosink (gst-plugins-good), or media
    // elements cannot play. GST_PLUGIN_PATH_1_0 is additive, so system plugins keep working.
    #[cfg(target_os = "linux")]
    {
        if let Some(dirs) = option_env!("AURALIS_GST_PLUGIN_PATH") {
            let merged = merge_module_paths(std::env::var("GST_PLUGIN_PATH_1_0").ok().as_deref(), dirs);
            std::env::set_var("GST_PLUGIN_PATH_1_0", merged);
        }
        if let Some(scanner) = option_env!("AURALIS_GST_PLUGIN_SCANNER") {
            if std::env::var_os("GST_PLUGIN_SCANNER").is_none() {
                std::env::set_var("GST_PLUGIN_SCANNER", scanner);
            }
        }
    }
    // Wayland reports no screen DPI (gdk_screen_get_resolution() == -1); WebKitGTK then derives a negative
    // devicePixelRatio and lays the page out at a negative width. 96 is the CSS reference DPI.
    #[cfg(target_os = "linux")]
    if gtk::init().is_ok() {
        if let Some(screen) = gtk::gdk::Screen::default() {
            if screen.resolution() <= 0.0 {
                screen.set_resolution(96.0);
            }
        }
    }
    #[cfg(target_os = "linux")]
    if !gtk::gio::TlsBackend::default().supports_tls() {
        eprintln!("auralis: no GIO TLS backend found, https:// servers will be unreachable. Install glib-networking and set GIO_EXTRA_MODULES.");
    }
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Auralis");
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::merge_module_paths;

    #[test]
    fn uses_baked_path_when_unset_or_empty() {
        assert_eq!(merge_module_paths(None, "/n/mods"), "/n/mods");
        assert_eq!(merge_module_paths(Some(""), "/n/mods"), "/n/mods");
    }

    #[test]
    fn keeps_existing_paths_and_does_not_duplicate() {
        assert_eq!(merge_module_paths(Some("/a:/b"), "/n/mods"), "/a:/b:/n/mods");
        assert_eq!(merge_module_paths(Some("/a:/n/mods"), "/n/mods"), "/a:/n/mods");
        assert_eq!(merge_module_paths(Some("/a"), "/x:/a:/y"), "/a:/x:/y");
    }
}
