#!/usr/bin/env bash
# Build this checkout as a tagged release and restart the stack on that tag.
#
#   bash deploy/release.sh                     # tag = git short sha of HEAD
#   RELEASE_TAG=v2 bash deploy/release.sh      # explicit tag
#   RELEASE_TAG=<old> bash deploy/release.sh --no-build   # rollback (docs/ROLLBACK.md)
#
# Without a tag every build is `local`, which keeps a rollback impossible: the previous
# image is overwritten in place. The tag is the whole point of this script.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
cd "$DEPLOY_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "$DEPLOY_DIR/$ENV_FILE is missing; run deploy/host-bootstrap.sh first" >&2
  exit 1
fi

tag="${RELEASE_TAG:-}"
if [ -z "$tag" ]; then
  tag="$(git rev-parse --short=12 HEAD 2> /dev/null || true)"
  [ -n "$tag" ] || tag="$(date -u +%Y%m%dT%H%M%SZ)"
fi
case "$tag" in
  *[!A-Za-z0-9._-]*)
    echo "RELEASE_TAG may only contain letters, digits, dot, underscore and dash" >&2
    exit 1
    ;;
esac

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

if [ "${1:-}" != "--no-build" ]; then
  compose build api admin
fi
for image in "line-ccc-api:$tag" "line-ccc-admin:$tag"; do
  if ! docker image inspect "$image" > /dev/null 2>&1; then
    echo "$image is not on this host. Build it first (no --no-build), or pick a tag from: docker images line-ccc-api" >&2
    exit 1
  fi
done

# RELEASE_TAG is read by compose from this file, so it has to be written before `up`.
# The rewrite goes through a temp file and keeps the original inode and 0600 mode, so a
# failure cannot leave a half-written secrets file behind.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"
grep -v '^RELEASE_TAG=' "$ENV_FILE" > "$tmp" || true
printf 'RELEASE_TAG=%s\n' "$tag" >> "$tmp"
cat "$tmp" > "$ENV_FILE"

compose up -d --no-build
compose ps

echo
echo "release $tag is up."
echo "rollback: RELEASE_TAG=<previous> bash deploy/release.sh --no-build"
echo "tags on this host: docker images line-ccc-api --format '{{.Tag}} {{.CreatedAt}}'"
