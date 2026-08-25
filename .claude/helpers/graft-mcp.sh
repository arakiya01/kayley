#!/bin/bash
# Launches graft's MCP server without hardcoding a machine-specific absolute
# path to Node/graft (the previous .mcp.json pointed straight at this one
# sandbox's mise install directory under a specific username, which breaks
# on any other machine).
#
# Scans $HOME's mise-managed Node installs for one that has graft's CLI
# available: on this project, the default/newer Node fails to build
# tree-sitter's native module, so graft was installed under an older Node
# instead (this doesn't call `mise which` — mise here doesn't track that
# install as one of its own, so it can't resolve it by version). Falls back
# to whatever `node` is first on PATH if no such install is found.
set -e

NODE_BIN=""
for candidate in "$HOME"/.local/share/mise/installs/node/*/bin/node; do
  [ -x "$candidate" ] || continue
  if [ -x "$(dirname "$candidate")/graft" ]; then
    NODE_BIN="$candidate"
    break
  fi
done
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node)"

BIN_DIR="$(dirname "$NODE_BIN")"

if [ -x "$BIN_DIR/graft" ]; then
  exec "$NODE_BIN" "$BIN_DIR/graft" mcp
fi

# Fallback: ask that same Node's npm where its global packages live.
GLOBAL_ROOT="$("$BIN_DIR/npm" root -g 2>/dev/null)"
exec "$NODE_BIN" "$GLOBAL_ROOT/@nanonets/graft/dist/cli.js" mcp
