// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "shogo-sysaudio",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "shogo-sysaudio",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio"),
            ]
        )
    ]
)
