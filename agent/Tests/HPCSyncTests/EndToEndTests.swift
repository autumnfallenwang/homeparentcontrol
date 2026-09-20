import Foundation
import HPCAgentIO
import HPCCore
import Testing

@testable import HPCSyncKit

/// The real wire protocol against a real control plane.
///
/// **Milestone 03's first exit criterion**: *the agent enrols against the
/// local control plane and exchanges its one-time token for a durable
/// credential.* Everything below runs the shipping `Client`, `Queue` and
/// `DeviceState` — no mocks, no stubs, no hand-rolled JSON.
///
/// ⚠️ **Skipped unless `HPC_E2E_BASE_URL` and `HPC_E2E_CODE` are set.** The
/// SwiftPM suite must stay runnable on a laptop with nothing installed, and
/// on a CI runner with no Postgres. `agent/scripts/e2e-local.sh` sets both
/// and runs this.
///
/// ⚠️ What this does NOT cover: the daemon's own plumbing, because `Paths`
/// points at `/var/db/homeparentcontrol` and writing there needs root. The
/// V-series covers that on real hardware. This covers the protocol.
struct EndToEndTests {

    static var baseURL: URL? {
        ProcessInfo.processInfo.environment["HPC_E2E_BASE_URL"].flatMap(URL.init(string:))
    }
    static var code: String? { ProcessInfo.processInfo.environment["HPC_E2E_CODE"] }
    static var enabled: Bool { baseURL != nil && code != nil }

    static func scratch(_ name: String) -> String {
        NSTemporaryDirectory() + "hpc-e2e-\(name)-\(UUID().uuidString.lowercased())"
    }

    /// Enrol once and hand back a client holding the durable credential.
    static func enrolled() throws -> (Client, DeviceState.Identity) {
        let client = Client(config: .init(baseURL: baseURL!))
        let response = try client.enroll([
            "code": code!,
            "hardware_uuid": "E2E-\(UUID().uuidString.lowercased())",
            "hostname": "e2e.local",
            "os_version": DeviceState.osVersion(),
            "arch": DeviceState.arch(),
            "agent_version": SyncDaemon.version,
        ])
        let credential = response["credential"] as! [String: Any]
        let token = credential["token"] as! String
        client.updateToken(token)
        return (
            client,
            .init(deviceId: response["device_id"] as! String, hardwareUUID: "E2E")
        )
    }

    // MARK: - ★ Enrolment

    @Test("★ the agent enrols and receives a durable credential", .enabled(if: enabled))
    func enrols() throws {
        let client = Client(config: .init(baseURL: Self.baseURL!))
        let response = try client.enroll([
            "code": Self.code!,
            "hardware_uuid": "E2E-\(UUID().uuidString.lowercased())",
            "agent_version": SyncDaemon.version,
        ])

        #expect(response["device_id"] is String)
        let credential = response["credential"] as? [String: Any]
        let token = credential?["token"] as? String
        #expect(token?.hasPrefix("hpc_dk_") == true)

        // ★ The signing keys must arrive with enrolment, or the enforcer has
        // no way to verify a policy offline on its very next tick.
        let keys = response["policy_signing_keys"] as? [[String: Any]] ?? []
        #expect(!keys.isEmpty, "no signing keys: every policy would fail verification")
        #expect(!SigningKeys.decode(keys).isEmpty, "the agent cannot read the keys it was sent")
    }

