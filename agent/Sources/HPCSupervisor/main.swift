import Dispatch
import Foundation
import HPCAgentIO
import HPCCore

/// `hpc-supervisor` — the watchdog (§6.4).
///
/// ⚠️ **A.24: it never self-updates.** "It is the one component that cannot be
/// rolled back in place." A supervisor bump raises a notification and is an
/// attended install, a couple of times a year. That is the price of not having
/// the updater update itself, and it is paid here by there being no code path
/// in this file that writes to its own binary.
///
/// ⚠️ **Enforcement-logic-free.** It never loads a policy, never evaluates the
/// predicate and never decides whether a Mac should be locked. It reads
/// `last_decision` out of the enforcer's health file — a string the enforcer
/// already computed — and that is the closest it comes.
///
/// ⚠️ **No network.** §6.4's rollback path is explicitly "OFFLINE, no
/// network": the pkg cache is the whole mechanism, because the case it exists
/// for is the one where the new version broke the sync daemon.
///
/// All judgement lives in `HPCCore.SupervisorPolicy`. This file is the hands.
enum Supervisor {
    static let version = "0.1.0"
    static let tickInterval: TimeInterval = 60

    static var state = SupervisorPolicy.State()
    static var lastPids: [String: Int] = [:]
    static var restarts: [Date] = []
    static let bootedAt = Date()

    static let watchedJobs = ["enforcer", "sync"]

    static func tick() {
        let now = Date()

        // ── Restart detection. launchd is the only thing that knows a daemon
        // died, and it does not tell anyone — so watch the pid instead. A
        // changed pid for a job that was running is a restart, and three in
        // five minutes is §6.4's crash loop.
        for job in watchedJobs {
            let pid = launchdPid(for: "com.hpc.\(job)")
            if let previous = lastPids[job], let pid, previous != pid { restarts.append(now) }
            lastPids[job] = pid ?? lastPids[job]
        }
        restarts = restarts.filter { now.timeIntervalSince($0) <= SupervisorPolicy.crashWindowS }

        let inputs = SupervisorPolicy.Inputs(
            runningVersion: runningVersion(),
            health: watchedJobs.map(readHealth),
            recentCrashes: restarts,
            stagedVersions: stagedVersions(),
            lastGoodVersion: readLastGood(),
            quarantined: readQuarantine(),
            bootedAt: bootedAt)

        let step = SupervisorPolicy.step(inputs, state: state, now: now)
        state = step.state

        var detail = step.audit
        detail["decision"] = String(describing: step.decision)

        switch step.decision {
        case .idle:
            break

        case .report(let reason):
            detail["reason"] = reason
            log("supervisor.deferred", detail)

        case .install(let version):
            log("supervisor.installing", detail)
            if install(version: version, rollingBack: false) {
                writeLastGood(inputs.runningVersion)
                enterShadow(version: version, now: now)
                kickstart()
            }

        case .rollback(let target, let quarantine, let reason):
            // ⚠️ Quarantine BEFORE installing, not after. If the machine
            // loses power mid-`installer`, the bad version must already be
            // recorded — otherwise the next boot re-stages it, reinstalls it
            // and loops. Writing the receipt first costs one redundant
            // quarantine entry in the good case; writing it last costs the
            // loop the quarantine exists to break.
            addQuarantine(quarantine)
            detail["reason"] = reason
            detail["rolling_back_to"] = target
            log("supervisor.rollback", detail)
            // ⚠️ **Clear the soak marker before rolling back.** The target is
            // a version that has already soaked, and leaving a marker naming
            // the failed version would be stale anyway — but clearing it is
            // what makes "a rollback enforces immediately" true by
            // construction rather than by `ShadowMode`'s version check
            // happening to catch it. Two independent reasons it enforces.
            SoakMarker.clear()
            if install(version: target, rollingBack: true) { kickstart() }
        }

        promoteIfDue(now: now)
        prunePkgCache(keeping: inputs.lastGoodVersion)
        writeHealth(decision: String(describing: step.decision))
    }

    // MARK: - Shadow mode (§6.5)

