import CryptoKit
import Foundation

/// Loading a policy from disk and proving it was signed by the server.
///
/// ⚠️ **Verify the bytes, THEN parse.** The JWS payload is verified as raw
/// bytes before any JSON decoding happens, so verification covers exactly what
/// was signed and there is no canonicalisation question.
///
/// ⚠️ §3.2 step 2: "on failure fall back to `policy.lkg.json`; on double
/// failure ⇒ FAIL OPEN, **loudly**." Fail-open on IGNORANCE is correct — we
/// cannot determine the rules, so we must not lock — but it is only correct
/// while it is loud. §4.6: "fail-open is not fail-silent, and the entire
/// argument depends on that distinction holding."
public enum PolicyStore {

    public enum Source: String, Sendable {
        case current
        case lastKnownGood = "lkg"
    }

    public enum LoadFailure: Error, Equatable, Sendable {
        /// Nothing on disk at all. §4.6 class B.
        case missing
        /// Present but unreadable, unparseable, or the signature did not verify.
        /// §4.6 class C — all three are one branch, deliberately.
        case corrupt(String)
        /// No key configured and unsigned policy was not explicitly allowed.
        case unverifiable(String)
    }

    public struct Loaded: Sendable {
        public let document: PolicyDocument
        public let source: Source
        public let signatureValid: Bool
    }

    /// A signing key as delivered in the enrolment response.
    public struct SigningKey: Sendable, Equatable {
        public let kid: String
        /// base64url raw Ed25519 public key bytes, the JWK `x` member.
        public let x: String

        public init(kid: String, x: String) {
            self.kid = kid
            self.x = x
        }
    }

    /// Verify a compact JWS and return its payload bytes.
    ///
    /// Returns nil when the token is malformed, the `kid` matches no known
    /// key, or the signature does not verify. All three are the same answer to
    /// the caller: do not trust this.
    public static func verify(jws: String, keys: [SigningKey]) -> Data? {
        let parts = jws.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let headerData = base64url(String(parts[0])),
              let signature = base64url(String(parts[2])),
              let payload = base64url(String(parts[1]))
        else { return nil }

        guard let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any]
        else { return nil }
        // Only EdDSA. An `alg` we do not implement is not a reason to skip
        // verification — it is a reason to reject.
        guard (header["alg"] as? String) == "EdDSA" else { return nil }

        // A `kid` narrows which key to try; its absence means try them all.
        let kid = header["kid"] as? String
        let candidates = kid.map { k in keys.filter { $0.kid == k } } ?? keys
        guard !candidates.isEmpty else { return nil }

        let signingInput = Data("\(parts[0]).\(parts[1])".utf8)
        for key in candidates {
            guard let raw = base64url(key.x),
                  let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
            else { continue }
            if publicKey.isValidSignature(signature, for: signingInput) { return payload }
        }
        return nil
    }

    /// Load the policy, trying `current` then `lkg`.
    ///
    /// `allowUnsigned` exists for the pre-signing bootstrap and for tests. It
    /// is a **parameter**, not a file or an env var the daemon reads — a
    /// runtime switch for "accept unsigned policy" on a machine where the
    /// child has admin is lever #7 wearing a lab coat.
    public static func load(
        currentJWS: String?,
        lkgJWS: String?,
        keys: [SigningKey],
        allowUnsigned: Bool = false
    ) -> Result<Loaded, LoadFailure> {
        let attempts: [(Source, String?)] = [(.current, currentJWS), (.lastKnownGood, lkgJWS)]
        var lastError: LoadFailure = .missing

        for (source, token) in attempts {
            guard let token, !token.isEmpty else { continue }

            // An unsigned document is a bare JSON object, not a JWS.
            if !token.contains(".") || token.hasPrefix("{") {
                guard allowUnsigned else {
                    lastError = .unverifiable("policy is unsigned and unsigned policy is not allowed")
                    continue
                }
                guard let doc = try? PolicyDocument.decode(from: Data(token.utf8)) else {
                    lastError = .corrupt("unsigned policy did not parse")
                    continue
                }
                return .success(Loaded(document: doc, source: source, signatureValid: false))
            }

            guard let payload = verify(jws: token, keys: keys) else {
                lastError = .corrupt("signature did not verify (\(source.rawValue))")
                continue
            }
            guard let doc = try? PolicyDocument.decode(from: payload) else {
                lastError = .corrupt("verified payload did not parse (\(source.rawValue))")
                continue
            }
            return .success(Loaded(document: doc, source: source, signatureValid: true))
        }
        return .failure(lastError)
    }

    /// base64url, with the padding JWS omits.
    static func base64url(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s.append("=") }
        return Data(base64Encoded: s)
    }
}
