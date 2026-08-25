#!/bin/bash
# Combines this project's graft statusline (node/edge count, sync status,
# context %) with the global LED-gauge statusline (CTX/5H/7D/CDX rate-limit
# bars from ~/.claude/statusline-command.sh), so both render together instead
# of the project statusLine fully overriding the global one.
input=$(cat)

graft_out=$(printf '%s' "$input" | node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-statusline.cjs" 2>/dev/null)
gauge_out=$(printf '%s' "$input" | bash "$HOME/.claude/statusline-command.sh" 2>/dev/null)

out=""
[ -n "$graft_out" ] && out="${graft_out}"
if [ -n "$gauge_out" ]; then
  [ -n "$out" ] && out="${out}"$'\n'
  out="${out}${gauge_out}"
fi

printf '%s\n' "$out"
