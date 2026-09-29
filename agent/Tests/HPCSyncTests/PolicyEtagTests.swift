import Foundation
import HPCCore
import Testing

@testable import HPCSyncKit

/// A restarted sync daemon must still say which rules it holds.
///
/// On 28 Sep a reboot left the etag in the old process's memory. The first
/// tick sent none, the server marked the Mac DEGRADED/policy_missing, and it
/// re-sent rules the Mac already had.
struct PolicyEtagTests {

    static func path() -> String {
        NSTemporaryDirectory() + "hpc-policy-etag-\(UUID().uuidString.lowercased()).json"
    }

    static let etag = #"W/"pol-abc-v9""#

    @Test("★ what was written comes back for the same policy, after a restart")
    func roundTrip() {
        let path = Self.path()
        SyncDaemon.writePolicyEtag(etag: Self.etag, version: 9, path: path)
        let saved = SyncDaemon.restorePolicyEtag(source: .current, version: 9, path: path)
        #expect(saved?.etag == Self.etag)
        #expect(saved?.version == 9)
    }

    @Test("a policy newer than the saved etag is not described by it")
    func otherVersion() {
        let path = Self.path()
        SyncDaemon.writePolicyEtag(etag: Self.etag, version: 9, path: path)
        #expect(SyncDaemon.restorePolicyEtag(source: .current, version: 10, path: path) == nil)
    }

    @Test("⚠️ on last-known-good, no etag — the server must send a replacement")
    func notOnLastKnownGood() {
        let path = Self.path()
        SyncDaemon.writePolicyEtag(etag: Self.etag, version: 9, path: path)
        #expect(SyncDaemon.restorePolicyEtag(source: .lastKnownGood, version: 9, path: path) == nil)
    }

    @Test("no policy, no file, or a garbled file: nothing")
    func nothing() throws {
        let path = Self.path()
        #expect(SyncDaemon.restorePolicyEtag(source: .current, version: 9, path: path) == nil)
        SyncDaemon.writePolicyEtag(etag: Self.etag, version: 9, path: path)
        #expect(SyncDaemon.restorePolicyEtag(source: nil, version: nil, path: path) == nil)
        try Data("{".utf8).write(to: URL(fileURLWithPath: path))
        #expect(SyncDaemon.restorePolicyEtag(source: .current, version: 9, path: path) == nil)
    }
}
