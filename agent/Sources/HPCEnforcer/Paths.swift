import Foundation

/// Every path the enforcer touches. §2's file layout.
///
/// ⚠️ All under one root so a single `chmod`/`chflags` audit covers the lot,
/// and so the V-series can break exactly one thing at a time.
enum Paths {
    static let root = "/var/db/homeparentcontrol"

    static var killSwitch: String { "\(root)/DISABLE" }
    static var currentPolicy: String { "\(root)/policy.current.json" }
    static var lkgPolicy: String { "\(root)/policy.lkg.json" }
    static var signingKeys: String { "\(root)/policy_signing_keys.json" }
    static var cleanExit: String { "\(root)/clean_exit" }
    static var health: String { "\(root)/enforcer.health" }
    static var spool: String { "\(root)/spool/enforcer.ndjson" }
}
