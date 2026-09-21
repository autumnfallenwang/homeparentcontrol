---
name: strings-cannot-prove-swift-absence
description: Swift packs string literals ≤15 bytes into instruction immediates — `strings` finding nothing proves nothing
metadata:
  type: reference
---

**`strings` cannot prove a short Swift string literal is absent from a
binary.** Swift's small-string optimisation stores any literal of **15 UTF-8
bytes or fewer** inline in the 16-byte `String` struct, which the optimiser
emits as `mov`/`movk` immediates in the instruction stream rather than as an
entry in `__cstring`.

**Why:** on 2026-09-21, checking that the production agent pkg really
contained the real power-off and not the safe variant, `strings -a` found
**no `/sbin/shutdown`** in `hpc-enforcerd`. That reads as "the shutdown path
was optimised away" — alarming, since it is the last rung of the enforcement
ladder and the one thing never tested end to end.

It was there. `nm` showed the symbol, and `otool -tV` showed the literal
packed into two registers:

```
mov  x0, #0x732f   movk #0x6962,16   movk #0x2f6e,32   movk #0x6873,48
mov  x1, #0x7475   movk #0x6f64,16   movk #0x6e77,32
```

Little-endian, that is `/sbin/shutdown`.

⚠️ **The confusing part, and why a quick check misleads.**
`/usr/bin/pmset` is *also* 14 bytes and *does* appear in `strings` — because
it lives in an array literal (`LockPath.argv`), which needs real storage. So
two same-length literals in the same file behave differently depending on
how they are used. A one-off test program will not reproduce it either: a
trivial `swiftc -O` file kept the literal, which is what made the first
hypothesis look wrong.

**How to apply:** to check whether a Swift binary references something, use
`nm` for the symbol and `otool -tV` for the call site. Treat a `strings`
miss as no evidence either way. [[falsify-the-gate]]: before concluding from
a negative, confirm the method can produce a positive — here, `strings` found
`/usr/bin/pmset` and the long `DEV_ENFORCEMENT:` marker perfectly well, which
is exactly what made its silence about `/sbin/shutdown` look meaningful.

The property that *is* checkable this way: the safe variant's marker string
(`DEV_ENFORCEMENT: shutdown suppressed…`) is long, so its presence or absence
in `strings` is reliable — and that is how `build-pkg.sh --dev` output is
distinguished from a production pkg.
