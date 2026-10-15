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
        .binaryTarget(name: "Sparkle", url: "https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-for-Swift-Package-Manager.zip",
                      checksum: "17e28312b8e18ab7cdbbe09a6fb28cc55a5479ec6c371dbc07cdecd2a14fd959"),
        .target(name: "DocumentCore"),
        .testTarget(name: "DocumentCoreTests", dependencies: ["DocumentCore"]),
        .target(name: "ToolCore"),
        .testTarget(name: "ToolCoreTests", dependencies: ["ToolCore"]),
        .executableTarget(name: "Mori", dependencies: ["DocumentCore", "ToolCore", "Sparkle"],
                          linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit"), .linkedFramework("CoreServices"),
                                           .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .testTarget(name: "MoriBridgeTests", dependencies: ["Mori"])
    ]
)