    /// ★ A one-time code is one-time. §5.5's re-issue guard.
    @Test("★ the same code cannot be redeemed twice", .enabled(if: enabled))
    func codeIsSingleUse() throws {
        _ = try Self.enrolled()
        let client = Client(config: .init(baseURL: Self.baseURL!))
        #expect(throws: Client.Problem.self) {
            try client.enroll([
                "code": Self.code!, "hardware_uuid": "E2E-second-machine",
            ])
        }
    }

    // MARK: - ★ The tick

    @Test("★ a durable credential drives a real sync", .enabled(if: enabled))
    func syncs() throws {
        let (client, identity) = try Self.enrolled()
        let queue = try Queue(path: Self.scratch("queue") + ".sqlite")
        SyncDaemon.queue = queue

        let response = try client.sync(SyncDaemon.syncBody(queue, identity: identity))
        #expect(response["server_time"] is String)
        #expect(response["device_status"] is String)

        // ⚠️ Clamped to [1000, 300000] by the agent, and the server's number
        // must be inside that or the clamp is doing real work in production.
        let poll = response["next_poll_after_ms"] as? Int
        #expect(poll != nil)
        #expect(poll! >= Cadence.floorMs && poll! <= Cadence.ceilingMs)
    }

    /// ★ The policy has to arrive signed, and the agent has to be able to
    /// verify it with the keys enrolment gave it. If this fails, the enforcer
    /// falls back to LKG for ever and nobody notices until a schedule change
    /// silently does not apply.
    @Test("★ the policy verifies against the enrolment keys", .enabled(if: enabled))
    func policyVerifies() throws {
        let client = Client(config: .init(baseURL: Self.baseURL!))
        let enrolment = try client.enroll([
            "code": Self.code!, "hardware_uuid": "E2E-\(UUID().uuidString.lowercased())",
        ])
        let credential = enrolment["credential"] as! [String: Any]
        client.updateToken(credential["token"] as! String)
        let keys = SigningKeys.decode(enrolment["policy_signing_keys"] as? [[String: Any]] ?? [])
        let identity = DeviceState.Identity(
            deviceId: enrolment["device_id"] as! String, hardwareUUID: "E2E")

        let queue = try Queue(path: Self.scratch("queue") + ".sqlite")
        SyncDaemon.queue = queue
        let response = try client.sync(SyncDaemon.syncBody(queue, identity: identity))

        guard let envelope = response["policy"] as? [String: Any],
              let jws = envelope["jws"] as? String
        else {
            Issue.record("no signed policy in the first sync")
            return
        }
        let payload = PolicyStore.verify(jws: jws, keys: keys)
        #expect(payload != nil, "the policy did not verify against the enrolment keys")

        // And it must decode with the enforcer's own strict reader.
        #expect(throws: Never.self) { try PolicyDocument.decode(from: payload!) }
    }

    // MARK: - ★ Telemetry, and the idempotency that survives an outage

    @Test("★ events post, and re-posting the same batch is idempotent", .enabled(if: enabled))
    func eventsAreIdempotent() throws {
        let (client, identity) = try Self.enrolled()
        let queue = try Queue(path: Self.scratch("queue") + ".sqlite")
        SyncDaemon.queue = queue

        let now = Date()
        let rows = (0..<5).map { index in
            Queue.Row(
                eventId: EventID.derived(from: "e2e-\(UUID().uuidString.lowercased())-\(index)", at: now),
                ts: now, type: "enforcement.action_taken", cls: .audit, seq: index,
                data: ["action": "lock"])
        }
        try queue.enqueue(rows)

        let body = SyncDaemon.eventsBody(rows, identity: identity)

        let first = try client.events(body)
        let acceptedFirst = first["accepted_event_ids"] as? [String] ?? []
        #expect(acceptedFirst.count == 5)
        #expect((first["rejected_events"] as? [[String: Any]] ?? []).isEmpty)

        // ★ §5.7's trap: a conflicting row is STILL accepted. If the server
        // returned only newly-inserted rows, the agent would re-send this
        // batch for ever, at 1/min, looking healthy the whole time.
        let second = try client.events(body)
        let acceptedSecond = second["accepted_event_ids"] as? [String] ?? []
        #expect(
            Set(acceptedSecond) == Set(acceptedFirst),
            "a re-sent batch must be fully accepted, or the queue never drains")
    }

    // MARK: - ★ Credential rotation

    @Test("★ rotation issues a new credential and the old one still works",
          .enabled(if: enabled))
    func rotates() throws {
        let (client, identity) = try Self.enrolled()
        let oldToken = client.config.token!

        let response = try client.rotateCredential(["desired_id": UUID().uuidString.lowercased()])
        let credential = response["credential"] as? [String: Any]
        let newToken = credential?["token"] as? String
        #expect(newToken != nil)
        #expect(newToken != oldToken)
        #expect(response["previous_credential_valid_until"] is String)

        // ★ The 24 h overlap. The whole reason it exists is a power cut
        // between the server issuing this token and the agent writing it.
        let withOld = Client(config: .init(baseURL: Self.baseURL!, token: oldToken))
        let queue = try Queue(path: Self.scratch("queue") + ".sqlite")
        SyncDaemon.queue = queue
        let body = SyncDaemon.syncBody(queue, identity: identity)
        #expect(throws: Never.self) { try withOld.sync(body) }

        // And the new one works too.
        let withNew = Client(config: .init(baseURL: Self.baseURL!, token: newToken))
        #expect(throws: Never.self) { try withNew.sync(body) }
    }

    // MARK: - ★ X1b

    /// ★ A rejected credential halts SYNC and nothing else. The test is that
    /// the action is `halt_sync_keep_enforcing` and never `decommission`.
    @Test("★ a bad credential halts sync without stopping enforcement",
          .enabled(if: enabled))
    func badCredentialHaltsSyncOnly() throws {
        let client = Client(config: .init(baseURL: Self.baseURL!, token: "hpc_dk_not_a_real_key"))
        let queue = try Queue(path: Self.scratch("queue") + ".sqlite")
        SyncDaemon.queue = queue
        let identity = DeviceState.Identity(
            deviceId: "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60", hardwareUUID: "E2E")

        do {
            _ = try client.sync(SyncDaemon.syncBody(queue, identity: identity))
            Issue.record("a forged credential was accepted")
        } catch let problem as Client.Problem {
            #expect(problem.status == 401 || problem.status == 403)
            #expect(problem.action == .haltSyncKeepEnforcing)
            #expect(problem.action != .decommission)
        }
    }
}

