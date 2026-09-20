import Foundation
import HPCCore

/// The control-plane client. **The only networking in the agent** (A.4).
///
/// ⚠️ **Total timeout must stay well under one enforcer tick.** V5 is exactly
/// this: "server accepts then hangs 120 s → locks at the boundary, proving
/// total sync timeout < one tick". Enforcement is a separate process so the
/// lock happens regardless, but a sync daemon that lets requests outlive their
/// own cadence stacks them, and a stack of hung requests is how a 60 s tick
/// quietly becomes a 10-minute one.
///
/// ⚠️ **X4 — plain HTTP, accepted.** There is no `tls:` block in the chart and
/// this client does not pretend otherwise. What follows from that, and is
/// enforced here: the credential is never placed in a URL or a query string,
/// and `decommission` — the one action that stops enforcement — is honoured
/// from `/sync` alone.
public final class Client {

    public struct Config: Sendable {
        public var baseURL: URL
        public var token: String?
        public var contract: Int
        public var requestTimeout: TimeInterval
        public var resourceTimeout: TimeInterval

        public init(
            baseURL: URL, token: String? = nil, contract: Int = 1,
            requestTimeout: TimeInterval = 15, resourceTimeout: TimeInterval = 20
        ) {
            self.baseURL = baseURL
            self.token = token
            self.contract = contract
            self.requestTimeout = requestTimeout
            self.resourceTimeout = resourceTimeout
        }
    }

    /// §4.7's machine-readable vocabulary, as the agent reads it.
    public enum Action: String, Equatable, Sendable {
        case dropBatch = "drop_batch"
        case haltSyncKeepEnforcing = "halt_sync_keep_enforcing"
        case reenroll
        case decommission
        case halveBatch = "halve_batch"
        case backoff
    }

    public struct Problem: Error, Equatable, Sendable {
        public let status: Int
        public let type: String?
        public let title: String?
        public let action: Action?
        public let retryAfterS: Int?
    }

    public enum Transport: Error {
        /// No response at all — cable out, DNS blackholed, server down. §4.6
        /// class D: **keep enforcing exactly as written, indefinitely.**
        case unreachable(String)
        case malformed(String)
    }

    public private(set) var config: Config
    private let session: URLSession

    public init(config: Config) {
        self.config = config
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = config.requestTimeout
        configuration.timeoutIntervalForResource = config.resourceTimeout
        configuration.waitsForConnectivity = false
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        self.session = URLSession(configuration: configuration)
    }

    public func updateToken(_ token: String) { config.token = token }

    // MARK: - Endpoints

    public func enroll(_ body: [String: Any]) throws -> [String: Any] {
        try post("enroll", body: body, authenticated: false, allowDecommission: false)
    }

    /// The tick, and the heartbeat (A.26).
    ///
    /// ⚠️ The ONLY endpoint permitted to produce `decommission`. §4.7's status
    /// table is written globally — `410 → decommission` — but `/enroll`
    /// returns 410 for a consumed code and `/events` deliberately accepts from
    /// a decommissioned device. Honouring 410 from either would let an
    /// unauthenticated reply, or a stale telemetry route, uninstall the agent.
    /// The server already guards this from its side; this is the other half,
    /// and both halves are cheap.
    public func sync(_ body: [String: Any]) throws -> [String: Any] {
        try post("sync", body: body, authenticated: true, allowDecommission: true)
    }

    public func events(_ body: [String: Any]) throws -> [String: Any] {
        try post("events", body: body, authenticated: true, allowDecommission: false)
    }

    public func rotateCredential(_ body: [String: Any]) throws -> [String: Any] {
        try post("credential/rotate", body: body, authenticated: true, allowDecommission: false)
    }

    // MARK: - Transport

    func post(
        _ path: String, body: [String: Any], authenticated: Bool, allowDecommission: Bool
    ) throws -> [String: Any] {
        var request = URLRequest(url: config.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json, application/problem+json", forHTTPHeaderField: "accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        if authenticated, let token = config.token {
            // A.13 — `x-api-key`, never a query parameter. See X4 above.
            request.setValue(token, forHTTPHeaderField: "x-api-key")
        }

        let (data, response) = try send(request)

        guard let http = response as? HTTPURLResponse else {
            throw Transport.malformed("no HTTP response")
        }
        let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]

        if (200..<300).contains(http.statusCode) {
            guard let parsed else { throw Transport.malformed("2xx with unreadable body") }
            return parsed
        }

        throw Client.interpret(
            status: http.statusCode,
            body: parsed,
            retryAfter: http.value(forHTTPHeaderField: "retry-after"),
            allowDecommission: allowDecommission)
    }

    /// Turn a non-2xx into a `Problem`. Separated from the socket so the one
    /// rule that can uninstall an agent is testable without a server.
    public static func interpret(
        status: Int, body: [String: Any]?, retryAfter: String?, allowDecommission: Bool
    ) -> Problem {
        var action = (body?["hpc_action"] as? String).flatMap(Action.init(rawValue:))

        // ★ The guard. `decommission` is the only `hpc_action` that stops
        // enforcement, and §4.7's status table hands it out for any 410 —
        // but `/enroll` returns 410 for an already-consumed code, from an
        // UNAUTHENTICATED endpoint. Honouring that would let anyone who can
        // answer a plain-HTTP request (X4) uninstall the agent by replying
        // `410` to an enrolment attempt.
        //
        // The server guards this too (`PRE_CREDENTIAL_PROBLEMS`). Both halves
        // are one comparison each, and the failure they prevent is a Mac that
        // never locks again.
        if action == .decommission && !allowDecommission {
            action = .haltSyncKeepEnforcing
        }
        return Problem(
            status: status,
            type: body?["type"] as? String,
            title: body?["title"] as? String,
            action: action,
            retryAfterS: retryAfter.flatMap(Int.init))
    }

    /// `URLSession`'s async API needs a runloop the daemon does not have on
    /// its timer queue, so the tick blocks on a semaphore with its own
    /// backstop. ⚠️ The `+5` is deliberate: the semaphore must outlast
    /// `resourceTimeout`, or a slow-but-alive server produces a spurious
    /// `unreachable` and a queue that never drains.
    private func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        var result: Result<(Data, URLResponse), Error>?
        let semaphore = DispatchSemaphore(value: 0)

        let task = session.dataTask(with: request) { data, response, error in
            if let error {
                result = .failure(Transport.unreachable(error.localizedDescription))
            } else if let data, let response {
                result = .success((data, response))
            } else {
                result = .failure(Transport.malformed("empty response"))
            }
            semaphore.signal()
        }
        task.resume()

        if semaphore.wait(timeout: .now() + config.resourceTimeout + 5) == .timedOut {
            task.cancel()
            throw Transport.unreachable("client-side timeout")
        }
        return try result!.get()
    }
}
