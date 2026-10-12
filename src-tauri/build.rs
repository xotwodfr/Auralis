use std::path::Path;

/// Bakes a Nix store path exported by shell.nix into the binary (read back with `option_env!` in main.rs).
/// `marker` is a file that must exist inside (one of) the directories, so a stale or wrong path is caught here.
fn bake(var: &str, marker: &str) {
    println!("cargo:rerun-if-env-changed={var}");
    match std::env::var(var) {
        Ok(value) if value.split(':').any(|d| Path::new(d).join(marker).is_file() || Path::new(d).is_file()) => {
            println!("cargo:rustc-env={var}={value}");
        }
        Ok(value) => println!("cargo:warning={var}={value} does not contain {marker}; it will not work at runtime"),
        Err(_) => println!("cargo:warning={var} is unset (build inside nix-shell); relying on the system's libraries at runtime"),
    }
}

fn main() {
    // On Nix the GIO TLS backend (glib-networking) and the GStreamer plugins live in store paths that only the dev
    // shell knows, so a binary launched anywhere else would find neither. Linux only.
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "linux") {
        bake("AURALIS_GIO_EXTRA_MODULES", "libgiognutls.so");
        bake("AURALIS_GST_PLUGIN_PATH", "libgstapp.so");
        bake("AURALIS_GST_PLUGIN_SCANNER", "");
    }
    tauri_build::build()
}
