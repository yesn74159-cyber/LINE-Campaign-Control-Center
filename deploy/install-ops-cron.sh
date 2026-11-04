#!/usr/bin/env bash
# Register the five-minute ops alert pass in the deploy user's crontab.
# Run as the user that owns the stack (ubuntu on staging), NOT as root:
# the job needs the docker group membership that user already has.
#   bash deploy/install-ops-cron.sh --run-now
# Idempotent: re-running replaces the managed line instead of stacking duplicates.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
STATE_DIR="${STATE_DIR:-$DEPLOY_DIR/ops-state}"
SCRIPT="$DEPLOY_DIR/deploy/ops-alert.sh"
SCHEDULE="${SCHEDULE:-*/5 * * * *}"
TAG="# line-ccc-ops-alert"

if [ "$(id -u)" -eq 0 ]; then
  echo "run as the deploy user, not root: bash deploy/install-ops-cron.sh" >&2
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
  echo "this user cannot reach the docker daemon; the alert pass would fail every time" >&2
  exit 1
fi

chmod +x "$SCRIPT"
mkdir -p "$STATE_DIR"

# cron runs the line through /bin/sh, so the trailing `# tag` is a shell comment
# and doubles as the marker that makes this entry replaceable instead of stacked.
line="$SCHEDULE $SCRIPT $TAG"
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

# Presence check only - the value is read from the env file by the container, never here.
env_file="$DEPLOY_DIR/${ENV_FILE:-.env.staging}"
if ! grep -q '^OPS_ALERT_WEBHOOK_URL=.\+' "$env_file" 2> /dev/null; then
  echo "WARNING: OPS_ALERT_WEBHOOK_URL is blank in $env_file; the pass will log" >&2
  echo "         'notified:false' instead of sending anything." >&2
fi
if grep -q '^OPS_ALERT_WEBHOOK_URL=.*api\.telegram\.org' "$env_file" 2> /dev/null && ! grep -q '^OPS_TELEGRAM_CHAT_ID=.\+' "$env_file" 2> /dev/null; then
  echo "WARNING: the webhook points at Telegram but OPS_TELEGRAM_CHAT_ID is blank." >&2
fi

echo
echo "proof run (this sends one real alert if delivery health is not clean):"
if [ "${1:-}" = "--run-now" ]; then
  "$SCRIPT"
  tail -5 "$STATE_DIR/ops-alert.log"
else
  echo "  skipped. run it yourself:  $SCRIPT"
fi
echo
echo "check afterwards:  tail -5 $STATE_DIR/ops-alert.log"
