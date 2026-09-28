import Foundation
import HPCCore
import Testing

@testable import HPCAgentIO

/// Decommission is the one sanctioned way enforcement ends (A.7). These check
/// the plan against what the package REALLY installs, so a renamed job can
/// never again leave the enforcer running after "stops enforcing anything".
struct DecommissionPlanTests {

    /// `agent/scripts/`, resolved from this file rather than the working
    /// directory — `swift test` runs from wherever it was invoked.
    static let scripts = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // HPCSyncTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // agent
        .appendingPathComponent("scripts")

    static func label(ofPlistXML data: Data) -> String? {
        let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
        return (plist as? [String: Any])?["Label"] as? String
    }

    /// Every job the agent installs: the packaged plists plus the deadfall's,
    /// which sync generates at runtime.
    static func installedLabels() throws -> Set<String> {
        let files = try FileManager.default.contentsOfDirectory(atPath: scripts.path)
            .filter { $0.hasPrefix("com.hpc.") && $0.hasSuffix(".plist") }
        var labels = Set<String>()
        for file in files {
            let data = try Data(contentsOf: scripts.appendingPathComponent(file))
            labels.insert(try #require(label(ofPlistXML: data), "\(file) has no Label"))
        }
        let deadfall = DeadfallSchedule.plist(entries: [], programPath: Paths.deadfallBinary)
        labels.insert(try #require(label(ofPlistXML: Data(deadfall.utf8))))
        return labels
    }

    @Test("★ boots out exactly the jobs the package installs — no typo can leave one running")
    func coversEveryInstalledJob() throws {
        let installed = try Self.installedLabels()
        #expect(installed.count >= 4, "the scan found \(installed) — too few to be real")
        #expect(Set(DecommissionPlan.jobs) == installed)
    }

    @Test("removes each job's plist, so a reboot starts nothing")
    func removesEveryPlist() {
        for job in DecommissionPlan.jobs {
            #expect(DecommissionPlan.plists.contains("\(Paths.launchDaemons)/\(job).plist"))
        }
        #expect(DecommissionPlan.plists.contains(Paths.deadfallPlist))
    }

    @Test("the supervisor goes first and sync — the process doing this — goes last")
    func order() {
        #expect(DecommissionPlan.jobs.first == "com.hpc.supervisor")
        #expect(DecommissionPlan.jobs.last == "com.hpc.sync")
    }

    @Test("leaves nothing a restarted sync could enforce or enrol with")
    func clearsState() {
        for path in [Paths.currentPolicy, Paths.lkgPolicy, Paths.credential, Paths.enrolmentCode] {
            #expect(DecommissionPlan.state.contains(path))
        }
    }
}
