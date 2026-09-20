import Foundation
import HPCAgentIO
import HPCCore

/// The sync daemon's durable identity: who this device is, and what it uses
/// to prove it.
public enum DeviceState {

    public struct Credential: Equatable, Sendable {
        public let token: String
        public let keyId: String
        public let issuedAt: Date
        public let rotateAfter: Date?
        /// Set while a rotation is in flight, so the old token survives the
        /// 24 h server-side overlap and a failed switch-over is recoverable.
        public let previousToken: String?

        public init(
            token: String, keyId: String, issuedAt: Date, rotateAfter: Date? = nil,
            previousToken: String? = nil
        ) {
            self.token = token
            self.keyId = keyId
            self.issuedAt = issuedAt
            self.rotateAfter = rotateAfter
            self.previousToken = previousToken
        }
    }

    public struct Identity: Equatable, Sendable {
        public let deviceId: String
        public let hardwareUUID: String
        public init(deviceId: String, hardwareUUID: String) {
            self.deviceId = deviceId
            self.hardwareUUID = hardwareUUID
        }
    }

    // MARK: - Credential

    public static func loadCredential(path: String = Paths.credential) -> Credential? {
        guard let data = FileManager.default.contents(atPath: path),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = row["token"] as? String, let keyId = row["key_id"] as? String
        else { return nil }
        return Credential(
            token: token,
            keyId: keyId,
            issuedAt: (row["issued_at"] as? String).flatMap(ISO8601DateFormatter.hpcParse) ?? Date(),
            rotateAfter: (row["rotate_after"] as? String).flatMap(ISO8601DateFormatter.hpcParse),
            previousToken: row["previous_token"] as? String)
    }

    /// ⚠️ **0600, and written atomically.** This is the one file in the agent
    /// whose leak is a real incident: it is a bearer token over plain HTTP
    /// (X4), so the filesystem is the only thing protecting it. A non-atomic
    /// write would also leave a zero-length credential behind a power cut,
    /// which costs a re-enrolment.
    public static func saveCredential(_ credential: Credential, path: String = Paths.credential)
        throws
    {
        var row: [String: Any] = [
            "token": credential.token,
            "key_id": credential.keyId,
            "issued_at": ISO8601DateFormatter().string(from: credential.issuedAt),
        ]
        if let rotateAfter = credential.rotateAfter {
            row["rotate_after"] = ISO8601DateFormatter().string(from: rotateAfter)
        }
        if let previous = credential.previousToken { row["previous_token"] = previous }

        let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        let url = URL(fileURLWithPath: path)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: path)
    }

    // MARK: - Identity

    public static func loadIdentity(path: String = Paths.deviceIdentity) -> Identity? {
        guard let data = FileManager.default.contents(atPath: path),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let deviceId = row["device_id"] as? String
        else { return nil }
        return Identity(
            deviceId: deviceId, hardwareUUID: row["hardware_uuid"] as? String ?? hardwareUUID())
    }

    public static func saveIdentity(_ identity: Identity, path: String = Paths.deviceIdentity)
        throws
    {
        let data = try JSONSerialization.data(
            withJSONObject: [
                "device_id": identity.deviceId, "hardware_uuid": identity.hardwareUUID,
            ], options: [.sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    // MARK: - Machine facts

    /// The hardware UUID — "the physical identity that survives an OS
    /// reinstall", and what §5.5's re-issue guard compares against.
    public static func hardwareUUID() -> String {
        let output = shell(
            "/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])
        for line in output.split(separator: "\n") where line.contains("IOPlatformUUID") {
            if let value = line.split(separator: "\"").last(where: { $0.contains("-") }) {
                return String(value)
            }
        }
        return ""
    }

    public static func osVersion() -> String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    public static func arch() -> String {
        #if arch(arm64)
            return "arm64"
        #else
            return "x86_64"
        #endif
    }

    public static func hostname() -> String { ProcessInfo.processInfo.hostName }

    public static func systemBootTime() -> Date {
        Date(timeIntervalSinceNow: -ProcessInfo.processInfo.systemUptime)
    }

    static func shell(_ path: String, _ args: [String]) -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return "" }
        let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
        task.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }
}
