#!/usr/bin/env bash
# One ops health pass, run by cron every five minutes on the staging host.
#
# The CLI reads delivery health from the database, decides whether this alert set is
# news (see OPS_ALERT_REPEAT_MINUTES), and posts to OPS_ALERT_WEBHOOK_URL. The state
# file lives on the host so a recreated container cannot repeat yesterday's page; the
# webhook URL and bot token stay in .env.staging and reach the CLI through env_file.
#
# Exit codes are logged, not propagated: cron would otherwise mail on every pass that
# has alerts, and the webhook is the channel that is supposed to carry them.
set -uo pipefail

# cron starts with PATH=/usr/bin:/bin only.
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
STATE_DIR="${STATE_DIR:-$DEPLOY_DIR/ops-state}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
LOG="$STATE_DIR/ops-alert.log"

cd "$DEPLOY_DIR"
mkdir -p "$STATE_DIR"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

compose run --rm --no-deps \
  -v "$STATE_DIR:/alert-state" \
  -e OPS_ALERT_STATE_FILE=/alert-state/alert-state.json \
  api node dist/api/cli.js ops --notify >> "$LOG" 2>&1
status=$?
printf '%s exit=%s\n' "$(date -u +%FT%TZ)" "$status" >> "$LOG"
exit 0
