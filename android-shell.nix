{ pkgs ? import <nixpkgs> {
  config.android_sdk.accept_license = true;
  config.allowUnfree = true;
} }:

let
  android = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "36" ];
    buildToolsVersions = [ "36.0.0" ];
    includeNDK = true;
    ndkVersions = [ "27.2.12479018" ];
    includeEmulator = false;
  };

  sdk = "${android.androidsdk}/libexec/android-sdk";
  buildTools = "36.0.0";
in

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    jdk17
    android.androidsdk
    pkg-config
    rustup
  ];

  JAVA_HOME = "${pkgs.jdk17}";
  ANDROID_HOME = sdk;
  ANDROID_SDK_ROOT = sdk;
  ANDROID_NDK_ROOT = "${sdk}/ndk-bundle";
  NDK_HOME = "${sdk}/ndk-bundle";

  GRADLE_OPTS =
    "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/build-tools/${buildTools}/aapt2";

  shellHook = ''
    echo "Auralis Android build environment"
    java -version
    echo "Android SDK: $ANDROID_HOME"
  '';
}
