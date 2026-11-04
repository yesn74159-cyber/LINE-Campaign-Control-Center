#!/usr/bin/env bash
# Run the CLI migration/ops commands with the OWNER URL, not the runtime URL.
#
# Why this exists: apps/api/src/cli.ts builds one pool from DATABASE_URL. After Tier C
# that variable in .env.staging points at line_ccc_app, which has DML grants only - it
# cannot run a migration. The owner URL is parked in .env.migrate (chmod 600) by
# deploy/tier-c-switch-runtime.sh, and this script is the only thing that reads it.
#
#   cd /srv/line-ccc-staging && bash deploy/staging-migrate.sh migrate
#
# Refuses an empty argument because cli.ts defaults to `setup`, which seeds. It also
# refuses `setup` outright - on staging there is no such thing as a safe blind seed.
# The URL is exported with a shell builtin, so it never appears in any process argv.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
MIGRATE_ENV="${MIGRATE_ENV:-.env.migrate}"

cmd="${1:-}"
case "$cmd" in
  migrate|seed|ops|rotate-vault) ;;
  '') echo "refusing: no command given (cli.ts would default to 'setup', which seeds)." >&2; exit 1;;
  setup) echo "refusing: 'setup' migrates AND seeds. Run 'migrate' and, if you truly mean it, 'seed'." >&2; exit 1;;
  *) echo "refusing: '$cmd' is not one of migrate | seed | ops | rotate-vault" >&2; exit 1;;
esac
shift || true

cd "$DEPLOY_DIR" 2> /dev/null || { echo "refusing: $DEPLOY_DIR does not exist (override with DEPLOY_DIR=...)" >&2; exit 1; }

source_url=""
if [ -f "$MIGRATE_ENV" ]; then
  source_url="$MIGRATE_ENV"
else
  # Pre-Tier C (or a host that never ran the switch): the owner URL is still DATABASE_URL.
  source_url="$ENV_FILE"
  echo "NOTE: $MIGRATE_ENV not found - using DATABASE_URL from $ENV_FILE (owner URL, before Tier C)."
fi

line="$(grep -m1 -E '^(MIGRATION_)?DATABASE_URL=' "$source_url" || true)"
[ -n "$line" ] || { echo "refusing: no DATABASE_URL line in $source_url" >&2; exit 1; }
url="${line#*=}"
url="${url%\"}"; url="${url#\"}"
case "$url" in postgresql://*|postgres://*) ;; *) echo "refusing: the URL does not look like postgres://…" >&2; exit 1;; esac

export DATABASE_URL="$url"

echo "running 'node dist/api/cli.js $cmd' against $(printf '%s' "$url" | sed -E 's#(://[^:]+):[^@]*@#\1:***@#')"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps \
  -e DATABASE_URL api node dist/api/cli.js "$cmd" "$@"
DATABASE_URL=""

echo
echo "If that applied a migration that ADDS A TABLE, Tier C is now incomplete:"
echo "line_ccc_app gets its DML grant from ALTER DEFAULT PRIVILEGES, but nothing creates"
echo "its <table>_app_access policy - and a table with RLS and no policy reads as empty."
echo "Re-run the proposal (it is idempotent, and it runs the drift verifier for you):"
echo "  CONFIRM=TIER-C bash deploy/tier-c-apply.sh"
