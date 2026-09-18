#!/bin/bash
# PostToolUse(Edit|Write) hook: auto-format the just-written file using the
# project's formatter. Never blocks (PostToolUse runs after the tool already
# succeeded) — format failures are silenced so a missing binary can't break
# unrelated work.

FILE=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.jsonc)
    npx --no-install biome check --write "$FILE" 2>/dev/null
    ;;
  *.swift)
    # swiftlint defines no per-file format command in the devkit lookup, so the
    # engine skipped this case. Added by hand: --fix is per-file safe.
    swiftlint --fix --path "$FILE" 2>/dev/null
    ;;
  *)
    ;;
esac

exit 0