/// The outage exit criterion, against a real server rather than a fake one.
///
/// *Survives a server outage of several hours and drains its queue without
/// duplicating or losing events.* `QueueTests.survivesAnOutage` proves the
/// store does it; this proves the whole path does, including the wire.
///
/// The outage is simulated by pointing the client at a closed port — which is
/// what a cable out, a scaled-to-zero deployment and a blackholed DNS all
/// look like from here.
struct OutageEndToEndTests {

    static var enabled: Bool { EndToEndTests.enabled }

    /// A port with nothing listening. Connection refused, immediately.
    static let deadURL = URL(string: "http://127.0.0.1:9/api/agent/v1/")!

    @Test("★ events queued through an outage all arrive, exactly once",
          .enabled(if: enabled))
    func drainsAfterAnOutage() throws {
        let (liveClient, identity) = try EndToEndTests.enrolled()
        let queue = try Queue(path: EndToEndTests.scratch("outage") + ".sqlite")
        SyncDaemon.queue = queue

        // ── The outage. 240 ticks' worth of enforcement events pile up while
        // every flush fails. The agent must keep accepting them: a queue that
        // stopped taking writes would push back into the enforcer's spool,
        // and the spool is on the enforcer's critical path.
        let dead = Client(config: .init(baseURL: Self.deadURL, token: liveClient.config.token))
        let start = Date().addingTimeInterval(-4 * 3_600)
        var minted: Set<String> = []

        for tick in 0..<240 {
            let at = start.addingTimeInterval(Double(tick) * 60)
            let rows = [
                Queue.Row(
                    eventId: EventID.derived(from: "outage-\(tick)", at: at), ts: at,
                    type: "enforcement.action_taken", cls: .audit, seq: tick,
                    data: ["action": "lock", "tick": tick])
            ]
            minted.formUnion(rows.map(\.eventId))
            try queue.enqueue(rows)

            // Every tenth tick, try to flush. All of them must fail.
            if tick % 10 == 0 {
                #expect(throws: (any Error).self) {
                    try dead.events(SyncDaemon.eventsBody(rows, identity: identity))
                }
            }
        }
        #expect(try queue.census().auditCount == 240, "the outage lost events before the wire")

        // ── The server comes back. Drain in the agent's own batch size.
        var delivered: Set<String> = []
        var rounds = 0
        while rounds < 20 {
            rounds += 1
            let batch = try queue.batch(limit: 100)
            if batch.isEmpty { break }
            let response = try liveClient.events(
                SyncDaemon.eventsBody(batch, identity: identity))
            let accepted = response["accepted_event_ids"] as? [String] ?? []
            #expect(
                accepted.count == batch.count,
                "the server accepted fewer ids than were sent; the queue would never drain")
            delivered.formUnion(accepted)
            try queue.acknowledge(accepted)
        }

        #expect(try queue.census().totalCount == 0, "the queue did not drain")
        #expect(delivered == minted, "events were lost or invented across the outage")

        // ── ★ And a replay after the drain is still accepted, not rejected.
        // §5.7: "a conflicting row is still ACCEPTED — it is already durable.
        // Returning only newly-inserted rows would make the agent retry the
        // same batch forever."
        let replay = [
            Queue.Row(
                eventId: EventID.derived(from: "outage-0", at: start), ts: start,
                type: "enforcement.action_taken", cls: .audit, seq: 0,
                data: ["action": "lock", "tick": 0])
        ]
        let response = try liveClient.events(
            SyncDaemon.eventsBody(replay, identity: identity))
        #expect((response["accepted_event_ids"] as? [String] ?? []).count == 1)
    }

    /// ★ An unreachable server must not look like a rejected credential. The
    /// two produce completely different agent behaviour — backoff versus
    /// halt — and confusing them is how a network blip becomes a permanent
    /// stop.
    @Test("★ unreachable is a transport failure, never an hpc_action",
          .enabled(if: enabled))
    func unreachableIsNotAnAction() throws {
        let dead = Client(config: .init(baseURL: Self.deadURL, token: "hpc_dk_whatever"))
        let queue = try Queue(path: EndToEndTests.scratch("unreachable") + ".sqlite")
        SyncDaemon.queue = queue
        let identity = DeviceState.Identity(
            deviceId: "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60", hardwareUUID: "E2E")

        do {
            _ = try dead.sync(SyncDaemon.syncBody(queue, identity: identity))
            Issue.record("a closed port returned a response")
        } catch is Client.Problem {
            Issue.record("unreachable was classified as a protocol problem")
        } catch {
            #expect(error is Client.Transport)
        }
    }
}
