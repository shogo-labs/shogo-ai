// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "shogo-hotkey",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "shogo-hotkey",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
            ]
        )
    ]
)
