import Dispatch
import Foundation
import HPCAgentIO
import HPCCore

/// `hpc-sync` — the tick, the heartbeat, and the only thing that talks to the
/// control plane (A.4, §4.2).
///
/// ⚠️ **Nothing in this file may reach enforcement.** The enforcer is a
/// separate process with its own unconditional 60 s tick; this daemon writes
/// `policy.current.json` and the deadfall's plist, and that is the entire
/// surface between them. It never signals the enforcer, never gates it, and
/// crucially never *deletes* a cached policy (X1c) — a policy the agent
/// already has is enforced for ever, and no reply from the server can make it
/// stop. V6 is the proof: byte-identical enforcer logs with this daemon
/// running and booted out.
public enum SyncDaemon {
    public static let version = "0.1.0"

    static var queue: Queue?
    static var client: Client?
    static var cadence = Cadence.Inputs()
    static var tickSeq = 0
    static var halted: String?
    static let bootId = UUID().uuidString.lowercased()
    static let startedAt = Date()
    static var lastEtag: String?
    static var appliedVersion: Int?
    static var evictedSinceLastSync = 0
    static var lastEventFlush = Date.distantPast
    static var pendingReports: [DesiredReconciler.Report] = []
    static var samplerState = Sampler.State()

    /// "in 2,000-event batches (up to 4 per tick) while draining a backlog".
    static let batchSize = 2_000
    static let maxBatchesPerTick = 4

    // MARK: - Entry point

    public static func main() {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)

