#!/usr/bin/env bash
# =============================================================================
# wg-mesh.sh — bring up the WireGuard mesh interface (wg0) on a bare-metal host
# so the OCI control plane can reach the node-agent, and the microVM guests can
# reach OCI-side Postgres / S3 / AI-proxy over the private tunnel.
# =============================================================================
# Topology (spoke): this host peers with the OCI-side hub. Traffic for the mesh
# subnet + OCI service CIDRs is routed via wg0 (AllowedIPs on the peer). Guest
# TAP subnets are forwarded + masqueraded onto wg0 so guests egress with the
# host's mesh IP (the OCI side only needs to allow the mesh subnet).
#
# Run on the host as root. Prints this host's public key to hand to the hub.
#
# Env (required unless noted):
#   WG_ADDRESS         this host's mesh IP w/ prefix   (e.g. 10.90.0.2/24)
#   WG_PEER_PUBKEY     hub WireGuard public key
#   WG_PEER_ALLOWED    CIDRs reachable via the hub, comma-sep
#                      (e.g. 10.90.0.0/24,10.0.0.0/16 for OKE svc/pods + PG)
#   WG_PEER_ENDPOINT   hub endpoint host:port          (optional; omit if the
#                      hub dials us — then we only listen)
#   WG_LISTEN_PORT     UDP listen port                 (default 51820)
#   TAP_SUPERNET       microVM tap supernet to NAT->wg0 (default 172.16.0.0/16)
#   WG_KEEPALIVE       persistent keepalive seconds     (default 25)
# =============================================================================
set -euo pipefail

: "${WG_ADDRESS:?set WG_ADDRESS=10.90.0.2/24}"
: "${WG_PEER_PUBKEY:?set WG_PEER_PUBKEY=<hub pubkey>}"
: "${WG_PEER_ALLOWED:?set WG_PEER_ALLOWED=10.90.0.0/24,...}"
WG_LISTEN_PORT="${WG_LISTEN_PORT:-51820}"
WG_ENDPOINT_LINE=""
[ -n "${WG_PEER_ENDPOINT:-}" ] && WG_ENDPOINT_LINE="Endpoint = ${WG_PEER_ENDPOINT}"
TAP_SUPERNET="${TAP_SUPERNET:-172.16.0.0/16}"
WG_KEEPALIVE="${WG_KEEPALIVE:-25}"
log() { echo "[wg-mesh] $*"; }

[ "$(id -u)" = "0" ] || { echo "must run as root"; exit 1; }
command -v wg >/dev/null || { echo "wireguard-tools missing — run host-bootstrap.sh"; exit 2; }

install -d -m0700 /etc/wireguard
if [ ! -f /etc/wireguard/wg0.key ]; then
  log "generating host keypair..."
  umask 077
  wg genkey | tee /etc/wireguard/wg0.key | wg pubkey > /etc/wireguard/wg0.pub
fi
PRIV="$(cat /etc/wireguard/wg0.key)"
PUB="$(cat /etc/wireguard/wg0.pub)"

log "writing /etc/wireguard/wg0.conf..."
cat > /etc/wireguard/wg0.conf <<CONF
[Interface]
Address = ${WG_ADDRESS}
ListenPort = ${WG_LISTEN_PORT}
PrivateKey = ${PRIV}
# Forward microVM tap traffic onto the mesh + masquerade so the OCI side only
# has to allow the mesh subnet (not every /30 tap link).
PostUp = sysctl -w net.ipv4.ip_forward=1
PostUp = iptables -t nat -A POSTROUTING -s ${TAP_SUPERNET} -o %i -j MASQUERADE
PostUp = iptables -A FORWARD -s ${TAP_SUPERNET} -o %i -j ACCEPT
PostUp = iptables -A FORWARD -i %i -d ${TAP_SUPERNET} -m state --state RELATED,ESTABLISHED -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -s ${TAP_SUPERNET} -o %i -j MASQUERADE
PostDown = iptables -D FORWARD -s ${TAP_SUPERNET} -o %i -j ACCEPT
PostDown = iptables -D FORWARD -i %i -d ${TAP_SUPERNET} -m state --state RELATED,ESTABLISHED -j ACCEPT

[Peer]
PublicKey = ${WG_PEER_PUBKEY}
AllowedIPs = ${WG_PEER_ALLOWED}
${WG_ENDPOINT_LINE}
PersistentKeepalive = ${WG_KEEPALIVE}
CONF
chmod 600 /etc/wireguard/wg0.conf

log "bringing up wg0..."
wg-quick down wg0 2>/dev/null || true
wg-quick up wg0
systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true

echo
wg show wg0 || true
echo
log "HOST PUBLIC KEY (add as a [Peer] on the OCI hub, AllowedIPs = ${WG_ADDRESS%%/*}/32 + ${TAP_SUPERNET}):"
echo "  $PUB"
log "endpoint for the hub to dial this host: <public-ip>:${WG_LISTEN_PORT}"
