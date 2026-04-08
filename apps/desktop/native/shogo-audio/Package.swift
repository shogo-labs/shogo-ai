// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "shogo-audio",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "shogo-audio",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("EventKit"),
            ]
        )
    ]
)
