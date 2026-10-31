#!/usr/bin/env bash
# One-time preparation for a dedicated staging VM (Ubuntu 24.04 LTS).
# Run as root via `sudo bash deploy/host-bootstrap.sh` on the NEW host only.
# It refuses to continue when something already serves 80/443, so it cannot
# silently reconfigure the shared preview VM.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/srv/line-ccc-staging}"
SWAP_FILE=/swapfile

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash deploy/host-bootstrap.sh" >&2
  exit 1
fi

if ss -ltnH '( sport = :80 or sport = :443 )' | grep -q .; then
  echo "port 80/443 is already in use; this host is not a dedicated staging VM" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades

# Docker Engine from Docker's apt repository (compose v2 plugin included).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Builds of the api image can exhaust 4 GB; 2 GB swap keeps the host responsive.
if [ ! -f "$SWAP_FILE" ]; then
  fallocate -l 2G "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
fi
swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE" || swapon "$SWAP_FILE"
grep -qx "$SWAP_FILE none swap sw 0 0" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab

# Keep host logs bounded alongside the compose json-file limits.
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/line-ccc-staging.conf <<'EOF'
[Journal]
SystemMaxUse=500M
EOF
systemctl restart systemd-journald

# Docker publishes ports through its own iptables chain, so ufw does not filter
# 80/443. Restrict them in the Lightsail firewall as well; this only guards the
# host itself (SSH and any future local-only listener).
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

OWNER="${SUDO_USER:-root}"
install -d -m 0750 -o "$OWNER" -g "$OWNER" "$DEPLOY_DIR"

cat <<EOF
host ready
  deploy dir : $DEPLOY_DIR
  compose    : $(docker compose version --short)
  next       : clone the repo into $DEPLOY_DIR, create .env.staging from
               deploy/staging.env.example, then run the first-deploy checklist
EOF
