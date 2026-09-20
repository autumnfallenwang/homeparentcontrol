import CryptoKit
import Foundation
import Testing

@testable import HPCCore

/// Policy loading: verify the bytes, then parse — and fail open only when we
/// genuinely cannot determine the rules, never because verification was
/// inconvenient.
struct PolicyStoreTests {

    static let document = """
        {"policy_version":1,"issued_at":"2026-09-20T12:00:00.000Z",
         "device_id":"018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
         "subject":{"child_id":"c","display_name":"Lucy"},
         "timezone":"America/New_York","overrides":[],
         "schedule":{"kind":"windows","windows":[{"id":"w1","label":"n","days":["mon"],
           "restricted_from":"21:30","restricted_until":"07:00","action":"lock",
           "action_options":{"shutdown_grace_s":300,"escalate_after_failures":3},
           "warnings":[]}]}}
        """

    static func b64u(_ d: Data) -> String {
        d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Sign a payload exactly as the server's `signPolicy` does.
    static func sign(_ payload: String, key: Curve25519.Signing.PrivateKey, kid: String) -> String {
        let header = b64u(Data(#"{"alg":"EdDSA","typ":"JOSE","kid":"\#(kid)"}"#.utf8))
        let body = b64u(Data(payload.utf8))
        let signature = try! key.signature(for: Data("\(header).\(body)".utf8))
        return "\(header).\(body).\(b64u(signature))"
    }

    static func keyPair() -> (Curve25519.Signing.PrivateKey, PolicyStore.SigningKey) {
        let priv = Curve25519.Signing.PrivateKey()
        let jwk = PolicyStore.SigningKey(kid: "k1", x: b64u(priv.publicKey.rawRepresentation))
        return (priv, jwk)
    }

    // MARK: - Verification

    @Test("a correctly signed policy verifies and parses")
    func happyPath() {
        let (priv, jwk) = Self.keyPair()
        let jws = Self.sign(Self.document, key: priv, kid: "k1")
        let result = PolicyStore.load(currentJWS: jws, lkgJWS: nil, keys: [jwk])
        guard case .success(let loaded) = result else { Issue.record("expected success"); return }
        #expect(loaded.signatureValid)
        #expect(loaded.source == .current)
        #expect(loaded.document.schedule.windows.count == 1)
    }

    @Test("a TAMPERED payload does not verify")
    func tamperedPayload() {
        let (priv, jwk) = Self.keyPair()
        let jws = Self.sign(Self.document, key: priv, kid: "k1")
        let parts = jws.split(separator: ".")
        let forged = Self.b64u(Data(Self.document.replacingOccurrences(
            of: "21:30", with: "23:59").utf8))
        let tampered = "\(parts[0]).\(forged).\(parts[2])"

        let result = PolicyStore.load(currentJWS: tampered, lkgJWS: nil, keys: [jwk])
        guard case .failure(let error) = result else { Issue.record("expected failure"); return }
        #expect(error == .corrupt("signature did not verify (current)"))
    }

    @Test("a policy signed by a DIFFERENT key does not verify")
    func wrongKey() {
        let (priv, _) = Self.keyPair()
        let (_, otherJwk) = Self.keyPair()
        let jws = Self.sign(Self.document, key: priv, kid: "k1")
        // Same kid, different key material — the attacker's obvious move.
        let spoofed = PolicyStore.SigningKey(kid: "k1", x: otherJwk.x)
        guard case .failure = PolicyStore.load(currentJWS: jws, lkgJWS: nil, keys: [spoofed])
        else { Issue.record("a foreign key must not verify"); return }
    }

    /// ⚠️ `alg: none` is the classic JWT bypass. An algorithm we do not
    /// implement is a reason to REJECT, never to skip verification.
    @Test("alg:none is rejected, not honoured")
    func algNoneRejected() {
        let (_, jwk) = Self.keyPair()
        let header = Self.b64u(Data(#"{"alg":"none","kid":"k1"}"#.utf8))
        let body = Self.b64u(Data(Self.document.utf8))
        let forged = "\(header).\(body)."
        guard case .failure = PolicyStore.load(currentJWS: forged, lkgJWS: nil, keys: [jwk])
        else { Issue.record("alg:none must not be accepted"); return }
    }

    @Test("an unknown kid does not verify")
    func unknownKid() {
        let (priv, jwk) = Self.keyPair()
        let jws = Self.sign(Self.document, key: priv, kid: "rotated-away")
        guard case .failure = PolicyStore.load(currentJWS: jws, lkgJWS: nil, keys: [jwk])
        else { Issue.record("an unknown kid must not verify"); return }
    }

    @Test("no keys at all means nothing verifies")
    func noKeys() {
        let (priv, _) = Self.keyPair()
        let jws = Self.sign(Self.document, key: priv, kid: "k1")
        guard case .failure = PolicyStore.load(currentJWS: jws, lkgJWS: nil, keys: [])
        else { Issue.record("no keys must mean no trust"); return }
    }

    // MARK: - Last-known-good

    /// §3.2 step 2 — "on failure fall back to `policy.lkg.json`".
    @Test("a corrupt current falls back to LKG")
    func fallsBackToLKG() {
        let (priv, jwk) = Self.keyPair()
        let good = Self.sign(Self.document, key: priv, kid: "k1")
        let result = PolicyStore.load(
            currentJWS: "this is not a jws at all", lkgJWS: good, keys: [jwk])
        guard case .success(let loaded) = result else { Issue.record("expected LKG"); return }
        #expect(loaded.source == .lastKnownGood)
        #expect(loaded.signatureValid)
    }

    /// "On double failure ⇒ FAIL OPEN, loudly." The loudness is the caller's;
    /// what matters here is that it is a *failure*, not a silent empty policy.
    @Test("both corrupt is a FAILURE, never an empty policy")
    func doubleFailure() {
        let (_, jwk) = Self.keyPair()
        let result = PolicyStore.load(currentJWS: "junk.junk.junk", lkgJWS: "also junk", keys: [jwk])
        guard case .failure = result else {
            Issue.record("a double failure must surface, not degrade to no rules")
            return
        }
    }

    @Test("nothing on disk is `missing`, distinct from corrupt")
    func missing() {
        let result = PolicyStore.load(currentJWS: nil, lkgJWS: nil, keys: [])
        #expect(result == .failure(.missing))
    }

    // MARK: - Unsigned

    /// ⚠️ Unsigned acceptance is a PARAMETER, never something the daemon reads
    /// from disk or the environment at runtime.
    @Test("unsigned policy is refused by default")
    func unsignedRefusedByDefault() {
        let result = PolicyStore.load(currentJWS: Self.document, lkgJWS: nil, keys: [])
        guard case .failure(let error) = result else { Issue.record("expected refusal"); return }
        if case .unverifiable = error {} else { Issue.record("expected .unverifiable, got \(error)") }
    }

    @Test("unsigned policy loads when explicitly allowed, and says it is unverified")
    func unsignedAllowed() {
        let result = PolicyStore.load(
            currentJWS: Self.document, lkgJWS: nil, keys: [], allowUnsigned: true)
        guard case .success(let loaded) = result else { Issue.record("expected success"); return }
        #expect(!loaded.signatureValid, "the caller must be able to log policy_unsigned")
    }
}

extension PolicyStore.LoadFailure: @retroactive Equatable {}
extension Result: @retroactive Equatable where Success == PolicyStore.Loaded, Failure == PolicyStore.LoadFailure {
    public static func == (lhs: Self, rhs: Self) -> Bool {
        switch (lhs, rhs) {
        case (.failure(let a), .failure(let b)): return a == b
        default: return false
        }
    }
}
