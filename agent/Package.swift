// swift-tools-version: 6.0
import PackageDescription

/// The on-device agent (§3). A.2: three launchd jobs plus one periodic
/// one-shot — `enforcer`, `sync`, `supervisor`, `deadfall` — over two
/// libraries, and every split here is load-bearing.
///
/// - `HPCCore` is **pure logic with no I/O** — the tick predicate, the DST
///   boundary resolver, the enforcement ladder, the cadence, the queue's
///   eviction policy, the supervisor's judgement. It is where every decision
///   that can keep a Mac usable past bedtime lives, so it is the part that
///   gets golden-file tested without a daemon, a clock or a screen.
/// - `HPCAgentIO` is the files, the effects and the kill switch: the thin
///   layer the executables share. ⚠️ **Network-free, and that is enforced**,
///   because `HPCEnforcer` links it.
/// - The four executables are thin.
///
/// ⚠️ **Only the sync daemon may import a networking API.** A.4: "the sync
/// daemon is the only component that talks to the control plane API". §9's
/// exit criterion is that `otool -L` shows no networking symbols in the
/// *enforcer*, because enforcement being provably independent of the network
/// is the contract's central unproven claim (V1–V9).
/// `scripts/check-no-networking.sh` asserts that for `HPCEnforcer`,
/// `HPCDeadfall` and `HPCSupervisor`, and asserts the OPPOSITE for `HPCSync` —
/// a check that cannot fail is not a check, so it has to be able to tell the
/// two apart.
let package = Package(
    name: "hpc-agent",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "HPCCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "HPCAgentIO",
            dependencies: ["HPCCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),

        // enforcerd — the 60 s tick. No network, ever.
        .executableTarget(
            name: "HPCEnforcer",
            dependencies: ["HPCCore", "HPCAgentIO"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // deadfall — the one-shot backstop (§4.6 class A). No network either:
        // it exists precisely for the case where everything else is dead.
        .executableTarget(
            name: "HPCDeadfall",
            dependencies: ["HPCCore", "HPCAgentIO"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // supervisor — watchdog and offline rollback. A.24: never self-updates.
        // No network: §6.4's rollback path is explicitly "OFFLINE, no network".
        .executableTarget(
            name: "HPCSupervisor",
            dependencies: ["HPCCore", "HPCAgentIO"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // sync — the ONLY component that talks to the control plane (A.4).
        //
        // Split into a library plus a two-line executable for the same reason
        // HPCCore is split from HPCEnforcer: the queue, the client and the
        // tick are testable, and `main.swift`'s top-level code is not.
        .target(
            name: "HPCSyncKit",
            dependencies: ["HPCCore", "HPCAgentIO"],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .executableTarget(
            name: "HPCSync",
            dependencies: ["HPCSyncKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),

        .testTarget(
            name: "HPCCoreTests",
            dependencies: ["HPCCore"],
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "HPCSyncTests",
            dependencies: ["HPCSyncKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