        let dispatchQueue = DispatchQueue(label: "hpc.sync", qos: .utility)

        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: dispatchQueue)
        term.setEventHandler {
            // A.27's converse: the clean-shutdown breadcrumb is what lets the
            // server report EXPECTED_OFFLINE rather than "Lucy's Mac went
            // silent". Best-effort — §3.8 is explicit that the dying breath
            // must not be load-bearing.
            enqueueLocal(type: "agent.stopping", cls: .audit, data: ["reason": "signal"])
            exit(0)
        }
        term.resume()

        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: dispatchQueue)
        interrupt.setEventHandler { exit(0) }
        interrupt.resume()

        start()
        schedule(on: dispatchQueue, afterMs: 0)

        // ⚠️ A SECOND timer, and a fixed one.
        //
        // §4.2's adaptive cadence belongs to the sync tick and can back off
        // to 300 s against a dead server. Sampling must not: `active_s` is a
        // meter, and a meter whose interval stretches when the network
        // wobbles produces usage numbers that quietly depend on server
        // uptime. The policy's `sample_interval_s` (60) is the only thing
        // that sets this.
        let sampler = DispatchSource.makeTimerSource(queue: dispatchQueue)
        sampler.schedule(
            deadline: .now(), repeating: .seconds(sampleIntervalS()), leeway: .seconds(2))
        sampler.setEventHandler { sampleTick() }
        sampler.resume()
        samplerTimer = sampler

        dispatchMain()
    }

    /// Held so the timer is not deallocated the moment `main` returns.
    static var samplerTimer: DispatchSourceTimer?

    static func sampleIntervalS() -> Int {
        max(5, telemetry().sampleIntervalS)
    }

    /// The policy's `telemetry` block, or this build's defaults when there is
    /// no readable policy yet.
    static func telemetry() -> PolicyDocument.Telemetry {
        loadedPolicy()?.document.telemetry ?? .fallback
    }

    // MARK: - Sampling

    /// One observation, folded into events and queued (§4.1, A.33).
    ///
    /// ⚠️ Nothing here can reach enforcement. It runs in the sync daemon —
    /// §3.1's table marks it "contains enforcement logic: ❌ none" — writes
    /// only to `queue.sqlite`, and every probe it runs has a 5 s deadline so
    /// a hung `lsappinfo` costs one sample rather than the timer.
    static func sampleTick() {
        guard let queue else { return }
        let config = telemetry()
        guard config.enabled else { return }

        let observation = SampleSource.observe()
        let output = Sampler.sample(observation, state: samplerState, telemetry: config)
        samplerState = output.state
        guard !output.events.isEmpty else { return }

        let rows = output.events.map { event -> Queue.Row in
            var data: [String: Any] = [:]
            for (key, value) in event.data { data[key] = value }
            for (key, value) in event.text { data[key] = value }
            return Queue.Row(
                eventId: EventID.v7(now: event.at),
                ts: event.at,
                type: event.type,
                // ⚠️ Samples, not audits. They are the bulk of the volume and
                // the first thing eviction drops — which is correct: a
                // rollup degrades gracefully when thinned, an enforcement
                // record does not.
                cls: .sample,
                bootId: bootId,
                data: data)
        }
        try? queue.enqueue(rows)
    }

    static func start() {
        queue = try? Queue()
        guard let baseURL = resolveBaseURL() else {
            FileHandle.standardError.write(
                Data("hpc-sync: no base URL configured; not syncing\n".utf8))
            return
        }
        client = Client(
            config: .init(baseURL: baseURL, token: DeviceState.loadCredential()?.token))
    }

    /// One timer, rescheduled after every tick — §4.2's "the agent has exactly
    /// one timer; everything below is that timer changing its period".
    static func schedule(on dispatchQueue: DispatchQueue, afterMs: Int) {
        dispatchQueue.asyncAfter(deadline: .now() + .milliseconds(afterMs)) {
            let next = tick()
            schedule(on: dispatchQueue, afterMs: next)
        }
    }

    // MARK: - The tick

    @discardableResult
    static func tick() -> Int {
        tickSeq += 1
        guard let queue, let client else { return Cadence.baseMs }

        // ── 1. Take whatever the enforcer wrote. Always, even when halted:
        //       a queue that stops accepting would eventually push back into
        //       the spool, and the spool is on the enforcer's critical path.
        try? SpoolReader.drain(into: queue, bootId: bootId)
        applyEviction(queue)

        // ── 2. Halted (X1b). Sync stops; ENFORCEMENT DOES NOT. The cached
        //       policy stays exactly where it is, the enforcer keeps ticking,
        //       and the only thing that has changed is that a parent's
        //       dashboard goes stale. A revoked credential must never be a
        //       bypass.
        if let halted {
            writeHealth(decision: "halted:\(halted)")
            return Cadence.ceilingMs
        }

        // ── 3. Enrol if we have never been issued a credential.
        if DeviceState.loadCredential() == nil {
            switch enrol(client) {
            case .success: break
            case .failure:
                cadence.consecutiveFailures += 1
                return nextInterval()
            }
        }

        // ── 4. The heartbeat. A.26 — the tick IS the heartbeat, and A.27 —
        //       telemetry never rides on it.
        let response: [String: Any]
        do {
            response = try client.sync(syncBody(queue))
            cadence.consecutiveFailures = 0
            cadence.retryAfterS = nil
            evictedSinceLastSync = 0
        } catch let problem as Client.Problem {
            handle(problem)
            cadence.consecutiveFailures += 1
            cadence.retryAfterS = problem.retryAfterS
            writeHealth(decision: "sync_failed:\(problem.status)")
            return nextInterval()
        } catch {
            // §4.6 class D. Unreachable is not a reason to change anything
            // about enforcement; it is a reason to try again later.
            cadence.consecutiveFailures += 1
            writeHealth(decision: "unreachable")
            return nextInterval()
        }

        apply(response: response, client: client, queue: queue)

        // ── 4b. Rotate on the clock, not only on request.
        //
        // ⚠️ `rotate_after` is returned by enrolment and by every rotation,
        // and NOTHING in the design document ever acts on it — §4.5 names
        // `credential` as a desired kind and leaves its spec undefined, so
        // the only documented trigger is a row a parent's UI would have to
        // create, and that UI is milestone 04. A credential that renews only
        // when someone remembers to ask is a credential that never renews.
        rotateIfDue(client)

        // ── 5. Telemetry, on its own schedule. A.27.
        flushEventsIfDue(client, queue)

        cadence.serverSuggestionMs = response["next_poll_after_ms"] as? Int
        cadence.nextBoundaryAt = nextBoundary()
        writeHealth(decision: "ok")
        return nextInterval()
    }

    static func nextInterval() -> Int {
        Cadence.next(cadence, now: Date()).intervalMs
    }

    // MARK: - Enrolment

    static func enrol(_ client: Client) -> Result<Void, Error> {
        guard let code = try? String(contentsOfFile: Paths.enrolmentCode, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty
        else { return .failure(Client.Transport.malformed("no enrolment code on disk")) }

        do {
            let response = try client.enroll([
                "code": code,
                "hardware_uuid": DeviceState.hardwareUUID(),
                "hostname": DeviceState.hostname(),
                "os_version": DeviceState.osVersion(),
                "arch": DeviceState.arch(),
                "agent_version": version,
            ])
            guard let deviceId = response["device_id"] as? String,
                  let credential = response["credential"] as? [String: Any],
                  let token = credential["token"] as? String
            else { return .failure(Client.Transport.malformed("enrolment response")) }

            try DeviceState.saveCredential(
                .init(
                    token: token,
                    keyId: credential["key_id"] as? String ?? "",
                    issuedAt: (credential["issued_at"] as? String)
                        .flatMap(ISO8601DateFormatter.hpcParse) ?? Date(),
                    rotateAfter: (credential["rotate_after"] as? String)
                        .flatMap(ISO8601DateFormatter.hpcParse)))
            try DeviceState.saveIdentity(
                .init(deviceId: deviceId, hardwareUUID: DeviceState.hardwareUUID()))

            if let keys = response["policy_signing_keys"] as? [[String: Any]] {
                try? SigningKeys.save(keys)
            }
            client.updateToken(token)

            // ⚠️ The code is single-use and its presence on disk is the only
            // thing that would make the agent try to enrol again. Remove it
            // the instant it has been exchanged.
            try? FileManager.default.removeItem(atPath: Paths.enrolmentCode)
            enqueueLocal(type: "agent.started", cls: .audit, data: ["enrolled": true])
            return .success(())
        } catch {
            if let problem = error as? Client.Problem { handle(problem) }
            return .failure(error)
        }
    }

    // MARK: - The request body

    /// `identity` is a parameter rather than a read, so the body can be
    /// assembled without `/var/db/homeparentcontrol` existing — the
    /// end-to-end suite runs as an ordinary user and would otherwise send
    /// `device_id: ""` and get a 400 it could not explain.
    static func syncBody(
        _ queue: Queue, identity: DeviceState.Identity? = DeviceState.loadIdentity()
    ) -> [String: Any] {
        let census = (try? queue.census()) ?? .init()
        let enforcer = readEnforcerHealth()
        let policy = loadedPolicy()

        var agent: [String: Any] = [
            "started_at": iso(startedAt),
            "uptime_s": Int(Date().timeIntervalSince(startedAt)),
            "tick_seq": tickSeq,
            "clean_exit_previous_run": Spool.readPreviousCleanExit()?.clean ?? false,
            "enforcer_health_age_s": Int(max(0, enforcer.ageS)),
            "capabilities": DesiredReconciler.capabilities,
        ]
        if let reason = Spool.readPreviousCleanExit()?.reason { agent["previous_stop_reason"] = reason }

        var queueBlock: [String: Any] = [
            "depth": census.totalCount,
            "bytes": census.totalBytes,
            "evicted_since_last_sync": evictedSinceLastSync,
        ]
        if let oldest = [census.oldestSampleAt, census.oldestAuditAt].compactMap({ $0 }).min() {
            queueBlock["oldest_event_at"] = iso(oldest)
        }

        var policyState: [String: Any] = [:]
        if let etag = lastEtag { policyState["etag"] = etag }
        if let applied = appliedVersion { policyState["policy_version"] = applied }
        if let policy {
            policyState["using_lkg"] = policy.source == .lastKnownGood
            policyState["signature_valid"] = policy.signatureValid
            policyState["source"] = policy.source.rawValue
            policyState["age_s"] = Int(max(0, Date().timeIntervalSince(policy.document.issuedAt)))
        }

        var enforcement: [String: Any] = ["state": enforcer.lastDecision ?? "unknown"]
        if let at = enforcer.writtenAt { enforcement["last_eval_at"] = iso(at) }
        if let boundary = nextBoundary() { enforcement["next_boundary_at"] = iso(boundary) }

        return [
            "contract": 1,
            "device": [
                "device_id": identity?.deviceId ?? "",
                "boot_id": bootId,
                "hardware_uuid": identity?.hardwareUUID ?? DeviceState.hardwareUUID(),
                "agent_version": version,
                "os_version": DeviceState.osVersion(),
                "arch": DeviceState.arch(),
                "system_boot_time": iso(DeviceState.systemBootTime()),
            ],
            "agent": agent,
            "clock": clockBlock(policy),
            "policy_state": policyState,
            "enforcement": enforcement,
            "queue": queueBlock,
            "converged": pendingReports.map { report in
                var row: [String: Any] = ["desired_id": report.desiredId, "status": report.status]
                if let detail = report.detail { row["detail"] = detail }
                return row
            },
        ]
    }

    static func clockBlock(_ policy: PolicyStore.Loaded?) -> [String: Any] {
        [
            "local_utc": iso(Date()),
            "system_timezone": TimeZone.current.identifier,
            // ⚠️ A.30 — the POLICY's zone is the one that governs, and
            // reporting it separately is what lets the server notice the two
            // have diverged without the agent having to decide what that means.
            "policy_timezone": policy?.document.timezone ?? TimeZone.current.identifier,
            "using_network_time": true,
            "continuous_ns": ProcessInfo.processInfo.systemUptime * 1_000_000_000,
            "skew_estimate_ms": 0,
            "stepped_since_last_sync": false,
        ]
    }

    // MARK: - The response

    static func apply(response: [String: Any], client: Client, queue: Queue) {
        // ── Policy.
        if let envelope = response["policy"] as? [String: Any],
           (envelope["unchanged"] as? Bool) == false
        {
            applyPolicy(envelope)
        } else if let envelope = response["policy"] as? [String: Any] {
            lastEtag = envelope["etag"] as? String ?? lastEtag
        }

        // ── Desired state.
        let items = (response["desired"] as? [[String: Any]] ?? []).map { row in
            DesiredReconciler.Item(
                desiredId: row["desired_id"] as? String ?? "",
                kind: row["kind"] as? String ?? "",
                spec: (row["spec"] as? [String: Any] ?? [:]).compactMapValues { "\($0)" })
        }
        let outcome = DesiredReconciler.reconcile(
            items: items,
            runningVersion: version,
            quarantined: readQuarantine(),
            staged: Set(stagedVersions()))

        pendingReports = outcome.reports
        for action in outcome.actions { perform(action, client: client) }
    }

    static func applyPolicy(_ envelope: [String: Any]) {
        let keys = SigningKeys.load()
        var body: String?
        if let jws = envelope["jws"] as? String {
            guard PolicyStore.verify(jws: jws, keys: keys) != nil else {
                // ⚠️ A policy that does not verify is DISCARDED, and the
                // cached one is untouched. Overwriting with an unverified
                // document would make the signing check theatre.
                enqueueLocal(
                    type: "policy.rejected", cls: .audit, data: ["reason": "signature_invalid"])
                return
            }
            body = jws
        } else if let document = envelope["document"] {
            body = (try? JSONSerialization.data(withJSONObject: document))
                .map { String(decoding: $0, as: UTF8.self) }
            enqueueLocal(type: "policy.unsigned", cls: .audit, data: [:])
        }
        guard let body else { return }

        // ⚠️ Promote the CURRENT policy to LKG before overwriting it, and only
        // after the new one has verified. That ordering is what makes V8's
        // fallback real: a corrupt write leaves a known-good file behind it.
        if let current = try? Data(contentsOf: URL(fileURLWithPath: Paths.currentPolicy)) {
            try? current.write(to: URL(fileURLWithPath: Paths.lkgPolicy), options: .atomic)
        }
        try? Data(body.utf8).write(
            to: URL(fileURLWithPath: Paths.currentPolicy), options: .atomic)

        lastEtag = envelope["etag"] as? String
        appliedVersion = envelope["policy_version"] as? Int
        enqueueLocal(
            type: "policy.applied", cls: .audit,
            data: ["policy_version": appliedVersion ?? 0, "etag": lastEtag ?? ""])

        rewriteDeadfall()
    }

    /// §4.6 — "rewritten by the sync daemon whenever the schedule changes".
    static func rewriteDeadfall() {
        guard let policy = loadedPolicy() else { return }
        let entries = DeadfallSchedule.entries(
            policy: policy.document, now: Date(), systemZone: TimeZone.current)
        let plist = DeadfallSchedule.plist(
            entries: entries, programPath: Paths.deadfallBinary)

        let existing = try? String(contentsOfFile: Paths.deadfallPlist, encoding: .utf8)
        guard existing != plist else { return }
        guard (try? Data(plist.utf8).write(
            to: URL(fileURLWithPath: Paths.deadfallPlist), options: .atomic)) != nil
        else { return }

        // launchd re-reads a `StartCalendarInterval` only on reload.
        _ = DeviceState.shell("/bin/launchctl", ["bootout", "system/com.hpc.deadfall"])
        _ = DeviceState.shell("/bin/launchctl", ["bootstrap", "system", Paths.deadfallPlist])
        enqueueLocal(
            type: "agent.deadfall_rescheduled", cls: .audit, data: ["entries": entries.count])
    }

    static func perform(_ action: DesiredReconciler.Action, client: Client) {
        switch action {
        case .stagePackage(let version, let url, let sha256):
            stagePackage(version: version, url: url, sha256: sha256)
        case .rotateCredential(let desiredId):
            rotate(client, desiredId: desiredId)
        }
    }

    // MARK: - Credential rotation

    /// Rotate once `rotate_after` has passed, at most once per tick.
    ///
    /// ⚠️ A failed rotation is not an error worth escalating: the old
    /// credential is valid for another 24 h by construction, and the next
    /// tick tries again. What must never happen is a rotation *loop* — hence
    /// the server's 409 on a second rotation inside an open window, which
    /// arrives here as a plain failure and changes nothing.
    static func rotateIfDue(_ client: Client) {
        guard let credential = DeviceState.loadCredential(),
              let rotateAfter = credential.rotateAfter,
              rotateAfter <= Date()
        else { return }
        rotate(client, desiredId: "")
    }

    /// ⚠️ **The old token stays on disk until the new one has been used.**
    ///
    /// The server keeps both valid for 24 h, so the failure this guards is not
    /// the server's — it is a power cut between "server issued a new token"
    /// and "agent wrote it". Keeping `previous_token` means the next boot can
    /// still authenticate, and a device that cannot authenticate has to be
    /// re-enrolled by hand, on site.
    static func rotate(_ client: Client, desiredId: String) {
        guard let current = DeviceState.loadCredential() else { return }
        do {
            let response = try client.rotateCredential(["desired_id": desiredId])
            guard let credential = response["credential"] as? [String: Any],
                  let token = credential["token"] as? String
            else { return }

            try DeviceState.saveCredential(
                .init(
                    token: token,
                    keyId: credential["key_id"] as? String ?? current.keyId,
                    issuedAt: Date(),
                    rotateAfter: (credential["rotate_after"] as? String)
                        .flatMap(ISO8601DateFormatter.hpcParse),
                    previousToken: current.token))
            client.updateToken(token)
            // An empty id means we rotated on the clock rather than because
            // the server asked; there is nothing to report converged.
            if !desiredId.isEmpty {
                pendingReports.append(
                    .init(desiredId: desiredId, status: "converged", detail: nil))
            }
            enqueueLocal(type: "agent.credential_rotated", cls: .audit, data: [:])
        } catch {
            // Not terminal: the old credential is still valid for 24 h and the
            // server re-sends the desired item next tick.
            enqueueLocal(
                type: "agent.degraded", cls: .audit, data: ["reason": "rotation_failed"])
        }
    }

    // MARK: - Package staging

    /// Download and verify. ⚠️ **The sync daemon never installs** — it stages,
    /// and the supervisor re-verifies and runs `installer`. Two processes,
    /// two digest checks, and the one holding root's installer is the one with
    /// no network.
    static func stagePackage(version: String, url: String, sha256: String) {
        guard let source = URL(string: url) else { return }
        try? FileManager.default.createDirectory(
            atPath: Paths.pkgCache, withIntermediateDirectories: true)

        let destination = Paths.pkg(version)
        let temporary = destination + ".tmp"
        guard let data = try? Data(contentsOf: source) else {
            enqueueLocal(
                type: "agent.degraded", cls: .audit,
                data: ["reason": "pkg_download_failed", "version": version])
            return
        }
        guard (try? data.write(to: URL(fileURLWithPath: temporary), options: .atomic)) != nil
        else { return }

        let actual = DeviceState.shell("/usr/bin/shasum", ["-a", "256", temporary])
            .split(separator: " ").first.map(String.init)?.lowercased()
        guard actual == sha256.lowercased() else {
            try? FileManager.default.removeItem(atPath: temporary)
            enqueueLocal(
                type: "agent.degraded", cls: .audit,
                data: ["reason": "pkg_digest_mismatch", "version": version])
            return
        }

        // Record the pin next to the pkg so the supervisor — which has no
        // network and never saw `desired[]` — can re-verify it.
        try? Data(sha256.lowercased().utf8).write(
            to: URL(fileURLWithPath: destination + ".sha256"), options: .atomic)
        // rename(2), so the supervisor never sees a partial file.
        try? FileManager.default.moveItem(atPath: temporary, toPath: destination)
        enqueueLocal(type: "agent.pkg_staged", cls: .audit, data: ["version": version])
    }

    // MARK: - Telemetry

    static func flushEventsIfDue(_ client: Client, _ queue: Queue) {
        let census = (try? queue.census()) ?? .init()
        let due = Date().timeIntervalSince(lastEventFlush)
            >= TimeInterval(telemetry().flushIntervalS)
        // "immediately for any `class: audit` event" — an enforcement action
        // must not wait five minutes to become visible to a worried parent.
        guard due || census.auditCount > 0 else { return }

        var size = batchSize
        for _ in 0..<maxBatchesPerTick {
            guard let rows = try? queue.batch(limit: size), !rows.isEmpty else { break }
            do {
                let response = try client.events(eventsBody(rows))
                let accepted = response["accepted_event_ids"] as? [String] ?? []
                try? queue.acknowledge(accepted)

                // A per-event rejection is permanent by construction — the
                // server only ever emits `retryable: false` — so drop them
                // rather than re-sending a poisoned batch for ever.
                let rejected = (response["rejected_events"] as? [[String: Any]] ?? [])
                    .compactMap { $0["event_id"] as? String }
                try? queue.acknowledge(rejected)

                lastEventFlush = Date()
                if accepted.count + rejected.count < rows.count { break }
            } catch let problem as Client.Problem {
                if problem.action == .halveBatch { size = max(1, size / 2); continue }
                if problem.action == .dropBatch { try? queue.acknowledge(rows.map(\.eventId)) }
                handle(problem)
                break
            } catch {
                break
            }
        }
    }

    static func eventsBody(
        _ rows: [Queue.Row], identity: DeviceState.Identity? = DeviceState.loadIdentity()
    ) -> [String: Any] {
        [
            "contract": 1,
            "device_id": identity?.deviceId ?? "",
            "boot_id": bootId,
            "events": rows.map { row in
                var event: [String: Any] = [
                    "event_id": row.eventId,
                    "ts": iso(row.ts),
                    "type": row.type,
                    "class": row.cls.rawValue,
                    "data": row.data,
                ]
                if let seq = row.seq { event["seq"] = seq }
                if let bootId = row.bootId { event["boot_id"] = bootId }
                return event
            },
        ]
    }

    static func applyEviction(_ queue: Queue) {
        guard let census = try? queue.census() else { return }
        let plan = QueuePolicy.plan(census: census, limits: limits(), now: Date())
        guard !plan.isEmpty, let evicted = try? queue.evict(plan), evicted.total > 0 else { return }

        evictedSinceLastSync += evicted.total
        // §5.7's first honesty rule: the hole is itself data.
        enqueueLocal(
            type: "queue.evicted", cls: .audit,
            data: QueuePolicy.evictedEvent(
                counts: evicted.counts, oldestLost: evicted.oldest, newestLost: evicted.newest,
                reason: plan.evictions.first?.reason ?? "cap"))
    }

    /// The caps, from the policy rather than from this build.
    ///
    /// ⚠️ These were hard-coded defaults until the `telemetry` block was
    /// decoded. A parent who lowered `max_queue_events` changed a row in
    /// Postgres and nothing on the device — a control that looks like a
    /// control and is not.
    static func limits() -> QueuePolicy.Limits {
        let config = telemetry()
        return .init(
            maxEvents: config.maxQueueEvents,
            maxBytes: config.maxQueueBytes,
            maxAgeDays: config.maxQueueAgeDays,
            auditRetentionDays: config.auditRetentionDays)
    }

    // MARK: - Errors

    static func handle(_ problem: Client.Problem) {
        switch problem.action {
        case .decommission:
            // The single sanctioned exception (A.7): authenticated,
            // parent-initiated, and only ever from `/sync`.
            decommission()
        case .haltSyncKeepEnforcing:
            halted = String(problem.status)
            enqueueLocal(
                type: "agent.degraded", cls: .audit,
                data: ["reason": "sync_halted", "status": problem.status])
        case .reenroll:
            try? FileManager.default.removeItem(atPath: Paths.credential)
        default:
            break
        }
    }

    /// §4.7: "the agent uninstalls itself, posts a final `agent.decommissioned`
    /// event, and `launchctl bootout`s itself."
    ///
    /// ⚠️ The order matters and is the opposite of the obvious one: report
    /// first, then remove the policy, then boot out. Booting out the enforcer
    /// before the final event is flushed loses the one record that says this
    /// was deliberate rather than a failure.
    static func decommission() {
        halted = "decommissioned"
        enqueueLocal(type: "agent.decommissioned", cls: .audit, data: [:])
        if let client, let queue {
            _ = try? client.events(eventsBody((try? queue.batch(limit: batchSize)) ?? []))
        }
        for path in [Paths.currentPolicy, Paths.lkgPolicy, Paths.credential, Paths.deadfallPlist] {
            try? FileManager.default.removeItem(atPath: path)
        }
        for job in ["deadfall", "enforcer", "sync"] {
            _ = DeviceState.shell("/bin/launchctl", ["bootout", "system/com.hpc.\(job)"])
        }
    }

    // MARK: - Reading what the enforcer left

    static func loadedPolicy() -> PolicyStore.Loaded? {
        let current = try? String(contentsOfFile: Paths.currentPolicy, encoding: .utf8)
        let lkg = try? String(contentsOfFile: Paths.lkgPolicy, encoding: .utf8)
        guard case .success(let loaded) = PolicyStore.load(
            currentJWS: current, lkgJWS: lkg, keys: SigningKeys.load())
        else { return nil }
        return loaded
    }

    static func nextBoundary() -> Date? {
        guard let policy = loadedPolicy() else { return nil }
        return BedtimePredicate.evaluate(policy: policy.document, now: Date()).nextBoundaryAt
    }

    static func readEnforcerHealth() -> (writtenAt: Date?, lastDecision: String?, ageS: TimeInterval) {
        guard let data = FileManager.default.contents(atPath: Paths.health),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return (nil, nil, 86_400) }
        let writtenAt = (row["ts"] as? String).flatMap(ISO8601DateFormatter.hpcParse)
        return (
            writtenAt, row["last_decision"] as? String,
            writtenAt.map { Date().timeIntervalSince($0) } ?? 86_400
        )
    }

    static func readQuarantine() -> Set<String> {
        guard let data = FileManager.default.contents(atPath: Paths.quarantine),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [String]
        else { return [] }
        return Set(rows)
    }

    static func stagedVersions() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Paths.pkgCache)) ?? []
        return names.filter { $0.hasSuffix(".pkg") }.map { String($0.dropLast(4)) }
    }

    // MARK: - Small things

    static func enqueueLocal(type: String, cls: QueuePolicy.Class, data: [String: Any]) {
        try? queue?.enqueue([.init(type: type, cls: cls, bootId: bootId, data: data)])
    }

    static func writeHealth(decision: String) {
        let row: [String: Any] = [
            "ts": iso(Date()), "tick_seq": tickSeq, "version": version,
            "last_decision": decision,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        try? data.write(to: URL(fileURLWithPath: Paths.syncHealth), options: .atomic)
    }

    /// `HPC_BASE_URL` in the plist, else `base_url` from enrolment.
    static func resolveBaseURL() -> URL? {
        if let raw = ProcessInfo.processInfo.environment["HPC_BASE_URL"],
           let url = URL(string: raw) { return url }
        guard let data = FileManager.default.contents(atPath: Paths.deviceIdentity),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = row["base_url"] as? String
        else { return nil }
        return URL(string: raw)
    }

    static func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
