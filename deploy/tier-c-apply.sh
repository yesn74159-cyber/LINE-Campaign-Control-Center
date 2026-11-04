#!/usr/bin/env bash
# Gated apply of the approved Tier C proposal (db/proposals/015_tier_c_app_role.sql).
#
# Approved 2026-11-04 by the owner; the change window is recorded in
# docs/PHASE5F_OPERATIONS_ROTATION_RLS.md. This script applies the SQL and nothing else:
# it does not touch .env.staging, so the runtime keeps using the owner URL until
# deploy/tier-c-switch-runtime.sh is run as its own approved step.
#
# Refuses to do anything unless CONFIRM=TIER-C is set, and refuses when there is no
# fresh nightly dump on disk - a privilege change with no restore point is the one
# mistake this file exists not to make.
#
#   cd /srv/line-ccc-staging && CONFIRM=TIER-C bash deploy/tier-c-apply.sh
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
# Postgres work goes through `docker exec` on the fixed container_name rather than
# `docker compose exec`: the repo is not mounted into the containers, and `compose exec
# postgres` has reported "service postgres is not running" on this host before.
PG_CONTAINER="${PG_CONTAINER:-line-ccc-postgres-staging}"
PROPOSAL="db/proposals/015_tier_c_app_role.sql"
VERIFY="db/proposals/verify-tier-c.sql"
MAX_DUMP_AGE_HOURS="${MAX_DUMP_AGE_HOURS:-26}"

[ "${CONFIRM:-}" = "TIER-C" ] || { echo "refusing: this applies the Tier C SQL. Re-run with CONFIRM=TIER-C" >&2; exit 1; }
cd "$DEPLOY_DIR" 2> /dev/null || { echo "refusing: $DEPLOY_DIR does not exist (override with DEPLOY_DIR=...)" >&2; exit 1; }
[ -f "$PROPOSAL" ] || { echo "missing $PROPOSAL - pull the branch first" >&2; exit 1; }
[ -f "$VERIFY" ] || { echo "missing $VERIFY - pull the branch first" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
pgsh() { docker exec -i "$PG_CONTAINER" sh -c "$1"; }

# Gate 1: a dump taken today must exist, off the label the nightly job writes.
dump="$(ls -1t backups/nightly-*.dump 2> /dev/null | head -1 || true)"
if [ -z "$dump" ]; then
  echo "refusing: no backups/nightly-*.dump on this host. Run deploy/nightly-backup.sh first." >&2
  exit 1
fi
age_hours=$(( ( $(date +%s) - $(stat -c %Y "$dump") ) / 3600 ))
if [ "$age_hours" -gt "$MAX_DUMP_AGE_HOURS" ]; then
  echo "refusing: newest dump $(basename "$dump") is ${age_hours}h old (max ${MAX_DUMP_AGE_HOURS}h)." >&2
  echo "        Run deploy/nightly-backup.sh, then copy it off the VM with deploy/offsite-backup.ps1." >&2
  exit 1
fi
echo "gate: restore point $(basename "$dump") (${age_hours}h old)"

# Gate 2: the database must answer before anything is changed.
pgsh 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null \
  || { echo "refusing: the postgres container is not accepting connections" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="backups/tier-c-apply-$stamp.txt"
docker cp "$PROPOSAL" "$PG_CONTAINER:/tmp/015.sql" >/dev/null
docker cp "$VERIFY" "$PG_CONTAINER:/tmp/verify-tier-c.sql" >/dev/null

echo "applying $PROPOSAL as one transaction ..."
pgsh 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 --single-transaction -f /tmp/015.sql' \
  > "$report" 2>&1 \
  || { echo "FAILED - the transaction rolled back, nothing was changed. See $report:" >&2; tail -20 "$report" >&2; exit 1; }

echo "verifying ..."
pgsh 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -f /tmp/verify-tier-c.sql' >> "$report" 2>&1

# The two lines that decide whether Tier C landed.
if ! grep -q 'policies created for line_ccc_app' "$report" && ! grep -q 'tables_with_app_policy' "$report"; then
  echo "FAILED: no policy summary in $report" >&2; exit 1
fi
grep -E '^( .*line_ccc| *[0-9]+ \| *[0-9]+ \| *[0-9]+)' "$report" | head -8 || true
if grep -qE 'NO DIFFERENCE across' "$report"; then
  echo "verifier: $(grep -o 'NO DIFFERENCE across [0-9]* tables' "$report" | head -1)"
else
  echo "WARNING: the verifier did not print NO DIFFERENCE - read $report before switching the runtime." >&2
fi
if grep -qE 'ERROR|FATAL' "$report"; then
  echo "WARNING: $report contains ERROR/FATAL lines. Inspect before continuing." >&2
fi

echo
echo "The runtime still connects as the owner. Two steps remain, each with its own confirmation:"
echo
echo "1) Set the role password - needs a real terminal, so run it from an interactive ssh session"
echo "   (psql reads it with hidden input; -T / no-tty cannot answer the prompt):"
echo "     ssh -i <key> ubuntu@13.212.244.219"
echo "     cd /srv/line-ccc-staging && docker exec -it $PG_CONTAINER \\"
echo "       psql -U line_ccc -d line_campaign_ccc -c '\\password line_ccc_app'"
echo
echo "2) Switch the runtime (its own approval, inside the window):"
echo "     CONFIRM=TIER-C-SWITCH bash deploy/tier-c-switch-runtime.sh"
echo
echo "Report kept at $report"
