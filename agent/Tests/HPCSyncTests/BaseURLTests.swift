import Foundation
import Testing

@testable import HPCSyncKit

/// Where the sync daemon finds the control plane.
///
/// The first real smoke test found no working way to set it: `launchctl
/// setenv` is refused under SIP, and a plist edit is undone by the next pkg
/// upgrade. The file under `/var/db/homeparentcontrol` is the mechanism now.
struct BaseURLTests {

    static func file(_ contents: String?) throws -> String {
        let path = NSTemporaryDirectory() + "hpc-base-url-\(UUID().uuidString.lowercased())"
        if let contents { try Data(contents.utf8).write(to: URL(fileURLWithPath: path)) }
        return path
    }

    static let cluster = "http://homeparentcontrol-api.arch.internal/api/agent/v1/"

    @Test("★ the file is read, trailing newline and all — what `install.sh` writes")
    func readsFile() throws {
        let path = try Self.file(Self.cluster + "\n")
        let url = SyncDaemon.resolveBaseURL(environment: [:], filePath: path)
        #expect(url?.absoluteString == Self.cluster)
    }

    @Test("the environment overrides the file, for running the binary by hand")
    func environmentWins() throws {
        let url = SyncDaemon.resolveBaseURL(
            environment: ["HPC_BASE_URL": "http://127.0.0.1:8088/api/agent/v1/"],
            filePath: try Self.file(Self.cluster))
        #expect(url?.host == "127.0.0.1")
    }

    @Test("an empty variable does not mask the file")
    func emptyEnvironmentFallsThrough() throws {
        let url = SyncDaemon.resolveBaseURL(
            environment: ["HPC_BASE_URL": "  "], filePath: try Self.file(Self.cluster))
        #expect(url?.absoluteString == Self.cluster)
    }

    @Test(
        "nothing usable is nil — the daemon then says so every tick instead of going quiet",
        arguments: [nil, "", "hpc.local/api", "ftp://x/api/agent/v1/"] as [String?])
    func unusable(contents: String?) throws {
        let path = try Self.file(contents)
        #expect(SyncDaemon.resolveBaseURL(environment: [:], filePath: path) == nil)
    }
}
