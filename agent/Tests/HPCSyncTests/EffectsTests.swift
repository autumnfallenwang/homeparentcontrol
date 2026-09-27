import Foundation
import HPCAgentIO
import Testing

/// The one property of the modal warning that decides whether its outcome
/// means anything.
struct EffectsTests {

    /// If the dialog could outlive its runner, a dialog that WAS on screen
    /// would be killed and recorded as failed — the first on-hardware run's
    /// 60 s dialog against a 20 s timeout. Given up first, "exited" means
    /// "was shown" and "killed" means "never got there".
    @Test("★ the modal gives up before its runner would kill it")
    func modalGivesUpFirst() {
        #expect(TimeInterval(Effects.modalGiveUpS) < Effects.asUserTimeoutS)
    }
}
