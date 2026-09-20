import Foundation
import HPCCore
import Testing

@testable import HPCAgentIO

/// The soak marker — the one file whose PRESENCE can stop a Mac locking.
///
/// Every test asks the same thing: given this file on disk, does the agent
/// enforce? The answer must be yes for everything except one exact shape.
struct SoakMarkerTests {

    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    static func temporaryPath() -> String {
        NSTemporaryDirectory() + "hpc-soak-\(UUID().uuidString.lowercased()).json"
    }

    /// The question every test actually cares about.
    static func enforces(_ path: String, running: String = "0.2.0", now: Date = t0) -> Bool {
        ShadowMode.verdict(soak: SoakMarker.read(path: path), runningVersion: running, now: now)
            == .enforcing
    }

    // MARK: - Round trip

    @Test("a written marker reads back identically")
    func roundTrip() throws {
        let path = Self.temporaryPath()
        let soak = ShadowMode.Soak.begin(
            version: "0.2.0", at: Self.t0, expectDivergence: true, divergenceReason: "DST fix")
        try SoakMarker.write(soak, path: path)

        let read = try #require(SoakMarker.read(path: path))
        #expect(read.version == soak.version)
        #expect(abs(read.startedAt.timeIntervalSince(soak.startedAt)) < 1)
        #expect(abs(read.deadline.timeIntervalSince(soak.deadline)) < 1)
        #expect(read.expectDivergence)
        #expect(read.divergenceReason == "DST fix")
    }

    @Test("a fresh marker for the running version does shadow")
    func freshMarkerShadows() throws {
        let path = Self.temporaryPath()
        try SoakMarker.write(ShadowMode.Soak.begin(version: "0.2.0", at: Self.t0), path: path)
        // ⚠️ The control: if this were also `true`, every test below would
        // pass for the wrong reason.
        #expect(!Self.enforces(path))
    }

    // MARK: - ★ Every unreadable state enforces

    @Test("★ an absent marker enforces")
    func absentEnforces() {
        #expect(Self.enforces(Self.temporaryPath()))
    }

    @Test("★ an empty file enforces")
    func emptyEnforces() {
        let path = Self.temporaryPath()
        FileManager.default.createFile(atPath: path, contents: Data())
        #expect(Self.enforces(path))
    }

    @Test("★ a truncated write enforces")
    func truncatedEnforces() throws {
        let path = Self.temporaryPath()
        // What a power cut mid-write leaves behind.
        try Data(#"{"version":"0.2.0","started_at":"2026-09-2"#.utf8)
            .write(to: URL(fileURLWithPath: path))
        #expect(Self.enforces(path))
    }

    @Test("★ valid JSON of the wrong shape enforces")
    func wrongShapeEnforces() throws {
        let path = Self.temporaryPath()
        for body in [#"{}"#, #"[]"#, #""a string""#, #"{"version":"0.2.0"}"#,
                     #"{"version":123,"started_at":"x","deadline":"y"}"#] {
            try Data(body.utf8).write(to: URL(fileURLWithPath: path))
            #expect(Self.enforces(path), Comment(rawValue: "\(body) did not enforce"))
        }
    }

    @Test("★ unparseable timestamps enforce")
    func badTimestampsEnforce() throws {
        let path = Self.temporaryPath()
        try Data(
            #"{"version":"0.2.0","started_at":"not-a-date","deadline":"also-not"}"#.utf8
        ).write(to: URL(fileURLWithPath: path))
        #expect(Self.enforces(path))
    }

    /// ★ The tamper case. Someone with admin edits the deadline to next year.
    @Test("★ a hand-edited far-future deadline enforces")
    func tamperedDeadlineEnforces() throws {
        let path = Self.temporaryPath()
        let formatter = ISO8601DateFormatter()
        try Data(
            """
            {"version":"0.2.0",
             "started_at":"\(formatter.string(from: Self.t0))",
             "deadline":"\(formatter.string(from: Self.t0.addingTimeInterval(365 * 86_400)))"}
            """.utf8
        ).write(to: URL(fileURLWithPath: path))
        #expect(Self.enforces(path))
    }

    /// ★ The other tamper: name a version that is not running, hoping the
    /// check is on presence rather than identity.
    @Test("★ a marker naming another version enforces")
    func wrongVersionEnforces() throws {
        let path = Self.temporaryPath()
        try SoakMarker.write(ShadowMode.Soak.begin(version: "9.9.9", at: Self.t0), path: path)
        #expect(Self.enforces(path, running: "0.2.0"))
    }

    @Test("★ clearing the marker enforces")
    func clearedEnforces() throws {
        let path = Self.temporaryPath()
        try SoakMarker.write(ShadowMode.Soak.begin(version: "0.2.0", at: Self.t0), path: path)
        #expect(!Self.enforces(path))
        SoakMarker.clear(path: path)
        #expect(Self.enforces(path))
    }

    // MARK: - Soaked versions are never re-soaked

    @Test("★ a completed soak is remembered across a reinstall")
    func soakedIsRemembered() {
        let path = Self.temporaryPath()
        #expect(SoakMarker.soaked(path: path).isEmpty)
        SoakMarker.recordSoaked("0.2.0", path: path)
        SoakMarker.recordSoaked("0.3.0", path: path)
        #expect(SoakMarker.soaked(path: path) == ["0.2.0", "0.3.0"])
        // Idempotent — the supervisor may record the same version twice.
        SoakMarker.recordSoaked("0.2.0", path: path)
        #expect(SoakMarker.soaked(path: path).count == 2)
    }

    @Test("an unreadable soaked-list is empty, not fatal")
    func soakedToleratesGarbage() throws {
        let path = Self.temporaryPath()
        try Data("not json".utf8).write(to: URL(fileURLWithPath: path))
        #expect(SoakMarker.soaked(path: path).isEmpty)
    }
}
