// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AppleCalendarMCPHelper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "apple-calendar-mcp-helper", targets: ["AppleCalendarMCPHelper"])
    ],
    targets: [
        .executableTarget(
            name: "AppleCalendarMCPHelper",
            path: "Sources",
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist"
                ])
            ]
        )
    ]
)
