#!/usr/bin/env bash
#
# Run the DrumCoach end-to-end tests (Playwright, over the loopback audio path).
#
# Playwright's config loader needs Node >= 18.19. This selects the project's
# pinned Node (.nvmrc → 20) via nvm when available, makes sure the chromium
# browser is installed, then runs the suite. Pass extra args straight through,
# e.g. ./test-e2e.sh --headed   or   ./test-e2e.sh -g "two drums".
set -euo pipefail
cd "$(dirname "$0")"

# Select the project's Node via nvm if it's available.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use >/dev/null 2>&1 || nvm install
fi
echo "▶ Using Node $(node -v)"

# Hard requirement check (Playwright ESM loader).
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a*100+b>=1819?0:1)'; then
  echo "✖ Node $(node -v) is too old for Playwright (need >= 18.19)." >&2
  echo "  Install/select the project's Node: nvm install   (uses .nvmrc)" >&2
  exit 1
fi

# Dependencies + browser.
[ -d node_modules/@playwright/test ] || npm install
npx playwright install chromium >/dev/null 2>&1 || true

npx playwright test "$@"
