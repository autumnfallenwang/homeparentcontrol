import Foundation

/// The policy document (§4.3) — the JWS payload, decoded.
///
/// ⚠️ **A tolerant reader (R1).** Unknown fields are ignored, not rejected: a
/// server one minor version ahead must not brick an agent. Unknown enum values
/// degrade to the safe default rather than throwing (R5), and "safe" here
/// always means *more* enforcement.
///
/// ⚠️ There is deliberately **no `fail_mode`** and **no `staleness.max_age`**.
/// X11 removed the first (a configuration field that can only be read when it
/// does not matter); X1c forbids the second (a TTL that stops enforcement is a
/// remotely-triggerable bypass — unplug the cable for three days and bedtime
/// evaporates). If either appears in a payload it is ignored here, which is
/// the point.
public struct PolicyDocument: Codable, Equatable, Sendable {

    public struct Subject: Codable, Equatable, Sendable {
        public let childId: String
        public let displayName: String

        enum CodingKeys: String, CodingKey {
            case childId = "child_id"
            case displayName = "display_name"
        }
    }

    public struct Warning: Codable, Equatable, Sendable {
        public let leadMinutes: Int
        public let channel: String

        enum CodingKeys: String, CodingKey {
            case leadMinutes = "lead_minutes"
            case channel
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            leadMinutes = try c.decode(Int.self, forKey: .leadMinutes)
            // R5 — an unrecognised channel degrades to the LOUDER one. A
            // warning that should have been modal and silently became a banner
            // is a warning she can miss.
            let raw = (try? c.decode(String.self, forKey: .channel)) ?? "modal"
            channel = (raw == "banner" || raw == "modal") ? raw : "modal"
        }
    }

    public struct ActionOptions: Codable, Equatable, Sendable {
        public let shutdownGraceS: Int
        public let escalateAfterFailures: Int

        enum CodingKeys: String, CodingKey {
            case shutdownGraceS = "shutdown_grace_s"
            case escalateAfterFailures = "escalate_after_failures"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let grace = (try? c.decode(Int.self, forKey: .shutdownGraceS)) ?? 300
            // ⚠️ X12 — the floor is 60, not 0. A grace of zero silently
            // reconstitutes bare shutdown and deletes the whole lock → grace →
            // shutdown ladder without anyone editing the action. Clamped on
            // the agent too, because the agent is the thing that would act on
            // it if a server ever sent one.
            shutdownGraceS = max(60, min(3600, grace))
            escalateAfterFailures =
                (try? c.decode(Int.self, forKey: .escalateAfterFailures)) ?? 3
        }

        public init(shutdownGraceS: Int = 300, escalateAfterFailures: Int = 3) {
            self.shutdownGraceS = max(60, min(3600, shutdownGraceS))
            self.escalateAfterFailures = escalateAfterFailures
        }
    }

    public struct Window: Codable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let days: [String]
        public let restrictedFrom: String
        public let restrictedUntil: String
        public let action: String
        public let actionOptions: ActionOptions
        public let warnings: [Warning]

