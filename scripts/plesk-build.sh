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

read_publishable_key() {
  awk -F= '
    {
      name = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != "VITE_CLERK_PUBLISHABLE_KEY") next
      sub(/^[^=]*=/, "")
      gsub(/\r/, "")
      sub(/^[[:space:]]+/, "")
      sub(/[[:space:]]+$/, "")
      if ((substr($0, 1, 1) == "\"" && substr($0, length($0), 1) == "\"") ||
          (substr($0, 1, 1) == "\047" && substr($0, length($0), 1) == "\047")) {
        $0 = substr($0, 2, length($0) - 2)
      }
      print
      exit
    }
  ' "$1"
}

if [ -z "${VITE_CLERK_PUBLISHABLE_KEY:-}" ]; then
  for PLESK_VITE_ENV_FILE in "$ROOT_DIR/.env.production" "$ROOT_DIR/artifacts/mulapay/.env.production"; do
    if [ -f "$PLESK_VITE_ENV_FILE" ]; then
      VITE_CLERK_PUBLISHABLE_KEY=$(read_publishable_key "$PLESK_VITE_ENV_FILE")
      if [ -n "$VITE_CLERK_PUBLISHABLE_KEY" ]; then
        export VITE_CLERK_PUBLISHABLE_KEY
        break
      fi
    fi
  done
fi

if [ -z "${VITE_CLERK_PUBLISHABLE_KEY:-}" ]; then
  echo "No Clerk publishable key reached the build. Set VITE_CLERK_PUBLISHABLE_KEY or add it to /httpdocs/.env.production." >&2
  exit 1
fi

case "$VITE_CLERK_PUBLISHABLE_KEY" in
  pk_live_*) ;;
  *)
    echo "The Clerk publishable key must be a production key beginning with pk_live_." >&2
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
