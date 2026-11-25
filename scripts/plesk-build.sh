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
# Plesk runs deployment commands without a TTY; pnpm needs CI to replace stale modules noninteractively.
export CI=true

run_pnpm install --frozen-lockfile
run_pnpm --filter @workspace/mulapay run build
run_pnpm --filter @workspace/api-server run build

API_BUNDLE="$ROOT_DIR/artifacts/api-server/dist/index.mjs"
if [ ! -s "$API_BUNDLE" ]; then
  echo "The API build did not produce artifacts/api-server/dist/index.mjs." >&2
  exit 1
fi

if ! grep -Fq "Key values are not logged." "$API_BUNDLE"; then
  echo "The API bundle is missing the current Clerk runtime diagnostic. The deployed source or build output is stale." >&2
  exit 1
fi

if grep -Fq "Configure the matching Clerk" "$API_BUNDLE"; then
  echo "The API bundle still contains the old Clerk startup error." >&2
  exit 1
fi

echo "Verified the current Clerk diagnostic in the API bundle."
echo "Plesk build complete. Restart the Node.js application to serve the new release."
