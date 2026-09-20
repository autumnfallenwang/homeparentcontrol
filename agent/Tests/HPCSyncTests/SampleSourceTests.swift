import Foundation
import HPCAgentIO
import HPCCore
import Testing

@testable import HPCSyncKit

/// The sampler's probes, against this actual machine.
///
/// ⚠️ **Self-gating.** These run only when the test process IS the console
/// user, because that is when `lsappinfo` and `CGSessionCopyCurrentDictionary`
/// have a session to talk to. On a CI runner there is no console user and the
/// suite skips itself — no env var, no forgotten flag.
///
/// Everything here was probed by hand first; these tests exist so the probes
/// stay honest when macOS changes under them. [[verify-macos-claims]]: five of
/// six audited macOS claims in this project turned out to be wrong.
struct SampleSourceTests {

    /// True when this process can see a GUI session.
    static var live: Bool {
        guard let console = Effects.consoleUser() else { return false }
        return getuid() == console
    }

    // MARK: - Parsing, which needs no machine

    /// Probed output, 2026-09-20: two lines, values quoted for strings and
    /// bare for numbers.
    @Test("lsappinfo's two-line output parses")
    func parsesLsappinfo() {
        let output = """
            "CFBundleIdentifier"="com.microsoft.VSCode"
            "pid"=797
            """
        #expect(SampleSource.value(named: "CFBundleIdentifier", in: output)
            == "com.microsoft.VSCode")
        #expect(SampleSource.value(named: "pid", in: output) == "797")
        #expect(SampleSource.value(named: "absent", in: output) == nil)
    }

    @Test("a session probe line parses, and an unknown one is nil not false")
    func parsesSessionProbe() {
        #expect(SessionProbe.parse("locked=1 onconsole=1") == true)
        #expect(SessionProbe.parse("locked=0 onconsole=1") == false)
        // ⚠️ nil, not false. "I could not tell" and "it is unlocked" are
        // different, and the caller decides which way to resolve it.
        #expect(SessionProbe.parse("locked=unknown onconsole=unknown") == nil)
        #expect(SessionProbe.parse("") == nil)
    }

    // MARK: - ★ Live probes

    @Test("★ HIDIdleTime reads, and reads as SECONDS", .enabled(if: live))
    func idleIsSeconds() throws {
        let idle = try #require(SampleSource.hidIdleSeconds())
        #expect(idle >= 0)
        // ⚠️ The raw ioreg value is nanoseconds. Read as seconds it would be
        // ~235 million on a machine in active use — seven years idle — and
        // `active_s` would be zero for ever, presenting as "the child never
        // used the Mac". A machine running a test suite has been touched
        // within the last day.
        #expect(idle < 86_400, "idle of \(idle)s suggests nanoseconds leaked through")
    }

    @Test("★ the frontmost app resolves to a bundle id and a live pid",
          .enabled(if: live))
    func frontmostResolves() throws {
        let uid = try #require(Effects.consoleUser())
        let front = try #require(SampleSource.frontmost(uid: uid))
        let bundle = try #require(front.bundleId)
        #expect(bundle.contains("."), "expected a reverse-DNS bundle id, got \(bundle)")
        #expect((front.pid ?? 0) > 0)
    }

    /// ★ Probed 2026-09-20: the same pid, 39 hours old, read 0.9 then 0.2
    /// three seconds apart — so macOS's `%cpu` is a decaying average, not
    /// Linux's lifetime one. If it were a lifetime average the number would
    /// be useless for activity gating.
    @Test("★ per-process CPU reads as a plausible percentage", .enabled(if: live))
    func cpuReads() throws {
        let uid = try #require(Effects.consoleUser())
        let front = try #require(SampleSource.frontmost(uid: uid))
        let pid = try #require(front.pid)
        let cpu = try #require(SampleSource.cpuPercent(pid: pid))
        #expect(cpu >= 0)
        #expect(cpu < 10_000, "a percentage, even across many cores")
    }

    @Test("★ the session probe answers from inside the session", .enabled(if: live))
    func sessionProbeAnswers() {
        // Running the test suite implies an unlocked screen.
        #expect(SessionProbe.parse(SessionProbe.report()) == false)
    }

    /// ★ The whole observation, assembled — the thing the timer actually calls.
    @Test("★ one live observation produces a usable sample", .enabled(if: live))
    func observationIsComplete() throws {
        let first = SampleSource.observe()
        #expect(first.consoleUser != nil)
        #expect(first.frontmostBundleId != nil, "no frontmost app on a machine in use")
        #expect(!first.screenLocked)

        // Two observations a moment apart, folded through the pure core.
        var state = Sampler.sample(first, state: .init(), telemetry: .fallback).state
        Thread.sleep(forTimeInterval: 1.2)
        let output = Sampler.sample(
            SampleSource.observe(), state: state, telemetry: .fallback)
        state = output.state

        let usage = try #require(output.events.first { $0.type == "app.usage_sample" })
        let foreground = try #require(usage.data["foreground_s"])
        #expect(foreground > 0.5 && foreground < 5, "about a second, got \(foreground)")
        #expect(usage.text["bundle_id"]?.contains(".") == true)
    }
}

