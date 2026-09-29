import Foundation
import HPCAgentIO
import HPCCore

/// ★ `lastEtag` and `appliedVersion` were memory only, so a restarted
/// daemon's first tick claimed no policy at all: the server marked the Mac
/// DEGRADED/policy_missing and sent the same rules again (22:12 on 28 Sep,
/// after a reboot). They now live on disk beside the policy.
extension SyncDaemon {

    static func writePolicyEtag(etag: String?, version: Int?, path: String = Paths.policyEtag) {
        guard let etag, let version,
              let data = try? JSONSerialization.data(
                  withJSONObject: ["etag": etag, "policy_version": version])
        else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    /// The saved etag, only when it names the policy actually in force: the
    /// current file, at the same version.
    ///
    /// ⚠️ Never on last-known-good. The server would answer "unchanged" to
    /// the broken current file's etag and never send a policy to replace it.
    static func restorePolicyEtag(
        source: PolicyStore.Source?, version: Int?, path: String = Paths.policyEtag
    ) -> (etag: String, version: Int)? {
        guard source == .current, let version,
              let data = FileManager.default.contents(atPath: path),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let etag = row["etag"] as? String, !etag.isEmpty,
              let saved = row["policy_version"] as? Int, saved == version
        else { return nil }
        return (etag, saved)
    }

    /// Once per process: what the previous one was told about this policy.
    static func recallPolicyEtag(for policy: PolicyStore.Loaded?) {
        guard lastEtag == nil else { return }
        guard let saved = restorePolicyEtag(
            source: policy?.source, version: policy?.document.policyVersion)
        else { return }
        lastEtag = saved.etag
        appliedVersion = saved.version
    }
}
