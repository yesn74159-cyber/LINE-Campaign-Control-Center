#!/usr/bin/env bash
# Nightly logical backup of the staging database, run by cron on the staging host.
#
# pg_dump executes inside the postgres container over its own unix socket, so no
# password is ever placed on a command line or in this file. The dump is kept only
# after four checks: the PGDMP magic bytes, a size floor, a real
# `pg_restore --list` read of the archive inside the container, and a minimum count
# of table definitions in that table of contents — so an archive of an empty or
# wrong database fails loudly instead of looking healthy. A sha256 sidecar is
# written and re-verified before the file is promoted.
#
# This is an on-host backup: it survives a bad deploy or a dropped table, not a lost
# VM. Copying the newest dumps off the host is a separate step (see docs/PHASE5E).
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
SERVICE="${SERVICE:-postgres}"
LABEL="${LABEL:-nightly}"
KEEP="${KEEP:-14}"
MIN_BYTES="${MIN_BYTES:-8192}"
MIN_TABLES="${MIN_TABLES:-5}"

cd "$DEPLOY_DIR"
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/$LABEL-$stamp.dump"
tmp="$file.partial"
check="/tmp/$LABEL-$stamp-check.dump"
log="$BACKUP_DIR/backup.log"

fail() {
  rm -f "$tmp" "$file"
  # a run that fails after the copy must not leave its scratch archive in the container
  compose exec -T "$SERVICE" sh -c "rm -f '$check'" > /dev/null 2>&1 || true
  printf '%s %s FAIL %s\n' "$(date -u +%FT%TZ)" "$LABEL" "$1" >> "$log"
  printf 'backup failed: %s\n' "$1" >&2
  exit 1
}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

compose exec -T "$SERVICE" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' > "$tmp" \
  || fail "pg_dump exited non-zero"

[ "$(head -c 5 "$tmp")" = "PGDMP" ] || fail "archive does not start with PGDMP"
size="$(wc -c < "$tmp" | tr -d ' ')"
[ "$size" -gt "$MIN_BYTES" ] || fail "archive is only $size bytes (floor $MIN_BYTES)"

# The table of contents is read inside the container: the host has no PostgreSQL
# client. The path is interpolated into the container-side command rather than
# passed as an argument, and `$check` is derived from the UTC stamp only.
compose cp "$tmp" "$SERVICE:$check" >/dev/null || fail "could not copy the archive into the container"
toc="$(compose exec -T "$SERVICE" sh -c "pg_restore --list '$check'")" \
  || fail "pg_restore could not read the archive"
compose exec -T "$SERVICE" sh -c "rm -f '$check'" || true
tables="$(printf '%s\n' "$toc" | awk '$4 == "TABLE" && $5 != "DATA" { n++ } END { print n + 0 }')"
[ "$tables" -ge "$MIN_TABLES" ] \
  || fail "archive lists only $tables tables (floor $MIN_TABLES); the database it was read from is not the expected one"

mv "$tmp" "$file"
(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$file")" > "$(basename "$file").sha256"
  sha256sum -c --strict "$(basename "$file").sha256" > /dev/null
) || fail "sha256 verification of the written dump failed"

printf '%s %s OK bytes=%s tables=%s file=%s\n' "$(date -u +%FT%TZ)" "$LABEL" "$size" "$tables" "$(basename "$file")" >> "$log"

# Rotation only ever touches files with this LABEL prefix, so labelled manual dumps
# (pre014-, drill-) are never collected by the nightly job.
ls -1t "$BACKUP_DIR/$LABEL"-*.dump 2> /dev/null | awk -v keep="$KEEP" 'NR > keep' | while read -r old; do
  rm -f "$old" "$old.sha256"
done

printf '%s\n' "$file"
