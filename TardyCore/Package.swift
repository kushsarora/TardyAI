// swift-tools-version:5.9
// TardyCore: the platform-independent heart of TardyAI — building data,
// A* routing, turn-by-turn steps, room search, GPS-to-plan projection and the
// "am I late?" estimate. No UIKit/SwiftUI here, so `swift test` runs on any
// machine with a Swift toolchain (macOS or Linux).
import PackageDescription

let package = Package(
    name: "TardyCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TardyCore", targets: ["TardyCore"]),
    ],
    targets: [
        .target(
            name: "TardyCore",
            resources: [.copy("Resources")]
        ),
        .testTarget(
            name: "TardyCoreTests",
            dependencies: ["TardyCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
