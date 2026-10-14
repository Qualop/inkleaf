// swift-tools-version: 6.4
import PackageDescription

let package = Package(
    name: "Inkleaf",
    platforms: [.macOS("14.5")],
    products: [
        .library(name: "DocumentCore", targets: ["DocumentCore"]),
        .library(name: "ToolCore", targets: ["ToolCore"]),
        .executable(name: "Inkleaf", targets: ["Mori"])
    ],
    targets: [
        .target(name: "DocumentCore"),
        .testTarget(name: "DocumentCoreTests", dependencies: ["DocumentCore"]),
        .target(name: "ToolCore"),
        .testTarget(name: "ToolCoreTests", dependencies: ["ToolCore"]),
        .executableTarget(name: "Mori", dependencies: ["DocumentCore", "ToolCore"],
                          linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit"), .linkedFramework("CoreServices")]),
        .testTarget(name: "MoriBridgeTests", dependencies: ["Mori"])
    ]
)
