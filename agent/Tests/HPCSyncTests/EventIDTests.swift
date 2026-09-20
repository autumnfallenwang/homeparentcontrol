import Foundation
import Testing

@testable import HPCSyncKit

/// UUIDv7 event ids, and X5 — the trap that rejects rather than normalises.
struct EventIDTests {

    // MARK: - ★ X5

    /// ★ `Foundation.UUID.uuidString` is UPPERCASE. The server rejects a
    /// non-canonical id with `retryable: false` and deliberately does NOT
    /// normalise, because normalising "keeps the two-spelling hazard alive in
    /// the codebase". So the hazard dies at the only place ids are minted.
    @Test("★ a minted id is lowercase, so the server never rejects it")
    func lowercase() {
        for _ in 0..<200 {
            let id = EventID.v7()
            #expect(id == id.lowercased(), Comment(rawValue: "X5: `\(id)` is not canonical"))
            #expect(EventID.isValid(id))
        }
    }

    @Test("★ Foundation's own uuidString would fail our own validator")
    func foundationWouldFail() {
        // The guard is only meaningful if it can actually catch the mistake
        // it exists for.
        let naive = UUID().uuidString
        #expect(!EventID.isValid(naive))
        #expect(EventID.isValid(naive.lowercased()))
    }

    // MARK: - Shape

    @Test("the version nibble is 7 and the variant is RFC 4122")
    func versionAndVariant() {
        let id = EventID.v7()
        let hex = id.replacingOccurrences(of: "-", with: "")
        #expect(Array(hex)[12] == "7")
        #expect("89ab".contains(Array(hex)[16]))
    }

    @Test("ids minted later sort after ids minted earlier")
    func timeOrdered() {
        let early = EventID.v7(now: Date(timeIntervalSince1970: 1_700_000_000))
        let late = EventID.v7(now: Date(timeIntervalSince1970: 1_800_000_000))
        #expect(early < late)
    }

    @Test("the validator rejects malformed ids")
    func validatorRejects() {
        #expect(!EventID.isValid(""))
        #expect(!EventID.isValid("not-a-uuid"))
        #expect(!EventID.isValid("018f2a4c7b317c9e9d2a3f5b7c1e4a60"))
        #expect(!EventID.isValid("018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a6"))
        #expect(!EventID.isValid("018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a6g"))
    }

    // MARK: - Derived

    @Test("the same seed and instant always give the same id")
    func derivedIsStable() {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(EventID.derived(from: "x", at: at) == EventID.derived(from: "x", at: at))
    }

    @Test("a different seed gives a different id")
    func derivedIsDistinct() {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(EventID.derived(from: "x", at: at) != EventID.derived(from: "y", at: at))
    }

    @Test("a derived id is canonical and valid too")
    func derivedIsCanonical() {
        let id = EventID.derived(from: "seed", at: Date())
        #expect(id == id.lowercased())
        #expect(EventID.isValid(id))
        #expect(Array(id.replacingOccurrences(of: "-", with: ""))[12] == "7")
    }

    @Test("a thousand derived ids over a realistic drain do not collide")
    func derivedDoesNotCollide() {
        let at = Date()
        let ids = Set((0..<1_000).map { EventID.derived(from: "segment|\($0)", at: at) })
        #expect(ids.count == 1_000)
    }
}