/// ★ The cross-language check: what Swift emits must be what the projector
/// parses.
///
/// `InteropTests` already proves the Node signer and the Swift verifier agree
/// on a JWS. This is the same question pointed the other way — R9 makes the
/// contract the shared artefact, and a sampler emitting `foregroundS` where
/// zod wants `foreground_s` would have every event stored perfectly (§5.7
/// never rejects on shape) and projected not at all. The symptom is an empty
/// report, not an error.
///
/// Both sides are guarded. This test fails if the Swift emitter drifts from
/// the committed fixture; `packages/contract/src/sampler-interop.test.ts`
/// fails if the fixture stops satisfying the schemas the projector uses.
struct SamplerInteropTests {

    /// Resolved from `#filePath`, not the working directory — `swift test`
    /// does not promise one.
    static var fixturePath: String {
        URL(fileURLWithPath: #filePath)                      // …/HPCSyncTests/Sample…swift
            .deletingLastPathComponent()                     // …/HPCSyncTests
            .deletingLastPathComponent()                     // …/Tests
            .deletingLastPathComponent()                     // …/agent
            .appendingPathComponent("Tests/HPCCoreTests/Fixtures/sampler-events.json")
            .path
    }

    /// Three observations covering the three shapes the projector reads: a
    /// baseline, a normal active interval, and a lock.
    static func emitted() -> [[String: Any]] {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let observations = [
            Sampler.Observation(
                at: now, uptime: 1_000, consoleUser: "501", screenLocked: false,
                frontmostBundleId: "com.apple.Safari", frontmostCpuPct: 12.5, idleS: 1),
            Sampler.Observation(
                at: now.addingTimeInterval(60), uptime: 1_060, consoleUser: "501",
                screenLocked: false, frontmostBundleId: "com.apple.Safari",
                frontmostCpuPct: 12.5, idleS: 1),
            Sampler.Observation(
                at: now.addingTimeInterval(120), uptime: 1_120, consoleUser: "501",
                screenLocked: true, frontmostBundleId: "com.apple.Safari",
                frontmostCpuPct: 0, idleS: 400),
        ]

        var state = Sampler.State()
        var rows: [[String: Any]] = []
        for observation in observations {
            let output = Sampler.sample(observation, state: state, telemetry: .fallback)
            state = output.state
            for event in output.events {
                // Exactly the `data` the sync daemon puts on the wire.
                var data: [String: Any] = [:]
                for (key, value) in event.data { data[key] = value }
                for (key, value) in event.text { data[key] = value }
                rows.append(["type": event.type, "data": data])
            }
        }
        return rows
    }

    static func canonical(_ rows: [[String: Any]]) throws -> Data {
        try JSONSerialization.data(
            withJSONObject: rows, options: [.sortedKeys, .prettyPrinted])
    }

    /// Regenerate with:
    ///   HPC_WRITE_SAMPLER_FIXTURE=1 swift test --package-path agent \
    ///     --filter SamplerInteropTests
    @Test("★ the committed fixture is what the sampler emits today")
    func fixtureIsCurrent() throws {
        let rows = Self.emitted()
        #expect(rows.count == 3, "a baseline state, one usage sample, one lock")
        let json = try Self.canonical(rows)

        if ProcessInfo.processInfo.environment["HPC_WRITE_SAMPLER_FIXTURE"] != nil {
            try json.write(to: URL(fileURLWithPath: Self.fixturePath))
            return
        }

        let committed = try #require(
            FileManager.default.contents(atPath: Self.fixturePath),
            "fixture missing — regenerate with HPC_WRITE_SAMPLER_FIXTURE=1")
        #expect(
            String(decoding: json, as: UTF8.self) == String(decoding: committed, as: UTF8.self),
            """
            The sampler's output drifted from the committed fixture. If that was \
            deliberate, regenerate it — and make sure the TypeScript side still \
            parses it, because nothing else notices a renamed field.
            """)
    }

    /// The fields the projector keys on, asserted here too so a rename is
    /// caught even if someone regenerates the fixture without reading it —
    /// [[read-every-generated-baseline]].
    @Test("★ the emitted keys are the snake_case ones zod expects")
    func keysAreSnakeCase() throws {
        let rows = Self.emitted()
        let usage = try #require(rows.first { $0["type"] as? String == "app.usage_sample" })
        let data = try #require(usage["data"] as? [String: Any])
        #expect(data["bundle_id"] != nil)
        #expect(data["foreground_s"] != nil)
        #expect(data["active_s"] != nil)
        #expect(data["cpu_pct"] != nil)

        let session = try #require(rows.first { $0["type"] as? String == "session.state" })
        let state = try #require(session["data"] as? [String: Any])
        #expect(state["state"] as? String == "active")
        #expect(state["console_user"] as? String == "501")
    }
}
