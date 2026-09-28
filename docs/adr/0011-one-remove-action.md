# 0011 — One way to end a device: Remove, confirmed in place

- **Status:** accepted
- **Date:** 2026-09-28
- **Deciders:** Aaron Wang

## Context

§5.5 gave the parent UI two ways to end a device, **Revoke** and **Decommission**, each behind a typed
confirm word, because they look alike and do opposite things to enforcement. After the first real
install and decommission on hardware, the owner found it was too much for what the page is for. A
household adds a child, adds a device, sets it up with its code, and eventually removes it. Revoke only
matters when a credential has leaked, and in that case the Mac keeps enforcing rules the UI can never
change again. Nobody managing a home would pick that from a menu.

The same review turned up two real gaps:

- **A device that was never set up could not be removed at all.** Revoke and Decommission were offered
  only for enrolled devices, so test devices piled up as "not set up yet" with no way out.
- **Removing a device left its setup code working.** The enrol claim never checks the device's status,
  so pasting the old install command brought a decommissioned device back as `enrolled`. The
  integration test reproduced it (`201` where it should be `404`) before the fix.

## Decision

The UI offers **one action, Remove**, on every device row, and it calls the **Decommission** endpoint.
It is confirmed in place, the way homework removes a child: the row turns into "Remove X?", one line
saying what will happen, and **Remove** / **Cancel**. The typed word is gone from the UI. The server
still checks it, and the client sends it after the click.

Ending a device, by either endpoint, now also deletes its unused setup codes.

**Revoke stays an API endpoint with no button.** Removing it would change the agent contract (`401` →
`halt_sync_keep_enforcing`) for no gain. It remains the tool for a leaked credential, used by hand.

## Consequences

- The Settings page matches the job: add, set up, remove.
- The confirmation still has to be true for the device in front of the parent, so its sentence depends
  on status (`REMOVE_DEVICE.consequence` in `@hpc/contract`): a set-up device uninstalls and stops
  enforcing, a never-set-up one only loses its code, and a revoked one is told plainly that it
  *cannot* be told to uninstall.
- A one-click confirm is easier to hit by mistake than a typed word. It is also recoverable: the child
  is still there, and setting the Mac up again takes a new code and one pasted command.
- §5.5's "typed-confirmation actions" line in `design-decisions.md` is amended by this ADR.
