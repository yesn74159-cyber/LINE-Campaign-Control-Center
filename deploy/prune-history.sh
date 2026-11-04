#!/usr/bin/env bash
# One retention pass, run by cron daily on the staging host.
#
# Deletes only closed history: webhook_events and audit_log older than PRUNE_DAYS, and
# outbox_deliveries older than that *and* already in a terminal state. Rows whose send is
# still in flight or unresolved are never deleted, however old, because deleting them would
# erase the only record of a message that may have reached the customer.
#
# Exit codes are logged, not propagated, for the same reason the ops pass does it: the log
# is the channel, and a non-zero exit would turn every failure into cron mail.
set -uo pipefail

# cron starts with PATH=/usr/bin:/bin only.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
STATE_DIR="${STATE_DIR:-$DEPLOY_DIR/ops-state}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
PRUNE_DAYS="${PRUNE_DAYS:-90}"
LOG="$STATE_DIR/prune.log"

cd "$DEPLOY_DIR"
mkdir -p "$STATE_DIR"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

compose run --rm --no-deps \
  api node dist/api/cli.js prune --days "$PRUNE_DAYS" >> "$LOG" 2>&1
status=$?
printf '%s days=%s exit=%s\n' "$(date -u +%FT%TZ)" "$PRUNE_DAYS" "$status" >> "$LOG"
exit 0
