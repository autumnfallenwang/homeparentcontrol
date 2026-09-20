import Foundation
import Testing

@testable import HPCCore

/// R6 (`unsupported` is terminal) and D.5 (no generic escape hatch).
struct DesiredReconcilerTests {

    static func reconcile(
        _ items: [DesiredReconciler.Item],
        running: String = "0.1.0",
        quarantined: Set<String> = [],
        staged: Set<String> = []
    ) -> DesiredReconciler.Outcome {
        DesiredReconciler.reconcile(
            items: items, runningVersion: running, quarantined: quarantined, staged: staged)
    }

    static func upgrade(
        _ version: String, id: String = "d1", sha: String = "9f2c", url: String = "https://x/p.pkg"
    ) -> DesiredReconciler.Item {
        .init(
            desiredId: id, kind: "agent_version",
            spec: ["version": version, "pkg_url": url, "sha256": sha])
    }

    // MARK: - ★ R6: unsupported is terminal

    /// ★ An unknown kind is reported once, never retried, and never guessed
    /// at. D.5 is explicit that a generic kind "would smuggle the deleted
    /// command channel back in through the side door".
    @Test("★ an unknown kind is reported unsupported, not actioned")
    func unknownKindIsUnsupported() {
        let out = Self.reconcile([.init(desiredId: "d9", kind: "run_script")])
        #expect(out.actions.isEmpty)
        #expect(out.reports.count == 1)
        #expect(out.reports[0].status == "unsupported")
        #expect(out.reports[0].desiredId == "d9")
    }

    @Test("documented-but-unimplemented kinds are unsupported, not silently dropped")
    func diagnosticsAndSelfTest() {
        let out = Self.reconcile([
            .init(desiredId: "d1", kind: "diagnostics"),
            .init(desiredId: "d2", kind: "self_test"),
        ])
        #expect(out.actions.isEmpty)
        #expect(out.reports.allSatisfy { $0.status == "unsupported" })
        #expect(out.reports.count == 2)
    }

    /// The capability list must not advertise what `reconcile` will reject —
    /// R4 exists so the parent learns the device cannot do a thing.
    @Test("every advertised desired.* capability is actually actionable")
    func capabilitiesMatchImplementation() {
        let advertised = DesiredReconciler.capabilities
            .filter { $0.hasPrefix("desired.") }
            .map { String($0.dropFirst("desired.".count)) }
        for kind in advertised {
            let item = kind == "agent_version"
                ? Self.upgrade("9.9.9")
                : DesiredReconciler.Item(desiredId: "d1", kind: kind)
            let out = Self.reconcile([item])
            #expect(
                !out.reports.contains { $0.status == "unsupported" },
                Comment(rawValue: "advertised `desired.\(kind)` came back unsupported"))
        }
    }

    // MARK: - agent_version

    @Test("the running version reports converged and stages nothing")
    func alreadyRunning() {
        let out = Self.reconcile([Self.upgrade("0.1.0")], running: "0.1.0")
        #expect(out.actions.isEmpty)
        #expect(out.reports[0].status == "converged")
    }

    @Test("a new version is staged for the supervisor")
    func stagesNewVersion() {
        let out = Self.reconcile([Self.upgrade("0.2.0")], running: "0.1.0")
        #expect(
            out.actions == [
                .stagePackage(version: "0.2.0", url: "https://x/p.pkg", sha256: "9f2c")
            ])
        #expect(out.reports.isEmpty)
    }

    /// ★ "never reinstall a known-bad". Without this the rollback loop never
    /// ends: install, crash, roll back, receive the same desired item, repeat.
    @Test("★ a quarantined version is never staged again")
    func quarantinedIsTerminal() {
        let out = Self.reconcile(
            [Self.upgrade("0.2.0")], running: "0.1.0", quarantined: ["0.2.0"])
        #expect(out.actions.isEmpty)
        #expect(out.reports[0].status == "unsupported")
    }

    /// ★ §6.4: `installer -pkg` as root bypasses Gatekeeper, and under D.7
    /// there is no Developer ID certificate, so the pinned digest is the whole
    /// gate. An item without one is not installable at any price.
    @Test("★ an agent_version with no sha256 is unsupported, never downloaded")
    func digestIsMandatory() {
        let item = DesiredReconciler.Item(
            desiredId: "d1", kind: "agent_version",
            spec: ["version": "0.2.0", "pkg_url": "https://x/p.pkg"])
        let out = Self.reconcile([item], running: "0.1.0")
        #expect(out.actions.isEmpty)
        #expect(out.reports[0].status == "unsupported")
    }

    @Test("an empty sha256 is treated as absent")
    func emptyDigestRejected() {
        let out = Self.reconcile([Self.upgrade("0.2.0", sha: "")], running: "0.1.0")
        #expect(out.actions.isEmpty)
        #expect(out.reports[0].status == "unsupported")
    }

    /// Already on disk: sync has nothing to do, and must NOT claim converged —
    /// the supervisor installs, and the server observes convergence from a
    /// changed `device.agent_version`.
    @Test("an already-staged version produces neither an action nor a claim")
    func stagedIsSilent() {
        let out = Self.reconcile(
            [Self.upgrade("0.2.0")], running: "0.1.0", staged: ["0.2.0"])
        #expect(out.actions.isEmpty)
        #expect(out.reports.isEmpty)
    }

    // MARK: - Idempotence

    @Test("reconciling the same item twice yields the same answer")
    func idempotent() {
        let items = [Self.upgrade("0.2.0"), .init(desiredId: "d2", kind: "credential")]
        #expect(Self.reconcile(items).actions == Self.reconcile(items).actions)
    }

    @Test("one bad item does not stop the others being actioned")
    func partialProgress() {
        let out = Self.reconcile([
            .init(desiredId: "d0", kind: "nonsense"),
            Self.upgrade("0.2.0", id: "d1"),
        ], running: "0.1.0")
        #expect(out.actions.count == 1)
        #expect(out.reports.count == 1)
    }
}