        enum CodingKeys: String, CodingKey {
            case id, label, days, action, warnings
            case restrictedFrom = "restricted_from"
            case restrictedUntil = "restricted_until"
            case actionOptions = "action_options"
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            label = (try? c.decode(String.self, forKey: .label)) ?? ""
            // ⚠️ STRICT, deliberately. An earlier draft had
            // `(try? …) ?? []` here, matching the tolerant style of the
            // fields around it — and a malformed `days` then became an EMPTY
            // days list, i.e. a window that matches no day and never
            // restricts anything. That is lever #7: a silent, remotely
            // deliverable way to leave the Mac usable past bedtime, caught
            // only because a broken test fixture happened to produce one.
            //
            // Tolerance (R1) is about not breaking on fields you do not
            // understand. It is NOT licence to default a field toward less
            // enforcement. A window that cannot be parsed must fail the whole
            // document, so LKG takes over and, if that fails too, §4.6's
            // fail-open fires LOUDLY — which is visible, unlike this was.
            days = try c.decode([String].self, forKey: .days)
            restrictedFrom = try c.decode(String.self, forKey: .restrictedFrom)
            restrictedUntil = try c.decode(String.self, forKey: .restrictedUntil)
            // R5 — an unknown action degrades to `lock`, never to `warn_only`.
            // Degrading downward would make an unrecognised value a bypass.
            let raw = (try? c.decode(String.self, forKey: .action)) ?? "lock"
            action = ["warn_only", "lock", "shutdown"].contains(raw) ? raw : "lock"
            actionOptions =
                (try? c.decode(ActionOptions.self, forKey: .actionOptions)) ?? ActionOptions()
            warnings = (try? c.decode([Warning].self, forKey: .warnings)) ?? []
        }
    }

    public struct Schedule: Codable, Equatable, Sendable {
        public let kind: String
        public let windows: [Window]

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = (try? c.decode(String.self, forKey: .kind)) ?? "windows"
            // ⚠️ Strict for the same reason. A malformed `windows` array
            // silently becoming "no windows" is "no bedtime", delivered by a
            // parser bug. Absent is fine — a policy set may genuinely have
            // none — but *unparseable* is corruption and must be treated as
            // corruption.
            if c.contains(.windows) {
                windows = try c.decode([Window].self, forKey: .windows)
            } else {
                windows = []
            }
        }

        enum CodingKeys: String, CodingKey { case kind, windows }
    }

    public struct Override: Codable, Equatable, Sendable {
        public let id: String
        public let type: String
        public let windowId: String?
        public let minutes: Int?
        public let effectiveDate: String
        /// ⚠️ NOT optional. A.8 — there is nowhere to store "never expires",
        /// so no payload can create a permanent relaxation.
        public let expiresAt: Date

        enum CodingKeys: String, CodingKey {
            case id, type, minutes
            case windowId = "window_id"
            case effectiveDate = "effective_date"
            case expiresAt = "expires_at"
        }
    }

    public let policyVersion: Int
    public let issuedAt: Date
    public let deviceId: String
    public let subject: Subject
    public let timezone: String
    public let schedule: Schedule
    public let overrides: [Override]

    enum CodingKeys: String, CodingKey {
        case subject, timezone, schedule, overrides
        case policyVersion = "policy_version"
        case issuedAt = "issued_at"
        case deviceId = "device_id"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        policyVersion = try c.decode(Int.self, forKey: .policyVersion)
        issuedAt = try c.decode(Date.self, forKey: .issuedAt)
        deviceId = try c.decode(String.self, forKey: .deviceId)
        subject = try c.decode(Subject.self, forKey: .subject)
        timezone = try c.decode(String.self, forKey: .timezone)
        // Strict: see Window.days. An unparseable schedule is corruption.
        schedule = c.contains(.schedule)
            ? try c.decode(Schedule.self, forKey: .schedule) : Schedule.empty
        // ⚠️ Overrides are the opposite case and CAN be tolerant: dropping a
        // relaxation errs toward MORE enforcement, which is the safe side.
        overrides = (try? c.decode([Override].self, forKey: .overrides)) ?? []
    }

    /// Decode from raw JWS payload bytes. The caller verifies the signature
    /// BEFORE calling this — verify the bytes, then parse.
    public static func decode(from data: Data) throws -> PolicyDocument {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = ISO8601DateFormatter.hpcParse(text) else {
                throw DecodingError.dataCorruptedError(
                    in: try decoder.singleValueContainer(),
                    debugDescription: "not an RFC 3339 instant: \(text)")
            }
            return date
        }
        return try decoder.decode(PolicyDocument.self, from: data)
    }
}

extension PolicyDocument.Schedule {
    static let empty = try! JSONDecoder().decode(
        PolicyDocument.Schedule.self, from: Data(#"{"kind":"windows","windows":[]}"#.utf8))
}

extension ISO8601DateFormatter {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let withoutFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// ⚠️ Both spellings. `withFractionalSeconds` REJECTS a timestamp that has
    /// none, and §4.3's own examples show both forms — a reader that accepts
    /// only one is not the tolerant reader R1 asks for, and the failure mode
    /// is a policy that will not parse at all, which is fail-open.
    static func hpcParse(_ text: String) -> Date? {
        withFraction.date(from: text) ?? withoutFraction.date(from: text)
    }
}
