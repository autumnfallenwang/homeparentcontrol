import Foundation
import HPCAgentIO
import HPCCore
import Testing

@testable import HPCSyncKit

/// The daemon's side of `EnrolmentPolicy`: not just "410 is terminal", but
/// that the dead code actually leaves `enrolment_code` and the backoff stops.
///
/// ⚠️ Serialized: `SyncDaemon.cadence` is process-wide state.
@Suite(.serialized)
struct EnrolmentFailureTests {

    static func problem(_ status: Int, retryAfterS: Int? = nil) -> Client.Problem {
        .init(status: status, type: nil, title: nil, action: nil, retryAfterS: retryAfterS)
    }

    /// A scratch copy of the two files, never `/var/db/homeparentcontrol`.
    static func staged() throws -> (code: String, rejected: String) {
        let dir = NSTemporaryDirectory() + "hpc-enrol-\(UUID().uuidString.lowercased())"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let code = dir + "/enrolment_code"
        try Data("HPC-4NK4-CX9Y-B0M4".utf8).write(to: URL(fileURLWithPath: code))
        return (code, dir + "/enrolment_code.rejected")
    }

    @Test("★ an expired code is moved aside, so it is never sent again")
    func expiredCodeLeaves() throws {
        let paths = try Self.staged()
        SyncDaemon.cadence = .init()
        SyncDaemon.cadence.consecutiveFailures = 3

        let next = SyncDaemon.enrolmentFailed(
            Self.problem(410), codePath: paths.code, rejectedPath: paths.rejected)

        #expect(!FileManager.default.fileExists(atPath: paths.code))
        #expect(FileManager.default.fileExists(atPath: paths.rejected))
        // No backoff to escalate: there is nothing left to retry.
        #expect(SyncDaemon.cadence.consecutiveFailures == 0)
        #expect(next == Cadence.baseMs)
    }

    @Test("a 429 keeps the code and waits as long as the server asks")
    func rateLimitedKeepsCode() throws {
        let paths = try Self.staged()
        SyncDaemon.cadence = .init()

        let next = SyncDaemon.enrolmentFailed(
            Self.problem(429, retryAfterS: 120), codePath: paths.code, rejectedPath: paths.rejected)

        #expect(FileManager.default.fileExists(atPath: paths.code))
        #expect(SyncDaemon.cadence.consecutiveFailures == 1)
        #expect(next == 120_000)
    }

    @Test("no answer at all keeps the code and backs off")
    func unreachableKeepsCode() throws {
        let paths = try Self.staged()
        SyncDaemon.cadence = .init()

        _ = SyncDaemon.enrolmentFailed(
            Client.Transport.unreachable("cable out"),
            codePath: paths.code, rejectedPath: paths.rejected)

        #expect(FileManager.default.fileExists(atPath: paths.code))
        #expect(SyncDaemon.cadence.consecutiveFailures == 1)
    }
}
