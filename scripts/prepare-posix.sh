#!/usr/bin/env sh
set -eu

# Development preparation only; does not alter an existing HAPI profile.
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js is required.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf '%s\n' 'npm is required.' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { printf '%s\n' 'Git is required.' >&2; exit 1; }
node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 24 ]; then printf '%s\n' 'Node.js 24 or later is required.' >&2; exit 1; fi
cd "$repo_dir"
npm ci --omit=dev --no-audit --no-fund
printf '%s\n' 'Dependencies installed. Continue with docs/posix-setup.md and OPENCODE-EXPERIMENT.md.'
