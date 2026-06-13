#!/usr/bin/env bash
#
# DrumCoach setup — installs the latest Node.js via Homebrew.
#
set -euo pipefail

echo "🥁 DrumCoach setup"

# 1. Ensure Homebrew is present.
if ! command -v brew >/dev/null 2>&1; then
  echo "❌ Homebrew is not installed."
  echo "   Install it from https://brew.sh and re-run ./setup.sh"
  exit 1
fi
echo "✅ Homebrew found: $(brew --version | head -1)"

# 2. Install (or upgrade) Node. Homebrew's 'node' formula tracks the latest
#    current release. Use 'node@22' below instead if you prefer the LTS line.
if brew list node >/dev/null 2>&1; then
  echo "↻ Upgrading Node via Homebrew..."
  brew upgrade node || true
else
  echo "⬇️  Installing the latest Node via Homebrew..."
  brew install node
fi

# 3. Report what we got. If you also use nvm, note that nvm's shims can shadow
#    the Homebrew node on your PATH — run 'nvm deactivate' or 'nvm use system'
#    in this shell if 'node -v' below doesn't show the version you just installed.
BREW_NODE="$(brew --prefix)/bin/node"
echo ""
echo "✅ Homebrew Node: $("$BREW_NODE" -v)"
echo "   PATH node:     $(command -v node) ($(node -v 2>/dev/null || echo 'n/a'))"
echo ""
echo "Next:"
echo "  npm install"
echo "  npm start"
