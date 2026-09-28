import Foundation

/// What decommissioning removes, and in what order (§4.7: "the agent
/// uninstalls itself, posts a final `agent.decommissioned` event, and
/// `launchctl bootout`s itself").
///
/// Pure data, so `DecommissionPlanTests` can check it against the plists the
/// package actually installs.
///
/// ⚠️ Found preparing the first real decommission (2026-09-28). The old code
/// booted out `com.hpc.enforcer` — the job is `com.hpc.enforcerd` — so the
/// enforcer kept running; it never touched the supervisor; and it removed no
/// plist, so the next reboot started everything again. Decommission is the
/// one sanctioned way enforcement ends (A.7), and it ended nothing.
public enum DecommissionPlan {
    /// Every launchd job the agent runs, in bootout order. The supervisor goes
    /// FIRST so it cannot restart or reinstall anything mid-way; sync goes
    /// LAST because sync is the process carrying this out, and booting it out
    /// ends the process.
    public static let jobs = [
        "com.hpc.supervisor",
        "com.hpc.deadfall",
        "com.hpc.enforcerd",
        "com.hpc.sync"
    ]

    /// Their plists — removed before the bootout, so a reboot loads nothing.
    public static var plists: [String] { jobs.map { "\(Paths.launchDaemons)/\($0).plist" } }

    /// The binaries. Unlinking a running binary is fine on macOS; the process
    /// keeps its mapping until bootout ends it.
    public static var binaries: [String] {
        ["hpc-supervisor", "hpc-deadfall", "hpc-enforcerd", "hpc-sync"]
            .map { "\(Paths.libexec)/\($0)" }
    }

    /// State that must not outlive the device: a policy to obey, a credential
    /// to use, and a staged code a restarted sync would enrol with.
    public static var state: [String] {
        [Paths.currentPolicy, Paths.lkgPolicy, Paths.credential, Paths.enrolmentCode]
    }

    /// The installer receipt, forgotten so `pkgutil --pkgs` stops listing it.
    public static let receipt = "com.hpc.agent"
}