    /// Put a freshly installed version into shadow — the ONLY place this
    /// happens.
    ///
    /// ⚠️ **Refuses for a version that has already soaked.** Without that,
    /// reinstalling the agent buys another unenforced day, every time, and
    /// "reinstall the agent" becomes the bypass. The supervisor is also the
    /// only component that could know the difference, because it is the one
    /// that installs.
    static func enterShadow(version: String, now: Date) {
        if SoakMarker.soaked().contains(version) {
            log("supervisor.shadow_skipped", [
                "version": version, "reason": "already_soaked",
            ])
            return
        }
        let soak = ShadowMode.Soak.begin(version: version, at: now)
        guard (try? SoakMarker.write(soak)) != nil else {
            // ⚠️ If the marker cannot be written the new version simply
            // ENFORCES. That is the right way to fail: an un-soaked version
            // that locks is a smaller problem than a soak nobody can end.
            log("supervisor.shadow_failed", ["version": version])
            return
        }
        log("supervisor.shadow_entered", [
            "version": version,
            "until": ISO8601DateFormatter().string(from: soak.deadline),
        ])
    }

    /// End a soak. Called when the control plane reports the promotion
    /// criteria met, and unconditionally once the deadline has passed.
    ///
    /// ⚠️ The deadline check here is belt and braces: `ShadowMode.verdict`
    /// already refuses an expired marker, so the enforcer is enforcing
    /// before this runs. This only tidies the file and records the version
    /// so the soak is never repeated.
    static func promoteIfDue(now: Date) {
        guard let soak = SoakMarker.read() else { return }
        guard now >= soak.deadline else { return }
        SoakMarker.recordSoaked(soak.version)
        SoakMarker.clear()
        log("supervisor.shadow_promoted", [
            "version": soak.version, "reason": "deadline_reached",
        ])
    }

    // MARK: - launchd

    /// `launchctl print` is the only supported reader of a job's live pid.
    /// A job that is loaded but not running prints no `pid = …` line, which is
    /// exactly the nil we want.
    static func launchdPid(for label: String) -> Int? {
        let output = run("/bin/launchctl", ["print", "system/\(label)"])
        guard let line = output.split(separator: "\n").first(where: {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix("pid = ")
        }) else { return nil }
        return Int(line.trimmingCharacters(in: .whitespaces).dropFirst("pid = ".count))
    }

    /// ⚠️ **`kickstart -k` kills.** It is the most dangerous call in the agent
    /// and it is deliberately not reachable except from a `SupervisorPolicy`
    /// decision that has already cleared the cooldown and the 24 h budget.
    ///
    /// The deadfall is NOT kickstarted: it is a one-shot with no process to
    /// restart, and its plist is sync's to rewrite.
    static func kickstart() {
        for job in watchedJobs {
            _ = run("/bin/launchctl", ["kickstart", "-k", "system/com.hpc.\(job)"])
        }
    }

    // MARK: - installer(8)

    /// ⚠️ §6.4: "**RE-VERIFY sha256 itself** ← defence in depth".
    ///
    /// `installer -pkg` run as root bypasses Gatekeeper — 📄 *"it will bypass
    /// quarantine and the Gatekeeper check"* — and under D.7 there is no
    /// Developer ID Installer certificate, so **the pinned digest is the whole
    /// gate**. It is checked by the downloader and again here, by the process
    /// that actually runs `installer`, because "a digest nobody checks is
    /// worse than no digest, because it looks like a control".
    static func install(version: String, rollingBack: Bool) -> Bool {
        let path = Paths.pkg(version)
        guard FileManager.default.fileExists(atPath: path) else {
            log("supervisor.install_failed", ["version": version, "reason": "pkg_missing"])
            return false
        }
        guard let expected = pinnedDigest(for: version) else {
            // ⚠️ No recorded digest means we cannot verify, and an unverified
            // pkg is never installed — not even on the rollback path, where
            // the temptation is strongest.
            log("supervisor.install_failed", ["version": version, "reason": "no_pinned_digest"])
            return false
        }
        guard let actual = sha256(ofFileAt: path), actual == expected.lowercased() else {
            log(
                "supervisor.install_failed",
                ["version": version, "reason": "digest_mismatch"])
            // A pkg whose bytes do not match its pin is not merely unusable,
            // it is evidence. Quarantine and remove it.
            addQuarantine(version)
            try? FileManager.default.removeItem(atPath: path)
            return false
        }

        let status = runStatus("/usr/sbin/installer", ["-pkg", path, "-target", "/"])
        log(
            status == 0 ? "supervisor.installed" : "supervisor.install_failed",
            ["version": version, "status": String(status),
             "rolling_back": String(rollingBack)])
        return status == 0
    }

