#!/usr/bin/env bash
# Register the daily retention pass in the deploy user's crontab.
# Run as the user that owns the stack (ubuntu on staging), NOT as root.
#   bash deploy/install-prune-cron.sh --run-now
# Idempotent: re-running replaces the managed line instead of stacking duplicates.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
STATE_DIR="${STATE_DIR:-$DEPLOY_DIR/ops-state}"
SCRIPT="$DEPLOY_DIR/deploy/prune-history.sh"
PRUNE_DAYS="${PRUNE_DAYS:-90}"
TAG="# line-ccc-prune"

if [ "$(id -u)" -eq 0 ]; then
  echo "run as the deploy user, not root: bash deploy/install-prune-cron.sh" >&2
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
  echo "this user cannot reach the docker daemon; the prune pass would fail every day" >&2
  exit 1
fi

# Target 05:20 ICT, after the nightly backup has run, so a same-night restore still has the
# rows this pass removes. cron fires in the host's own zone, so the literal depends on it.
host_zone="$(timedatectl show -p Timezone --value 2> /dev/null || true)"
if [ -z "${SCHEDULE:-}" ]; then
  case "$host_zone" in
    UTC|Etc/UTC) SCHEDULE="20 22 * * *";;
    Asia/Bangkok) SCHEDULE="20 5 * * *";;
    "")
      SCHEDULE="20 22 * * *"
      echo "WARNING: could not read the host timezone (timedatectl). Assuming UTC; verify the pass lands at 05:20 ICT." >&2
      ;;
    *)
      SCHEDULE="20 22 * * *"
      echo "WARNING: host timezone is $host_zone, which is neither UTC nor Asia/Bangkok." >&2
      echo "         Set it yourself, e.g. SCHEDULE='<min> <hour> * * *' bash deploy/install-prune-cron.sh" >&2
      ;;
  esac
  echo "host timezone: ${host_zone:-unknown} -> prune schedule: $SCHEDULE (target 05:20 ICT)"
else
  echo "host timezone: ${host_zone:-unknown}; SCHEDULE override: $SCHEDULE"
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
echo "retention window: $PRUNE_DAYS days (override with PRUNE_DAYS=... bash deploy/install-prune-cron.sh)"

if systemctl is-active --quiet cron 2> /dev/null || systemctl is-active --quiet crond 2> /dev/null; then
  echo "cron daemon: active"
else
  echo "WARNING: the cron daemon is not running, so the schedule will never fire." >&2
  echo "         Start it with: sudo systemctl enable --now cron" >&2
fi

echo
echo "dry run first (counts only, deletes nothing):"
echo "  docker compose -f docker-compose.staging.yml --env-file .env.staging run --rm --no-deps api node dist/api/cli.js prune --days $PRUNE_DAYS --dry-run"
echo
if [ "${1:-}" = "--run-now" ]; then
  "$SCRIPT"
  tail -5 "$STATE_DIR/prune.log"
else
  echo "run the pass yourself:  $SCRIPT"
fi
echo
echo "check afterwards:  tail -5 $STATE_DIR/prune.log"
