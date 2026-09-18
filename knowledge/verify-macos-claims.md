---
name: verify-macos-claims
description: Claims about observable macOS behaviour are not settled until observed — five of six audited documentation-derived claims in this project were wrong.
metadata:
  type: feedback
---

**Never state a claim about observable macOS behaviour as fact on the strength of documentation,
a forum post, or agreement between several agents. Test it.**

During POC 2 six load-bearing claims were audited against direct testing on the target OS.
**Five were wrong, partly wrong, or unverifiable:**

| Claim | How it was argued | Reality |
|---|---|---|
| Background Task Management leaves script/ad-hoc LaunchDaemons `disallowed` after reboot | **Three tracks agreed**, one citing Apple DTS directly | ❌ Both a `/bin/bash`-entry and an ad-hoc Mach-O daemon returned `[enabled, allowed]` and ran |
| `osascript` banners are dead because `ScriptEditor2` has no `ncprefs` registration | Registry inspection | ❌ The banner displays anyway |
| `os_log` redacts dynamic strings as `<private>` | Cited a CPython issue | ⚠️ Conclusion right, reason wrong — nothing was retrievable at all |
| A `.pkg` cannot downgrade | Munki documentation | ❌ `installer` downgraded happily, exit 0 |
| TCC grants detach on update under ad-hoc signing | One track, disputed by another | ✅ Confirmed — and worse than stated |

**Why:** these are not obscure corners. Each was confidently asserted, two had multi-track
agreement, and one cited Apple's own developer support. The BTM claim alone reversed the project's
central conclusion about which language the agent had to be written in.

**How to apply:** mark every load-bearing claim with its evidence class — ✅ observed by direct
test, 📄 documented only, ⚖️ judgement. When a documented claim would change a design decision,
**test it first**; most of these took under fifteen minutes. Treat cross-agent agreement as a
shared hypothesis, never as evidence. And note that everything verified so far is macOS 26.6.2 —
macOS 27 shipped 2026-09-14 and is untested, so version-fragile conclusions are hypotheses again.

See [[enforcement-invariant]] and `docs/research/poc2-findings.md` §5.
