#!/usr/bin/env bash
# Switch the staging runtime from the owner URL to the Tier C app role, and park the
# owner URL where only the migrate wrapper can reach it.
#
# Run this only after deploy/tier-c-apply.sh has been applied in the same window.
# It is a separate step on purpose: the SQL alone does not change what api/worker
# connect with, and doing both without looking at the verifier output in between is how
# an empty admin panel gets shipped.
#
#   cd /srv/line-ccc-staging && CONFIRM=TIER-C-SWITCH bash deploy/tier-c-switch-runtime.sh
#
# The password is typed at a prompt. It is never put on a command line, never echoed,
# and lands only in .env.staging / .env.migrate (both chmod 600), which is where the
# current owner credential already lives today.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
MIGRATE_ENV="${MIGRATE_ENV:-.env.migrate}"
# Same reason as in tier-c-apply.sh: the fixed container_name is the route that has been
# reliable on this host, and neither call needs compose's environment interpolation.
PG_CONTAINER="${PG_CONTAINER:-line-ccc-postgres-staging}"
API_CONTAINER="${API_CONTAINER:-line-ccc-api-staging}"

[ "${CONFIRM:-}" = "TIER-C-SWITCH" ] || { echo "refusing: this changes what api/worker connect with. Re-run with CONFIRM=TIER-C-SWITCH" >&2; exit 1; }
cd "$DEPLOY_DIR" 2> /dev/null || { echo "refusing: $DEPLOY_DIR does not exist (override with DEPLOY_DIR=...)" >&2; exit 1; }

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

line="$(grep -m1 '^DATABASE_URL=' "$ENV_FILE" || true)"
[ -n "$line" ] || { echo "refusing: no DATABASE_URL= line in $ENV_FILE" >&2; exit 1; }
url="${line#DATABASE_URL=}"
url="${url%\"}"; url="${url#\"}"
case "$url" in postgresql://*|postgres://*) ;; *) echo "refusing: DATABASE_URL does not look like a postgres:// URL" >&2; exit 1;; esac

# Split on the LAST '@' so a password containing '@' does not confuse the rewrite.
hostpart="${url##*@}"
scheme="${url%%://*}://"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# The container's own unix socket is trust-authenticated, so this proves the role and its
# grants exist without needing the password - the password is proved by the health check.
if ! docker exec -i "$PG_CONTAINER" sh -c \
      'psql -h /var/run/postgresql -U line_ccc_app -d "$POSTGRES_DB" -X -Atc "select count(*) from campaigns"' | grep -qE '^[0-9]+$'; then
  echo "refusing: cannot connect as line_ccc_app or read campaigns over the container socket." >&2
  echo "        Run deploy/tier-c-apply.sh first (it creates the role, grants and policies)." >&2
  exit 1
fi
echo "gate: line_ccc_app exists and reads campaigns through its own policies"

# The user part of the URL, so a re-run can be recognised before it parks the wrong credential.
url_user="${url#*://}"; url_user="${url_user%%/*}"; url_user="${url_user%%:*}"

# Keep the owner URL for the migrate wrapper before anything is rewritten.
if [ ! -f "$MIGRATE_ENV" ] && [ "$url_user" = "line_ccc_app" ]; then
  echo "refusing: DATABASE_URL already connects as line_ccc_app and $MIGRATE_ENV is missing -" >&2
  echo "        this run would park the APP url as if it were the owner url." >&2
  echo "        Restore the owner url from .env.staging.bak-tierc-* (created by the switch run) first." >&2
  exit 1
fi
if [ ! -f "$MIGRATE_ENV" ]; then
  umask 077
  printf 'MIGRATION_DATABASE_URL=%s\n' "$url" > "$MIGRATE_ENV"
  echo "owner URL preserved in $MIGRATE_ENV (chmod 600) for deploy/staging-migrate.sh"
else
  echo "$MIGRATE_ENV already exists - not overwriting it."
fi

printf 'Password for role line_ccc_app (typed here, never shown): '
read -rs app_pw; echo
[ -n "$app_pw" ] || { echo "refusing: empty password" >&2; exit 1; }

new_url="${scheme}line_ccc_app:${app_pw}@${hostpart}"
app_pw=""

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
cp -p "$ENV_FILE" "$ENV_FILE.bak-tierc-$stamp"
tmp="$(mktemp)"
# bash's own printf, so the password never appears in any process command line.
{ grep -v '^DATABASE_URL=' "$ENV_FILE"; printf 'DATABASE_URL=%s\n' "$new_url"; } > "$tmp"
grep -q '^DATABASE_URL=' "$tmp" || { echo "FAILED: rewrote $ENV_FILE without a DATABASE_URL line" >&2; cp -p "$ENV_FILE.bak-tierc-$stamp" "$ENV_FILE"; exit 1; }
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
echo "$ENV_FILE updated (backup: $ENV_FILE.bak-tierc-$stamp)"

echo "recreating api and worker with the app-role connection ..."
compose up -d api worker >/dev/null

echo "waiting for api to come up, then probing /health inside the container ..."
sleep 12
# `if ! sleep 12 && compose exec ...` would parse as (! sleep) && exec and always look
# healthy, because a successful sleep short-circuits the AND-list before the probe runs.
if ! docker exec -i "$API_CONTAINER" node -e \
  "fetch('http://127.0.0.1:8787/health').then(r => r.ok ? console.log(r.status) : process.exit(1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
  echo "FAILED: api is not healthy after the switch. Rolling the env file back ..."
  cp -p "$ENV_FILE.bak-tierc-$stamp" "$ENV_FILE"
  compose up -d api worker >/dev/null
  echo "rolled back to the owner URL. To test the app role password over TCP, run:"
  echo "  docker exec -it $PG_CONTAINER psql -h 127.0.0.1 -U line_ccc_app -d line_campaign_ccc -W -Atc 'select 1'"
  compose logs --tail 20 api >&2 || true
  exit 1
fi
echo "api answers /health as the app role"

echo "worker:"
compose ps worker | tail -2
echo
echo "Now run the staging smoke from the workstation, then read the api logs:"
echo "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs --since 10m api | grep -iE 'error|permission|denied' || echo 'no permission errors'"
echo
echo "NOTE (residual, unchanged by this step): api/worker still receive the whole $ENV_FILE via"
echo "  env_file, so POSTGRES_PASSWORD (the owner credential) is still present in their container"
echo "  environment. Removing that needs an explicit allowlist in docker-compose.staging.yml and is"
echo "  a separate approved change, not part of Tier C."
echo
echo "Future deploys: run migrations with deploy/staging-migrate.sh, never with the runtime env."
