#!/usr/bin/env bash
# Register the nightly database backup in the deploy user's crontab.
# Run as the user that owns the stack (ubuntu on staging), NOT as root:
# the job needs the docker group membership that user already has.
#   bash deploy/install-backup-cron.sh --run-now
# Idempotent: re-running replaces the managed line instead of stacking duplicates.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
SCRIPT="$DEPLOY_DIR/deploy/nightly-backup.sh"
SCHEDULE="${SCHEDULE:-30 20 * * *}"
TAG="# line-ccc-nightly-backup"

if [ "$(id -u)" -eq 0 ]; then
  echo "run as the deploy user, not root: bash deploy/install-backup-cron.sh" >&2
  exit 1
fi
if [ ! -f "$SCRIPT" ]; then
  echo "$SCRIPT is missing. Pull the repository into $DEPLOY_DIR first." >&2
  exit 1
fi
if ! command -v crontab > /dev/null; then
  echo "crontab is not installed. Run: sudo apt-get install -y cron" >&2
  exit 1
fi
if ! docker info > /dev/null 2>&1; then
  echo "this user cannot reach the docker daemon; the backup would fail every night" >&2
  exit 1
fi

chmod +x "$SCRIPT"

# cron runs the line through /bin/sh, so the trailing `# tag` is a shell comment
# and doubles as the marker that makes this entry replaceable instead of stacked.
line="$SCHEDULE $SCRIPT >> $BACKUP_DIR/cron.log 2>&1 $TAG"
previous="$(crontab -l 2> /dev/null | grep -F -- "$TAG" | head -1 || true)"
replaced="$( { crontab -l 2> /dev/null || true; } | grep -vF -- "$TAG" || true)"
printf '%s\n%s\n' "$replaced" "$line" | grep -v '^$' | crontab -
case "$previous" in
  "") echo "cron entry added:";;
  "$line") echo "cron entry already present and unchanged:";;
  *) echo "cron entry replaced:";;
esac
printf '  %s\n' "$line"

if systemctl is-active --quiet cron 2> /dev/null || systemctl is-active --quiet crond 2> /dev/null; then
  echo "cron daemon: active"
else
  echo "WARNING: the cron daemon is not running, so the schedule will never fire." >&2
  echo "         Start it with: sudo systemctl enable --now cron" >&2
fi

echo
echo "proof run (this writes one real dump):"
if [ "${1:-}" = "--run-now" ]; then
  "$SCRIPT"
else
  echo "  skipped. run it yourself:  $SCRIPT"
fi
echo
echo "check afterwards:  ls -lt $BACKUP_DIR | head && tail -5 $BACKUP_DIR/backup.log"
