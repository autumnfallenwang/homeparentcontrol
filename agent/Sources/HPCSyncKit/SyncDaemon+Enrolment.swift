import Foundation
import HPCAgentIO
import HPCCore

// MARK: - Enrolment

/// Exchanging the one-time code for a durable credential, and what to do when
/// that fails. Its own file because the failure half — `EnrolmentPolicy`, the
/// rejected-code quarantine, and a health line for every outcome — is where
/// the first on-hardware run's worst problem lived (ADR 0010).
extension SyncDaemon {

    static func stagedEnrolmentCode() -> String? {
        guard let code = try? String(contentsOfFile: Paths.enrolmentCode, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty
        else { return nil }
        return code
    }

    static func enrol(_ client: Client) -> Result<Void, Error> {
        guard let code = stagedEnrolmentCode()
        else { return .failure(Client.Transport.malformed("no enrolment code on disk")) }

        do {
            let response = try client.enroll([
                "code": code,
                "hardware_uuid": DeviceState.hardwareUUID(),
                "hostname": DeviceState.hostname(),
                "os_version": DeviceState.osVersion(),
                "arch": DeviceState.arch(),
                "agent_version": version,
            ])
            guard let deviceId = response["device_id"] as? String,
                  let credential = response["credential"] as? [String: Any],
                  let token = credential["token"] as? String
            else { return .failure(Client.Transport.malformed("enrolment response")) }

            try DeviceState.saveCredential(
                .init(
                    token: token,
                    keyId: credential["key_id"] as? String ?? "",
                    issuedAt: (credential["issued_at"] as? String)
                        .flatMap(ISO8601DateFormatter.hpcParse) ?? Date(),
                    rotateAfter: (credential["rotate_after"] as? String)
                        .flatMap(ISO8601DateFormatter.hpcParse)))
            try DeviceState.saveIdentity(
                .init(deviceId: deviceId, hardwareUUID: DeviceState.hardwareUUID()))

            if let keys = response["policy_signing_keys"] as? [[String: Any]] {
                try? SigningKeys.save(keys)
            }
            client.updateToken(token)

            // ⚠️ The code is single-use and its presence on disk is the only
            // thing that would make the agent try to enrol again. Remove it
            // the instant it has been exchanged.
            try? FileManager.default.removeItem(atPath: Paths.enrolmentCode)
            enqueueLocal(type: "agent.started", cls: .audit, data: ["enrolled": true])
            return .success(())
        } catch {
            if let problem = error as? Client.Problem { handle(problem) }
            return .failure(error)
        }
    }

    /// ★ A dead code is moved aside and never sent again (`EnrolmentPolicy`).
    ///
    /// Retrying an expired code is what burned it, which is what exhausted
    /// the household's hourly enrolment budget on the first real run.
    ///
    /// The paths are parameters so a test can run this against a scratch
    /// directory; nothing but a test ever passes them.
    static func enrolmentFailed(
        _ error: Error,
        codePath: String = Paths.enrolmentCode,
        rejectedPath: String = Paths.rejectedEnrolmentCode
    ) -> Int {
        let problem = error as? Client.Problem
        let label = problem.map { String($0.status) } ?? "unreachable"

        switch EnrolmentPolicy.classify(status: problem?.status) {
        case .rejected:
            try? FileManager.default.removeItem(atPath: rejectedPath)
            try? FileManager.default.moveItem(atPath: codePath, toPath: rejectedPath)
            cadence.consecutiveFailures = 0
            cadence.retryAfterS = nil
            say("enrolment code rejected (\(label)); moved to \(rejectedPath)."
                + " Waiting for a new one — create it in the parent UI's Setup page.")
            writeHealth(decision: "enrol_rejected:\(label)")
            return Cadence.baseMs
        case .rateLimited:
            cadence.consecutiveFailures += 1
            cadence.retryAfterS = problem?.retryAfterS
            say("enrolment rate-limited (429); waiting as the server asks")
        case .transient:
            cadence.consecutiveFailures += 1
            cadence.retryAfterS = nil
            say("enrolment failed (\(label)); will retry with backoff")
        }
        writeHealth(decision: "enrol_failed:\(label)")
        return nextInterval()
    }

    /// One line to stderr, which launchd captures in `sync.log`. The daemon
    /// has no other local voice before enrolment: nothing reaches the
    /// control plane until there is a credential to send it with.
    static func say(_ message: String) {
        FileHandle.standardError.write(Data("hpc-sync: \(message)\n".utf8))
    }
}
