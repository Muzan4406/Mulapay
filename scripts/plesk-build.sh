#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

run_pnpm() {
  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    echo "pnpm 10 is required. Install pnpm in this Plesk Node.js environment first." >&2
    exit 1
  fi
}

if [ -z "${VITE_CLERK_PUBLISHABLE_KEY:-}" ] && [ -n "${CLERK_PUBLISHABLE_KEY:-}" ]; then
  export VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PUBLISHABLE_KEY"
fi

case "${VITE_CLERK_PUBLISHABLE_KEY:-}" in
  pk_live_*) ;;
  *)
    echo "The build command did not receive a production publishable key. Set VITE_CLERK_PUBLISHABLE_KEY (or pass CLERK_PUBLISHABLE_KEY) in the build process." >&2
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
