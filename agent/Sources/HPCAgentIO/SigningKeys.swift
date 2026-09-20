import Foundation
import HPCCore

/// The policy-signing public keys, as delivered in the enrolment response and
/// cached at `policy_signing_keys.json`.
///
/// ⚠️ Shared by the enforcer and the deadfall so there is exactly one reading
/// of this file. Two readings drift, and the way they drift is that one of
/// them ends up more tolerant than the other — which means one of them accepts
/// a policy the other rejects, on the same disk, at the same moment.
///
/// ⚠️ **There is no rotation channel for these keys.** The server signs with
/// one key whose thumbprint is its `kid`; if that key is ever replaced, every
/// enrolled device rejects every policy and falls back to LKG for ever. The
/// gap is recorded in `docs/milestones/03-agent-sync-and-lifecycle.md` rather
/// than papered over with a "fetch new keys" path, because a *self-updating
/// trust root fetched over plain HTTP* (X4) is not a fix, it is the vulnerability.
public enum SigningKeys {
    public static func load(path: String = Paths.signingKeys) -> [PolicyStore.SigningKey] {
        guard let data = FileManager.default.contents(atPath: path),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else { return [] }
        return decode(rows)
    }

    /// Tolerant (R1): a JWK whose `alg` or `kty` this build does not recognise
    /// is skipped, not fatal. An enrolment response carrying one future key
    /// must not cost the agent the key it can actually use.
    public static func decode(_ rows: [[String: Any]]) -> [PolicyStore.SigningKey] {
        rows.compactMap { row in
            guard let kid = row["kid"] as? String, let x = row["x"] as? String,
                  !kid.isEmpty, !x.isEmpty
            else { return nil }
            // Only Ed25519 verifies here. Anything else is stored by the
            // caller and ignored by us.
            if let kty = row["kty"] as? String, kty != "OKP" { return nil }
            if let crv = row["crv"] as? String, crv != "Ed25519" { return nil }
            return PolicyStore.SigningKey(kid: kid, x: x)
        }
    }

    /// Persist what enrolment returned, so the enforcer can verify offline on
    /// the very next tick. 0644: the public half of a signing pair is public.
    public static func save(_ rows: [[String: Any]], path: String = Paths.signingKeys) throws {
        let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}
