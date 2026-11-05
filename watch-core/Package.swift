// swift-tools-version:5.9
// The watch app's Foundation-only core (targets/watch/Core, symlinked as Sources/WatchCore),
// built on the host so its tests run without a simulator: `npm run test:watch`.
import PackageDescription

let package = Package(
  name: "WatchCore",
  platforms: [.macOS(.v13), .watchOS(.v10)],
  products: [.library(name: "WatchCore", targets: ["WatchCore"])],
  targets: [
    .target(name: "WatchCore", path: "Sources/WatchCore"),
    .testTarget(name: "WatchCoreTests", dependencies: ["WatchCore"], path: "Tests/WatchCoreTests"),
  ],
  swiftLanguageVersions: [.v5]
)
