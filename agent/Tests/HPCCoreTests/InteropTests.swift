import Foundation
import Testing

@testable import HPCCore

/// ★ The language crossing.
///
/// The server signs in Node (`apps/api/src/policy/signing.ts`); the agent
/// verifies in Swift. Every other test in this suite signs and verifies with
/// CryptoKit on both sides, which proves CryptoKit agrees with itself and
/// nothing about the pair that actually ships.
///
/// The fixture here was produced by the real Node signing path. If base64url
/// padding, the `kid` derivation, the JSON member order inside the header or
/// the raw-vs-SPKI key encoding ever diverge between the two, this is where it
/// shows up — rather than at 21:30 on a child's Mac, as a policy that will not
/// verify and an agent that fails open.
struct InteropTests {

    static func fixture(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: nil,
                                                subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    @Test("a policy signed by the Node server verifies in Swift")
    func nodeSignedVerifies() throws {
        let jws = String(decoding: try Self.fixture("server-signed.jws"), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let jwkData = try Self.fixture("server-signed.jwk.json")
        let jwk = try #require(
            try JSONSerialization.jsonObject(with: jwkData) as? [String: String])

        let key = PolicyStore.SigningKey(kid: try #require(jwk["kid"]), x: try #require(jwk["x"]))
        let result = PolicyStore.load(currentJWS: jws, lkgJWS: nil, keys: [key])

        guard case .success(let loaded) = result else {
            Issue.record("the server's own signature did not verify: \(result)")
            return
        }
        #expect(loaded.signatureValid)
        #expect(loaded.document.policyVersion == 42)
        #expect(loaded.document.timezone == "America/New_York")
        #expect(loaded.document.schedule.windows.count == 1)
        #expect(loaded.document.schedule.windows[0].restrictedFrom == "21:30")
        #expect(loaded.document.schedule.windows[0].warnings.count == 4)
    }

    /// The `kid` is an RFC 7638 thumbprint computed independently on each side.
    /// If they disagree the agent cannot select a key, which on a rotation
    /// would silently strand every device.
    @Test("the kid the server derived is the one the agent matches on")
    func kidMatches() throws {
        let jws = String(decoding: try Self.fixture("server-signed.jws"), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let jwkData = try Self.fixture("server-signed.jwk.json")
        let jwk = try #require(
            try JSONSerialization.jsonObject(with: jwkData) as? [String: String])

        let header = try #require(PolicyStore.base64url(String(jws.split(separator: ".")[0])))
        let decoded = try #require(
            try JSONSerialization.jsonObject(with: header) as? [String: Any])
        #expect(decoded["kid"] as? String == jwk["kid"])
        #expect(decoded["alg"] as? String == "EdDSA")
    }

    /// And the whole point: that policy, evaluated, actually restricts.
    @Test("the server-signed policy produces a real bedtime")
    func serverPolicyEnforces() throws {
        let jws = String(decoding: try Self.fixture("server-signed.jws"), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let jwkData = try Self.fixture("server-signed.jwk.json")
        let jwk = try #require(
            try JSONSerialization.jsonObject(with: jwkData) as? [String: String])
        let key = PolicyStore.SigningKey(kid: try #require(jwk["kid"]), x: try #require(jwk["x"]))

        guard case .success(let loaded) = PolicyStore.load(
            currentJWS: jws, lkgJWS: nil, keys: [key]) else {
            Issue.record("expected the fixture to load")
            return
        }

        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        f.timeZone = TimeZone(identifier: "America/New_York")

        let bedtime = BedtimePredicate.evaluate(
            policy: loaded.document, now: f.date(from: "2026-09-21 22:00")!)
        #expect(bedtime.isRestricted)

        let afternoon = BedtimePredicate.evaluate(
            policy: loaded.document, now: f.date(from: "2026-09-21 16:00")!)
        #expect(!afternoon.isRestricted)
    }
}
