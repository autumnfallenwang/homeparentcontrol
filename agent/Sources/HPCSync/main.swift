import Foundation
import HPCAgentIO
import HPCSyncKit

// ⚠️ The probe mode runs FIRST and exits, before any daemon state is touched.
// The sync daemon re-executes this same binary as the console user to read
// the window-server session — see `SessionProbe`. In that mode it must not
// open the queue, read a credential or touch the network.
if CommandLine.arguments.contains(SessionProbe.flag) {
    print(SessionProbe.report())
    exit(0)
}

// The whole executable. Everything testable lives in HPCSyncKit.
SyncDaemon.main()
