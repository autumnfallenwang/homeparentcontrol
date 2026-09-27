/// What to do after `POST /enroll` fails.
///
/// ⚠️ Found on the first real smoke test, and it cost the whole household an
/// hour. The daemon treated EVERY enrolment failure as transient and retried
/// on the ordinary 1 s, 2 s, 4 s… backoff. An expired code (`410`) is dead —
/// no retry can ever succeed — so the agent sent it four times in five
/// seconds, the server burned the code as abuse, the agent kept sending the
/// burned code (`409`), and that exhausted `/enroll`'s 20-per-hour GLOBAL
/// limiter: no Mac in the house could enrol until the window rolled. Nothing
/// on the Mac said why.
///
/// `/enroll` answers a dead code with exactly four statuses (`lib/problem.ts`).
/// Those are terminal for THIS code. Everything else may still succeed.
public enum EnrolmentPolicy {
    public enum Disposition: Equatable, Sendable {
        /// The code is dead: unknown (404), already used (409), expired
        /// (410), or the request itself is malformed (400). Stop sending it —
        /// only a NEW code on disk can make enrolment succeed.
        case rejected
        /// 429. The code may be fine; wait as long as the server says.
        case rateLimited
        /// No answer, or a 5xx. The code may be fine; ordinary backoff.
        case transient
    }

    /// `status` is nil when there was no HTTP answer at all.
    ///
    /// ⚠️ This decides whether to RETRY ENROLMENT, and nothing else. A 410
    /// here is an expired code, never `decommission` — that verb exists only
    /// on an authenticated `/sync` (A.7), and `Client` already refuses to
    /// honour it from `/enroll`. Nothing in this file can stop enforcement.
    public static func classify(status: Int?) -> Disposition {
        switch status {
        case 400, 404, 409, 410: return .rejected
        case 429: return .rateLimited
        default: return .transient
        }
    }
}
