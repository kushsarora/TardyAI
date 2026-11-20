// swift-tools-version:5.9
// HoloCore: the platform-independent heart of HoloMap — building data,
// A* routing, turn-by-turn steps, room search, GPS-to-plan projection and the
// "am I late?" estimate. No UIKit/SwiftUI here, so `swift test` runs on any
// machine with a Swift toolchain (macOS or Linux).
import PackageDescription

let package = Package(
    name: "HoloCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "HoloCore", targets: ["HoloCore"]),
    ],
    targets: [
        .target(
            name: "HoloCore",
            resources: [.copy("Resources")]
        ),
        .testTarget(
            name: "HoloCoreTests",
            dependencies: ["HoloCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
