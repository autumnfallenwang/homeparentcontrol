// swift-tools-version: 6.0
import PackageDescription

/// The on-device agent (§3). Two targets, and the split is load-bearing:
///
/// - `HPCCore` is **pure logic with no I/O** — the tick predicate, the DST
///   boundary resolver, the enforcement ladder. It is where every decision
///   that can keep a Mac usable past bedtime lives, so it is the part that
///   gets golden-file tested without a daemon, a clock or a screen.
/// - `HPCEnforcer` is the daemon: files, signals, and the effects.
///
/// ⚠️ Neither target may import a networking API. §9's exit criterion is that
/// `otool -L` shows no networking symbols in the enforcer binary — enforcement
/// is provably independent of the network, which is the contract's central
/// unproven claim (V1–V9).
let package = Package(
    name: "hpc-agent",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "HPCCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "HPCEnforcer",
            dependencies: ["HPCCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "HPCCoreTests",
            dependencies: ["HPCCore"],
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
