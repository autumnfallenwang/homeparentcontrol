import Foundation

/// The one version every daemon reports — in `enforcer.health`, in every
/// sync's `agent_version`, and so as Agent on the parent's device page.
///
/// ⚠️ **The `-dev` suffix is derived from `DEV_ENFORCEMENT` itself**, the same
/// compile-time flag that turns `Effects.shutdown()` into a log line. So a
/// binary that cannot power the Mac off says so, and one that can does not,
/// and there is no way to build one without the other.
///
/// Found on the first real smoke test. This used to be four separate
/// `static let version = "0.1.0"` literals, one per daemon, while
/// `build-pkg.sh --dev` appended `-dev` only to the PACKAGE version. The safe
/// build installed, enrolled and reported `0.1.0` — identical to production —
/// so the one tell `smoke-test.md` promised ("the device card shows
/// `0.1.0-dev`") did not exist. An agent that logs "would shut down" for ever
/// looks exactly like one that shuts down.
public enum AgentVersion {
    /// Bumped here and nowhere else. `build-pkg.sh` refuses a version argument
    /// that disagrees, because a pkg whose version differs from what its
    /// binaries report makes the supervisor's `isNewer` install it forever.
    public static let base = "0.2.1"

    #if DEV_ENFORCEMENT
        public static let isSafeVariant = true
        public static let current = base + "-dev"
    #else
        public static let isSafeVariant = false
        public static let current = base
    #endif

    /// `hpc-* --version`. Checked FIRST in every daemon, before any state is
    /// touched — the answer to "which build is on this Mac?" must not need
    /// root, a lock, or a running agent. `strings` cannot answer it: Swift
    /// packs a literal this short into instruction immediates.
    public static let flag = "--version"

    public static func handleFlag(_ arguments: [String] = CommandLine.arguments) {
        guard arguments.dropFirst().contains(flag) else { return }
        print(current)
        exit(0)
    }
}
