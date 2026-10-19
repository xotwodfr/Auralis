// swift-tools-version:5.9
import PackageDescription

// Foundation-only on purpose: models, Subsonic client and queue logic build and test on Linux too.
// Apple-only playback (AVFoundation) sits behind canImport in Sources/AuralisKit/Playback.
let package = Package(
  name: "AuralisKit",
  platforms: [.iOS("26.0"), .macOS("26.0")],
  products: [.library(name: "AuralisKit", targets: ["AuralisKit"])],
  targets: [
    .target(name: "AuralisKit"),
    .testTarget(name: "AuralisKitTests", dependencies: ["AuralisKit"]),
  ]
)
