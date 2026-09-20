import CryptoKit
import Foundation

/// UUIDv7 event identifiers (📄 RFC 9562 §5.7).
///
/// v7 rather than v4 because the id is also the ordering key of last resort,
/// and because the server's `events` primary key is `(device_id, event_id)` —
/// a time-ordered key keeps that index appending rather than scattering.
///
/// ⚠️ **X5 — lowercase, and the server REJECTS rather than normalises.**
///
/// `Foundation.UUID.uuidString` returns UPPERCASE hex. Sending that gets every
/// event rejected with `retryable: false`, for ever, and the design document
/// is explicit that normalising server-side was rejected because it "keeps the
/// two-spelling hazard alive in the codebase". So the hazard is killed here,
/// at the only place ids are minted, and `EventIDTests` asserts it.
public enum EventID {

    public static func v7(now: Date = Date(), random: () -> UInt8 = { UInt8.random(in: 0...255) })
        -> String
    {
        var bytes = [UInt8](repeating: 0, count: 16)

        // 48 bits of Unix milliseconds, big-endian.
        let millis = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        for index in 0..<6 { bytes[index] = UInt8((millis >> (8 * (5 - UInt64(index)))) & 0xFF) }

        for index in 6..<16 { bytes[index] = random() }

        // Version 7 in the high nibble of byte 6; RFC 4122 variant in byte 8.
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80

        return format(bytes)
    }

    /// ★ A **deterministic** v7 for an event that already exists on disk.
    ///
    /// ⚠️ This is what makes "drains its queue without duplicating or losing
    /// events" true across a crash. `drain` enqueues a spool segment and then
    /// deletes it; if the process dies between those two steps the segment is
    /// re-parsed on the next boot. With `v7()`'s random tail, the same line
    /// would mint a *different* id, the queue's UNIQUE constraint would not
    /// fire, and the server would store the same enforcement action twice —
    /// under two ids, so no later de-duplication could ever tell.
    ///
    /// Deriving the tail from SHA-256 of the line makes re-parsing idempotent
    /// all the way to the server's `ON CONFLICT (device_id, event_id) DO
    /// NOTHING`. The timestamp prefix stays real, so ordering survives.
    public static func derived(from seed: String, at ts: Date) -> String {
        var bytes = [UInt8](repeating: 0, count: 16)

        let millis = UInt64(max(0, ts.timeIntervalSince1970 * 1000))
        for index in 0..<6 { bytes[index] = UInt8((millis >> (8 * (5 - UInt64(index)))) & 0xFF) }

        let digest = Array(SHA256.hash(data: Data(seed.utf8)))
        for index in 6..<16 { bytes[index] = digest[index - 6] }

        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80

        return format(bytes)
    }

    static func format(_ bytes: [UInt8]) -> String {
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return [
            hex.prefix(8),
            hex.dropFirst(8).prefix(4),
            hex.dropFirst(12).prefix(4),
            hex.dropFirst(16).prefix(4),
            hex.dropFirst(20),
        ].joined(separator: "-")
    }

    /// The server's `uuid` primitive, mirrored so a malformed id is caught
    /// before it costs a round trip and a permanent rejection.
    public static func isValid(_ text: String) -> Bool {
        let groups = text.split(separator: "-", omittingEmptySubsequences: false)
        guard groups.count == 5,
              groups.map(\.count) == [8, 4, 4, 4, 12]
        else { return false }
        return text.allSatisfy { $0 == "-" || ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }
}
