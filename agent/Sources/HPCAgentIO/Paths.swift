import Foundation

/// Every path the agent touches. §2's file layout.
///
/// ⚠️ All under one root so a single `chmod`/`chflags` audit covers the lot,
/// and so the V-series can break exactly one thing at a time.
public enum Paths {
    public static let root = "/var/db/homeparentcontrol"
    public static let logRoot = "/var/log/homeparentcontrol"
    public static let launchDaemons = "/Library/LaunchDaemons"
    public static let libexec = "/usr/local/libexec"

    // ── Read by the enforcer, written by sync.
    public static var killSwitch: String { "\(root)/DISABLE" }
    public static var currentPolicy: String { "\(root)/policy.current.json" }
    public static var lkgPolicy: String { "\(root)/policy.lkg.json" }
    public static var signingKeys: String { "\(root)/policy_signing_keys.json" }

    // ── The enforcer's own state.
    public static var cleanExit: String { "\(root)/clean_exit" }
    public static var health: String { "\(root)/enforcer.health" }
    public static var spool: String { "\(root)/spool/enforcer.ndjson" }
    /// Where a rotated spool segment lands while sync reads it.
    public static func spoolSegment(_ stamp: String) -> String {
        "\(root)/spool/enforcer.\(stamp).ndjson"
    }
    public static var spoolDirectory: String { "\(root)/spool" }

    // ── The sync daemon's, which nothing else writes (§2: "sync daemon owns
    // it exclusively"). 0600, root:wheel.
    public static var queue: String { "\(root)/queue.sqlite" }
    public static var syncHealth: String { "\(root)/sync.health" }
    /// ⚠️ The device credential. Never logged, never in the spool, and the one
    /// file in this list whose leak is a real incident.
    public static var credential: String { "\(root)/credential.json" }
    public static var deviceIdentity: String { "\(root)/device.json" }
    /// The one-time enrolment code, dropped here by the installer and deleted
    /// the moment it is exchanged.
    public static var enrolmentCode: String { "\(root)/enrolment_code" }

    // ── The supervisor's.
    public static var pkgCache: String { "\(root)/pkgs" }
    public static func pkg(_ version: String) -> String { "\(pkgCache)/\(version).pkg" }
    public static var quarantine: String { "\(root)/quarantine.json" }
    public static var lastGood: String { "\(root)/last_good" }
    public static var supervisorHealth: String { "\(root)/supervisor.health" }

    // ── The deadfall's generated plist, rewritten by sync on policy change.
    public static var deadfallPlist: String { "\(launchDaemons)/com.hpc.deadfall.plist" }
    public static var deadfallBinary: String { "\(libexec)/hpc-deadfall" }
    public static var deadfallState: String { "\(root)/deadfall.last" }
}
