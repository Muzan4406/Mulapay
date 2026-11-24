#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    echo "pnpm 10 is required. Install pnpm in this Plesk Node.js environment first." >&2
    exit 1
  fi
}

case "${VITE_CLERK_PUBLISHABLE_KEY:-}" in
  pk_live_*) ;;
  *)
    echo "Set the production VITE_CLERK_PUBLISHABLE_KEY in the Plesk build environment before building." >&2
    exit 1
    ;;
esac

export BASE_PATH=/
# Vite's config validates PORT at build time; this is not the runtime listener port.
export PORT="${PORT:-3000}"

run_pnpm install --frozen-lockfile
run_pnpm --filter @workspace/mulapay run build
run_pnpm --filter @workspace/api-server run build

echo "Plesk build complete. Restart the Node.js application to serve the new release."
