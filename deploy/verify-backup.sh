#!/usr/bin/env bash
# Daily proof that last night's backup is still usable and actually left the host.
#
# The nightly job already checks the archive it writes, and it logs FAIL, but a log line
# nobody reads is not an alert. This pass runs after it and asks three questions:
#   1. is the newest nightly dump younger than MAX_AGE_HOURS (default 26)?
#   2. does its sha256 sidecar still match the file on disk?
#   3. did the off-host pull confirm *this* dump (deploy/offsite-backup.ps1 writes the marker)?
# A failure is pushed to OPS_ALERT_WEBHOOK_URL through the same CLI path the ops pass uses.
set -uo pipefail

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
export PATH

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
MARKER="$BACKUP_DIR/.offsite-verified"
LOG="$BACKUP_DIR/verify.log"

cd "$DEPLOY_DIR"
mkdir -p "$BACKUP_DIR"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

alert() {
  compose run --rm --no-deps api node dist/api/cli.js alert --text "backup check FAIL: $1" > /dev/null 2>&1 || true
}

fail() {
  printf '%s verify FAIL %s\n' "$(date -u +%FT%TZ)" "$1" >> "$LOG"
  alert "$1"
  printf 'backup check failed: %s\n' "$1" >&2
  exit 1
}

newest="$(ls -1t "$BACKUP_DIR"/nightly-*.dump 2> /dev/null | head -1)"
[ -n "$newest" ] || fail "no nightly-*.dump in $BACKUP_DIR"
name="$(basename "$newest")"

sidecar="$newest.sha256"
[ -f "$sidecar" ] || fail "checksum sidecar for $name is missing"
( cd "$BACKUP_DIR" && sha256sum -c --strict "$name.sha256" > /dev/null 2>&1 ) \
  || fail "checksum of $name does not match its sidecar"

mtime="$(stat -c %Y "$newest" 2> /dev/null || echo 0)"
[ "$mtime" -gt 0 ] || fail "cannot read the timestamp of $name"
now="$(date -u +%s)"
age_hours=$(( (now - mtime) / 3600 ))
[ "$age_hours" -le "$MAX_AGE_HOURS" ] \
  || fail "newest dump $name is ${age_hours}h old (limit ${MAX_AGE_HOURS}h); did the nightly cron stop?"

# The offsite script writes "<UTC timestamp> <dump name>" only after the copy verified on the
# other machine. Matching the name is the point: an old marker proves an older dump left.
[ -f "$MARKER" ] || fail "no offsite marker ($MARKER); run deploy/offsite-backup.ps1 or schedule it"
read -r offline_at offline_name < "$MARKER" || true
[ -n "${offline_name:-}" ] || fail "offsite marker is unreadable; expected '<timestamp> <dump name>'"
[ "$offline_name" = "$name" ] \
  || fail "offsite copy is $offline_name but the newest dump is $name; the off-host pull is behind"

size="$(wc -c < "$newest" | tr -d ' ')"
printf '%s verify OK file=%s age_hours=%s bytes=%s offsite_at=%s\n' "$(date -u +%FT%TZ)" "$name" "$age_hours" "$size" "$offline_at" >> "$LOG"
printf 'backup verified: %s (%sh old, %s bytes, off-host since %s)\n' "$name" "$age_hours" "$size" "$offline_at"