    /// Streamed, so a 40 MB pkg is not held in memory twice.
    static func sha256(ofFileAt path: String) -> String? {
        let output = run("/usr/bin/shasum", ["-a", "256", path])
        return output.split(separator: " ").first.map { $0.lowercased() }
    }

    // MARK: - The pkg cache

    static func stagedVersions() -> [String] {
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: Paths.pkgCache)) ?? []
        return contents.filter { $0.hasSuffix(".pkg") }.map { String($0.dropLast(4)) }
    }

    /// "prune `pkgs/` to the newest 3 plus last-good".
    static func prunePkgCache(keeping lastGood: String?) {
        let versions = stagedVersions().sorted { SupervisorPolicy.isNewer($1, than: $0) }
        guard versions.count > 3 else { return }
        var keep = Set(versions.suffix(3))
        if let lastGood { keep.insert(lastGood) }
        keep.insert(runningVersion())
        for version in versions where !keep.contains(version) {
            try? FileManager.default.removeItem(atPath: Paths.pkg(version))
            try? FileManager.default.removeItem(atPath: Paths.pkg(version) + ".sha256")
        }
    }

    static func pinnedDigest(for version: String) -> String? {
        try? String(contentsOfFile: Paths.pkg(version) + ".sha256", encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - State files

    static func readHealth(_ job: String) -> SupervisorPolicy.Health {
        let path = job == "enforcer" ? Paths.health : Paths.syncHealth
        guard let data = FileManager.default.contents(atPath: path),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return .init(job: job, writtenAt: nil, lastDecision: nil, version: nil) }
        return .init(
            job: job,
            writtenAt: (row["ts"] as? String).flatMap(ISO8601DateFormatter.hpcParse),
            lastDecision: row["last_decision"] as? String,
            version: row["version"] as? String)
    }

    static func runningVersion() -> String {
        readHealth("enforcer").version ?? version
    }

    static func readLastGood() -> String? {
        try? String(contentsOfFile: Paths.lastGood, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func writeLastGood(_ version: String) {
        try? Data(version.utf8).write(to: URL(fileURLWithPath: Paths.lastGood), options: .atomic)
    }

    static func readQuarantine() -> Set<String> {
        guard let data = FileManager.default.contents(atPath: Paths.quarantine),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [String]
        else { return [] }
        return Set(rows)
    }

    static func addQuarantine(_ version: String) {
        var all = readQuarantine()
        all.insert(version)
        guard let data = try? JSONSerialization.data(
            withJSONObject: Array(all).sorted(), options: [.sortedKeys]) else { return }
        try? data.write(to: URL(fileURLWithPath: Paths.quarantine), options: .atomic)
    }

    static func writeHealth(decision: String) {
        let row: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "version": version,
            "last_decision": decision,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        try? data.write(to: URL(fileURLWithPath: Paths.supervisorHealth), options: .atomic)
    }

    static func log(_ kind: String, _ detail: [String: String]) {
        Spool.append(kind: kind, detail: detail, tickSeq: 0)
    }

    // MARK: - Process helpers

    @discardableResult
    static func run(_ path: String, _ args: [String]) -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return "" }
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        task.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    static func runStatus(_ path: String, _ args: [String]) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return -1 }
        task.waitUntilExit()
        return task.terminationStatus
    }
}

signal(SIGTERM, SIG_IGN)
let queue = DispatchQueue(label: "hpc.supervisor", qos: .utility)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: queue)
termSource.setEventHandler { exit(0) }
termSource.resume()

let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now(), repeating: Supervisor.tickInterval, leeway: .seconds(5))
timer.setEventHandler { Supervisor.tick() }
timer.resume()

dispatchMain()
