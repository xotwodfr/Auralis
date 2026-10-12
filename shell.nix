{ pkgs ? import <nixpkgs> { } }:
# Linux Tauri dev shell: `nix-shell` then `cd src-tauri && cargo build`.
pkgs.mkShell {
  # Read by src-tauri/build.rs and baked into the binary so it finds the TLS backend outside this shell too.
  # Same idea for GStreamer: appsink is in gst-plugins-base (libgstapp), autoaudiosink in gst-plugins-good (libgstautodetect).
  AURALIS_GST_PLUGIN_PATH = pkgs.lib.makeSearchPath "lib/gstreamer-1.0" (with pkgs.gst_all_1; [
    gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav
  ]);
  AURALIS_GST_PLUGIN_SCANNER = "${pkgs.gst_all_1.gstreamer.out}/libexec/gstreamer-1.0/gst-plugin-scanner";
  AURALIS_GIO_EXTRA_MODULES = "${pkgs.glib-networking}/lib/gio/modules";
  nativeBuildInputs = with pkgs; [ pkg-config cargo rustc cargo-tauri nodejs gobject-introspection wrapGAppsHook3 ];
  buildInputs = with pkgs; [
    webkitgtk_4_1 gtk3 libsoup_3 openssl librsvg glib-networking xdotool
    gst_all_1.gstreamer gst_all_1.gst-plugins-base gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad gst_all_1.gst-libav
  ];
  shellHook = ''
    export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules"
    export GST_PLUGIN_SYSTEM_PATH_1_0="$GST_PLUGIN_SYSTEM_PATH_1_0"
  '';
}
