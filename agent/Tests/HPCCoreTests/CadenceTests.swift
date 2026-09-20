import Foundation
import Testing

@testable import HPCCore

/// §4.2's cadence table, and the two clamps that make a server bug survivable.
struct CadenceTests {

    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: - The clamp

    @Test("no server suggestion is the 60 s base")
    func defaultsToBase() {
        let d = Cadence.next(.init(), now: Self.t0)
        #expect(d.intervalMs == 60_000)
        #expect(d.mode == .base)
    }

    @Test("a server asking for 1 ms is clamped up to the 1 s floor")
    func clampsFloor() {
        let d = Cadence.next(.init(serverSuggestionMs: 1), now: Self.t0)
        #expect(d.intervalMs == Cadence.floorMs)
    }

    @Test("a server asking for a day is clamped down to 300 s")
    func clampsCeiling() {
        let d = Cadence.next(.init(serverSuggestionMs: 86_400_000), now: Self.t0)
        #expect(d.intervalMs == Cadence.ceilingMs)
    }

    // MARK: - ★ The boundary rule may only ever SHORTEN

    @Test("near a boundary, a 60 s server suggestion shortens to 15 s")
    func boundaryShortens() {
        let d = Cadence.next(
            .init(serverSuggestionMs: 60_000, nextBoundaryAt: Self.t0.addingTimeInterval(600)),
            now: Self.t0)
        #expect(d.intervalMs == 15_000)
        #expect(d.mode == .boundary)
    }

    /// ★ The one-way rule. A parent watching the device page gets 5 s; being
    /// near bedtime must not push that back out to 15 s.
    @Test("★ the boundary rule never LENGTHENS an attended 5 s poll")
    func boundaryNeverLengthens() {
        let d = Cadence.next(
            .init(serverSuggestionMs: 5_000, nextBoundaryAt: Self.t0.addingTimeInterval(60)),
            now: Self.t0)
        #expect(d.intervalMs == 5_000)
        #expect(d.mode == .attended)
    }

    @Test("outside the 900 s lead the boundary changes nothing")
    func boundaryOutsideLead() {
        let d = Cadence.next(
            .init(serverSuggestionMs: 60_000, nextBoundaryAt: Self.t0.addingTimeInterval(1_800)),
            now: Self.t0)
        #expect(d.intervalMs == 60_000)
        #expect(d.mode == .base)
    }

    @Test("a boundary already past is ignored")
    func pastBoundaryIgnored() {
        let d = Cadence.next(
            .init(serverSuggestionMs: 60_000, nextBoundaryAt: Self.t0.addingTimeInterval(-60)),
            now: Self.t0)
        #expect(d.mode == .base)
    }

    // MARK: - Backoff

    @Test("backoff is full jitter across the doubling window")
    func fullJitter() {
        // `randomBelow` returns its argument minus one, so the test reads the
        // window's top rather than a random point in it.
        var windows: [Int] = []
        for failures in 1...12 {
            _ = Cadence.next(
                .init(consecutiveFailures: failures), now: Self.t0,
                randomBelow: { windows.append($0); return 0 })
        }
        #expect(windows.prefix(4) == [1_000, 2_000, 4_000, 8_000])
        // And it stops doubling at the ceiling, never above it.
        #expect(windows.allSatisfy { $0 <= Cadence.ceilingMs })
        #expect(windows.last == Cadence.ceilingMs)
    }

    @Test("a jittered zero still respects the 1 s floor")
    func jitterFloor() {
        let d = Cadence.next(
            .init(consecutiveFailures: 5), now: Self.t0, randomBelow: { _ in 0 })
        #expect(d.intervalMs == Cadence.floorMs)
        #expect(d.mode == .backoff)
    }

    @Test("Retry-After beats the exponent")
    func retryAfterWins() {
        let d = Cadence.next(
            .init(retryAfterS: 42, consecutiveFailures: 9), now: Self.t0,
            randomBelow: { _ in 0 })
        #expect(d.intervalMs == 42_000)
        #expect(d.reason == "retry_after")
    }

    /// ⚠️ A hostile or broken `Retry-After: 86400` must not silence the agent
    /// for a day — the ceiling applies to it as much as to anything else.
    @Test("★ an absurd Retry-After is still clamped to 300 s")
    func retryAfterClamped() {
        let d = Cadence.next(
            .init(retryAfterS: 86_400, consecutiveFailures: 1), now: Self.t0)
        #expect(d.intervalMs == Cadence.ceilingMs)
    }

    @Test("failures outrank a boundary — enforcement does not depend on sync")
    func backoffOutranksBoundary() {
        let d = Cadence.next(
            .init(
                serverSuggestionMs: 5_000, consecutiveFailures: 3,
                nextBoundaryAt: Self.t0.addingTimeInterval(60)),
            now: Self.t0, randomBelow: { $0 })
        #expect(d.mode == .backoff)
    }

    @Test("a success clears backoff immediately")
    func successClearsBackoff() {
        let d = Cadence.next(.init(serverSuggestionMs: 60_000, consecutiveFailures: 0),
                             now: Self.t0)
        #expect(d.mode == .base)
    }
}
