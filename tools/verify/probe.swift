import Foundation
import CoreFoundation

let LOG = "/usr/local/var/hpc-verify/probe.log"
func say(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    if let h = FileHandle(forWritingAtPath: LOG) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
    else { try? line.write(toFile: LOG, atomically: true, encoding: .utf8) }
    FileHandle.standardError.write(line.data(using: .utf8)!)
}

// B3: does launchd deliver SIGTERM on full shutdown, or only on bootout?
signal(SIGTERM) { _ in
    let m = "\(Int(Date().timeIntervalSince1970)) SIGTERM_RECEIVED\n"
    if let h = FileHandle(forWritingAtPath: "/usr/local/var/hpc-verify/probe.log") {
        h.seekToEndOfFile(); h.write(m.data(using: .utf8)!)
    }
    exit(0)
}

say("START euid=\(geteuid()) argv=\(CommandLine.arguments)")

if CommandLine.arguments.contains("--dialog") {
    let dict: [CFString: Any] = [
        kCFUserNotificationAlertHeaderKey: "homeparentcontrol — A0 daemon test" as CFString,
        kCFUserNotificationAlertMessageKey: "A ROOT LaunchDaemon reached your GUI session. Type 1234 and press Submit." as CFString,
        kCFUserNotificationTextFieldTitlesKey: ["Override code"] as CFArray,
        kCFUserNotificationDefaultButtonTitleKey: "Submit" as CFString,
        kCFUserNotificationAlternateButtonTitleKey: "Cancel" as CFString,
    ]
    var err: Int32 = 0
    let flags = CFOptionFlags(kCFUserNotificationPlainAlertLevel) | CFUserNotificationSecureTextField(0)
    guard let n = CFUserNotificationCreate(nil, 90, flags, &err, dict as CFDictionary), err == 0 else {
        say("DIALOG_CREATE_FAILED err=\(err)"); exit(1) }
    say("DIALOG_CREATE_OK")
    var resp: CFOptionFlags = 0
    let rc = CFUserNotificationReceiveResponse(n, 0, &resp)
    let v = CFUserNotificationGetResponseValue(n, kCFUserNotificationTextFieldValuesKey, 0)
    say("DIALOG_RESULT rc=\(rc) button=\(resp & 0x3) text=\(v != nil ? "\"\(v! as String)\"" : "nil")")
    exit(0)
}
say("IDLE_LOOP begin")
while true { Thread.sleep(forTimeInterval: 30); say("tick") }
