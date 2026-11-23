#!/bin/bash
# launchd entry point (installed by launchd/install.sh). The env file is outside
# the repo and holds the tokens: GITHUB_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN,
# SLACK_USER_ID.
set -euo pipefail

set -a
. "$HOME/.config/zy-assistant/env"
set +a

: "${DB_PATH:=$HOME/Library/Application Support/zy-assistant/state.db}"
export DB_PATH

# launchd's PATH is minimal: do not rely on node being on it.
node_bin=$(command -v node || echo /opt/homebrew/bin/node)

cd "$(dirname "$0")/.."
exec "$node_bin" src/main.ts run
