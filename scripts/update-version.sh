#!/usr/bin/env bash
# Usage: ./scripts/update-version.sh <version>
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm version "$1" --no-git-tag-version --allow-same-version
