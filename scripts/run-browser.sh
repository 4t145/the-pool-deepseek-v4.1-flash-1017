#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=./chrome-env.sh
source scripts/chrome-env.sh
exec "$@"
