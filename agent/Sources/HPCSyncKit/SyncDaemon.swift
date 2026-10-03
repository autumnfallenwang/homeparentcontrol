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
    public static let version = AgentVersion.current

    static var queue: Queue?
    static var client: Client?
    static var cadence = Cadence.Inputs()
    static var tickSeq = 0
    static var halted: String?
    static let bootId = UUID().uuidString.lowercased()
    static let startedAt = TimeBasis.now()
    /// For `uptime_s`: an age, so on the continuous clock.
    static let startedContinuous = TimeBasis.continuous()
    static var lastEtag: String?
    static var appliedVersion: Int?
    static var evictedSinceLastSync = 0
    /// ⚠️ On the CONTINUOUS clock. It was a wall-clock `Date`, so a clock set
    /// back an hour made the next flush "due" in an hour: Ivy's Mac sent no
    /// usage at all from 00:54 on 2026-10-03, after she moved it back.
    static var lastEventFlush: TimeInterval?
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

        // ★ A third, for lock and unlock between samples. Same queue, so it
        // and the sampler never touch `samplerState` at once.
        let session = DispatchSource.makeTimerSource(queue: dispatchQueue)
        session.schedule(
            deadline: .now() + .seconds(Sampler.sessionPollS),
            repeating: .seconds(Sampler.sessionPollS), leeway: .seconds(1))
        session.setEventHandler { sessionTick() }
        session.resume()
        sessionTimer = session

        dispatchMain()
    }

    /// Held so the timers are not deallocated the moment `main` returns.
    static var samplerTimer: DispatchSourceTimer?
    static var sessionTimer: DispatchSourceTimer?

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
        // ⚠️ No `guard config.enabled` here any more (ADR 0014). With "Collect
        // usage data" off, the sampler used not to run at all — so lock,
        // unlock and sleep went unrecorded too, and a login after bedtime was
        // invisible. The switch now governs the app list only; `Sampler`
        // applies it to `app.usage_sample` and nothing else.

        let observation = SampleSource.observe(now: now())
        let output = Sampler.sample(observation, state: samplerState, telemetry: config)
        samplerState = output.state
        enqueueSamples(output.events, queue: queue)
    }

    /// Lock and unlock between samples — `Sampler.sessionPoll`.
    static func sessionTick() {
        guard let queue, let observation = SampleSource.observeSession(now: now()) else { return }
        let output = Sampler.sessionPoll(observation, state: samplerState)
        samplerState = output.state
        enqueueSamples(output.events, queue: queue)
    }

    static func enqueueSamples(_ events: [Sampler.Event], queue: Queue) {
        guard !events.isEmpty else { return }
        let rows = events.map { event -> Queue.Row in
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
        client = makeClient()
        if client == nil {
            say("no base URL configured; write it to \(Paths.baseURL)"
                + " (install.sh --base-url). Checking again every minute.")
        }
    }

    static func makeClient() -> Client? {
        guard let baseURL = resolveBaseURL() else { return nil }
        return Client(config: .init(baseURL: baseURL, token: DeviceState.loadCredential()?.token))
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
        // ⚠️ Retried every tick, and said out loud. This used to be a bare
        // `guard … else { return }` — a sync daemon started before its base
        // URL existed gave up once at `start()` and then did nothing, with no
        // health file, for as long as it ran.
        if queue == nil { queue = try? Queue() }
        if client == nil { client = makeClient() }
        guard let queue else {
            writeHealth(decision: "queue_unavailable")
            return Cadence.baseMs
        }
        guard let client else {
            writeHealth(decision: "no_base_url")
            return Cadence.baseMs
        }

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
        //
        // ⚠️ Every outcome writes `sync.health`. It used to write nothing on
        // a failed enrolment, which made the first real smoke test's failure
        // undiagnosable on the Mac — and a missing health file is exactly
        // what the supervisor reads as a DEAD sync daemon.
        if DeviceState.loadCredential() == nil {
            guard stagedEnrolmentCode() != nil else {
                // Nothing to try, which is not a failure: no backoff, so a
                // code the parent drops in is picked up within a minute.
                writeHealth(decision: "awaiting_enrolment_code")
                return Cadence.baseMs
            }
            switch enrol(client) {
            case .success: break
            case .failure(let error): return enrolmentFailed(error)
            }
        }

        // ── 4. The heartbeat. A.26 — the tick IS the heartbeat, and A.27 —
        //       telemetry never rides on it.
        //
        // ★ Trusted time first (ADR 0015): read the automatic-time setting and
        //   resolve the clock, so the heartbeat reports both truthfully.
        let networkTime = usingNetworkTime()
        let before = TimeBasis.resolve()
        let response: [String: Any]
        let sentAt = TimeBasis.continuous()
        do {
            response = try client.sync(syncBody(queue))
            cadence.consecutiveFailures = 0
            cadence.retryAfterS = nil
            evictedSinceLastSync = 0
        } catch let problem as Client.Problem {
            handle(problem)
            cadence.consecutiveFailures += 1
            cadence.retryAfterS = problem.retryAfterS
            superviseClock(before, networkTime: networkTime)
            writeHealth(decision: "sync_failed:\(problem.status)")
            return nextInterval()
        } catch {
            // §4.6 class D. Unreachable is not a reason to change anything
            // about enforcement; it is a reason to try again later.
            cadence.consecutiveFailures += 1
            superviseClock(before, networkTime: networkTime)
            writeHealth(decision: "unreachable")
            return nextInterval()
        }

        // ── 4a. The server's word on the time, for the enforcer to carry.
        recordServerTime(response, sentAt: sentAt, receivedAt: TimeBasis.continuous())
        offsetAtLastSync = before.offset
        superviseClock(TimeBasis.resolve(), networkTime: networkTime)

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
        Cadence.next(cadence, now: now()).intervalMs
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
            "uptime_s": Int(TimeBasis.continuous() - startedContinuous),
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

        recallPolicyEtag(for: policy)

        var policyState: [String: Any] = [:]
        if let etag = lastEtag { policyState["etag"] = etag }
        if let applied = appliedVersion { policyState["policy_version"] = applied }
        if let policy {
            policyState["using_lkg"] = policy.source == .lastKnownGood
            policyState["signature_valid"] = policy.signatureValid
            policyState["source"] = policy.source.rawValue
            policyState["age_s"] = Int(max(0, now().timeIntervalSince(policy.document.issuedAt)))
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
        writePolicyEtag(etag: lastEtag, version: appliedVersion)
        enqueueLocal(
            type: "policy.applied", cls: .audit,
            data: ["policy_version": appliedVersion ?? 0, "etag": lastEtag ?? ""])

        rewriteDeadfall()
    }

    /// §4.6 — "rewritten by the sync daemon whenever the schedule changes".
    static func rewriteDeadfall() {
        guard let policy = loadedPolicy() else { return }
        let entries = DeadfallSchedule.entries(
            policy: policy.document, now: now(), systemZone: TimeZone.current,
            wallOffset: TimeBasis.last?.offset ?? 0)
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
              rotateAfter <= now()
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
                    issuedAt: now(),
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
        let due = lastEventFlush.map {
            TimeBasis.continuous() - $0 >= TimeInterval(telemetry().flushIntervalS)
        } ?? true
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

                lastEventFlush = TimeBasis.continuous()
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
        // Trusted time: a clock set 15 days ahead must not age the queue out.
        let plan = QueuePolicy.plan(census: census, limits: limits(), now: now())
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
    ///
    /// What is removed, and why in this order, is `DecommissionPlan`.
    static func decommission() {
        halted = "decommissioned"
        enqueueLocal(type: "agent.decommissioned", cls: .audit, data: [:])
        if let client, let queue {
            _ = try? client.events(eventsBody((try? queue.batch(limit: batchSize)) ?? []))
        }
        let files = DecommissionPlan.state + DecommissionPlan.plists + DecommissionPlan.binaries
        for path in files {
            try? FileManager.default.removeItem(atPath: path)
        }
        _ = DeviceState.shell("/usr/sbin/pkgutil", ["--forget", DecommissionPlan.receipt])
        // Sync is last in the list, and booting it out ends this process.
        for job in DecommissionPlan.jobs {
            _ = DeviceState.shell("/bin/launchctl", ["bootout", "system/\(job)"])
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
        return BedtimePredicate.evaluate(policy: policy.document, now: now()).nextBoundaryAt
    }

    static func readEnforcerHealth() -> (writtenAt: Date?, lastDecision: String?, ageS: TimeInterval) {
        guard let data = FileManager.default.contents(atPath: Paths.health),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return (nil, nil, 86_400) }
        let writtenAt = (row["ts"] as? String).flatMap(ISO8601DateFormatter.hpcParse)
        return (
            writtenAt, row["last_decision"] as? String,
            writtenAt.map { now().timeIntervalSince($0) } ?? 86_400
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
        try? queue?.enqueue([.init(ts: now(), type: type, cls: cls, bootId: bootId, data: data)])
    }

    static func writeHealth(decision: String) {
        let row: [String: Any] = [
            "ts": iso(now()), "tick_seq": tickSeq, "version": version,
            "last_decision": decision,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        try? data.write(to: URL(fileURLWithPath: Paths.syncHealth), options: .atomic)
    }

    /// `$HPC_BASE_URL` if set, else the one line in `Paths.baseURL`.
    ///
    /// ⚠️ The file is the real mechanism; the variable is an override for
    /// running the binary by hand. Found on the first real smoke test, where
    /// neither documented route worked: `launchctl setenv` is refused under
    /// SIP, and a URL edited into the installed plist is silently reset by
    /// the next pkg upgrade, which reinstalls the plist. The old fallback,
    /// `base_url` in `device.json`, could never fire — nothing wrote it.
    static func resolveBaseURL(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        filePath: String = Paths.baseURL
    ) -> URL? {
        let fromFile = try? String(contentsOfFile: filePath, encoding: .utf8)
        let raw = [environment["HPC_BASE_URL"], fromFile]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        guard let raw, let url = URL(string: raw), let scheme = url.scheme,
              ["http", "https"].contains(scheme), url.host != nil
        else { return nil }
        return url
    }

    static func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }
}
