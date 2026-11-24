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

PLESK_VITE_ENV_FILE="$ROOT_DIR/artifacts/mulapay/.env.production"
if [ -z "${VITE_CLERK_PUBLISHABLE_KEY:-}" ] && [ -f "$PLESK_VITE_ENV_FILE" ]; then
  VITE_CLERK_PUBLISHABLE_KEY=$(awk -F= '
    $1 == "VITE_CLERK_PUBLISHABLE_KEY" {
      sub(/^[^=]*=/, "")
      gsub(/\r/, "")
      print
      exit
    }
  ' "$PLESK_VITE_ENV_FILE")
  export VITE_CLERK_PUBLISHABLE_KEY
fi

case "${VITE_CLERK_PUBLISHABLE_KEY:-}" in
  pk_live_*) ;;
  *)
    echo "No valid production Clerk publishable key reached the build. Set VITE_CLERK_PUBLISHABLE_KEY, set CLERK_PUBLISHABLE_KEY, or add it to artifacts/mulapay/.env.production." >&2
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
