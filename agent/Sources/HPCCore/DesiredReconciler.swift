import Foundation

/// Desired-state reconciliation (§4.5).
///
/// > "Four kinds, no escape hatch, idempotent by `desired_id`, re-sent every
/// > tick until the SERVER observes convergence."
///
/// ⚠️ **R6 — `unsupported` is terminal.** An item the agent cannot action is
/// not an error and not a retry: it is a *reported outcome*, once, which the
/// server records and stops sending. Anything else turns a version the device
/// cannot run into an infinite tick-loop that looks like a healthy agent.
///
/// ⚠️ **D.5 — there is no generic escape hatch.** `override_key` is not a
/// kind, and `spec` is never evaluated as code, a command or a path. The
/// design document is explicit that a generic kind "would smuggle the deleted
/// command channel back in through the side door". An unrecognised kind is
/// `unsupported`; it is never "run it and see".
public enum DesiredReconciler {

    /// What this build can actually do. R4: advertise only what is
    /// implemented, so an unimplemented kind comes back `unsupported` and the
    /// parent learns it, instead of being pre-filtered into silence.
    public static let capabilities: [String] = [
        "policy.v1",
        "policy.signature.ed25519",
        "desired.agent_version",
        "desired.credential",
    ]

    public struct Item: Equatable, Sendable {
        public let desiredId: String
        public let kind: String
        /// Raw JSON. Opaque except for the one kind whose spec is documented.
        public let spec: [String: String]

        public init(desiredId: String, kind: String, spec: [String: String] = [:]) {
            self.desiredId = desiredId
            self.kind = kind
            self.spec = spec
        }
    }

    /// The only side effects a desired item may ask for. A closed set — this
    /// enum *is* the "no escape hatch" rule, expressed in the type system.
    public enum Action: Equatable, Sendable {
        /// Fetch and verify `pkg_url` against `sha256`, then stage it for the
        /// supervisor. The sync daemon downloads; it never installs.
        case stagePackage(version: String, url: String, sha256: String)
        /// Ask the server for a new credential.
        case rotateCredential(desiredId: String)
    }

    public struct Report: Equatable, Sendable {
        public let desiredId: String
        public let status: String
        public let detail: String?
    }

    public struct Outcome: Equatable, Sendable {
        public var actions: [Action] = []
        public var reports: [Report] = []
    }

    /// Reconcile one tick's `desired[]`.
    ///
    /// - `runningVersion`: what this binary is, for the converged check.
    /// - `quarantined`: versions the supervisor has already rolled back from.
    /// - `staged`: versions already sitting in the pkg cache.
    public static func reconcile(
        items: [Item],
        runningVersion: String,
        quarantined: Set<String>,
        staged: Set<String>
    ) -> Outcome {
        var outcome = Outcome()

        for item in items {
            switch item.kind {
            case "agent_version":
                guard let version = item.spec["version"] else {
                    outcome.reports.append(
                        Report(
                            desiredId: item.desiredId, status: "unsupported",
                            detail: "agent_version spec has no `version`"))
                    continue
                }

                // Already running it. §4.5: the server decides convergence
                // from `device.agent_version`, so this claim is advisory —
                // but sending it keeps the UI honest between ticks.
                if version == runningVersion {
                    outcome.reports.append(
                        Report(desiredId: item.desiredId, status: "converged", detail: nil))
                    continue
                }

                // ⚠️ "if version in quarantine: log, raise a notification,
                // done — **never reinstall a known-bad**." Reported as
                // `unsupported`, which is terminal, so the server stops
                // re-sending a version this machine has already proven it
                // cannot run. Without this the rollback loop is infinite:
                // install, crash, roll back, receive the same desired item.
                if quarantined.contains(version) {
                    outcome.reports.append(
                        Report(
                            desiredId: item.desiredId, status: "unsupported",
                            detail: "version \(version) is quarantined after a failed install"))
                    continue
                }

                // The digest is mandatory. §6.4: "the pinned SHA-256 is the
                // whole gate", because `installer -pkg` as root bypasses
                // Gatekeeper and there is no Developer ID certificate to
                // check. An item without one is not installable at any price.
                guard let url = item.spec["pkg_url"], let sha256 = item.spec["sha256"],
                      !sha256.isEmpty
                else {
                    outcome.reports.append(
                        Report(
                            desiredId: item.desiredId, status: "unsupported",
                            detail: "agent_version spec lacks pkg_url or sha256"))
                    continue
                }

                // Staged already: nothing for sync to do. Do NOT report
                // converged — the supervisor installs, and convergence is the
                // server's observation of a changed `agent_version`.
                if staged.contains(version) { continue }

                outcome.actions.append(
                    .stagePackage(version: version, url: url, sha256: sha256))

            case "credential":
                outcome.actions.append(.rotateCredential(desiredId: item.desiredId))

            default:
                // R6, and the whole of D.5. `diagnostics` and `self_test` land
                // here too: they are documented kinds with no documented spec,
                // and inventing one would be a command channel.
                outcome.reports.append(
                    Report(
                        desiredId: item.desiredId, status: "unsupported",
                        detail: "kind `\(item.kind)` is not implemented by this agent"))
            }
        }

        return outcome
    }
}
