#!/usr/bin/env bash
# =============================================================================
# wg-selftest.sh — prove the WireGuard mesh mechanics end-to-end on ONE host,
# with no external peer, by standing up two network namespaces connected by a
# real WireGuard tunnel and passing traffic across the overlay.
# =============================================================================
# This validates exactly what wg-mesh.sh relies on: kernel WireGuard support,
# key exchange, Endpoint dialing, AllowedIPs-based routing, and that overlay
# IPs are reachable across the tunnel. It's the objective "tested connectivity"
# gate for Phase 2c before wiring the real OCI hub.
#
#   ns "wg-a"  underlay 10.250.0.1  overlay 10.99.0.1
#   ns "wg-b"  underlay 10.250.0.2  overlay 10.99.0.2
#   veth pair carries the encrypted UDP; ping runs over the overlay.
#
# Run on the host as root:  bash wg-selftest.sh
# =============================================================================
set -euo pipefail
log() { echo "[wg-selftest] $*"; }
[ "$(id -u)" = "0" ] || { echo "must run as root"; exit 1; }
command -v wg >/dev/null || { echo "wireguard-tools missing — run host-bootstrap.sh"; exit 2; }

cleanup() {
  ip netns del wg-a 2>/dev/null || true
  ip netns del wg-b 2>/dev/null || true
}
trap cleanup EXIT
cleanup

# Keys
AK=$(wg genkey); APUB=$(echo "$AK" | wg pubkey)
BK=$(wg genkey); BPUB=$(echo "$BK" | wg pubkey)

# Namespaces + underlay veth
ip netns add wg-a
ip netns add wg-b
ip link add veth-a netns wg-a type veth peer name veth-b netns wg-b
ip -n wg-a addr add 10.250.0.1/30 dev veth-a
ip -n wg-b addr add 10.250.0.2/30 dev veth-b
ip -n wg-a link set veth-a up
ip -n wg-b link set veth-b up
ip -n wg-a link set lo up
ip -n wg-b link set lo up

# WireGuard interfaces (created in root ns, then moved — wg type must be added
# in a ns that has the module; add directly inside each ns).
ip -n wg-a link add wg0 type wireguard
ip -n wg-b link add wg0 type wireguard

# Configure A
ip netns exec wg-a sh -c "echo '$AK' > /tmp/a.key"
ip netns exec wg-a wg set wg0 private-key /tmp/a.key listen-port 51820 \
  peer "$BPUB" allowed-ips 10.99.0.2/32 endpoint 10.250.0.2:51821 persistent-keepalive 5
ip -n wg-a addr add 10.99.0.1/32 dev wg0
ip -n wg-a link set wg0 up
ip -n wg-a route add 10.99.0.2/32 dev wg0

# Configure B
ip netns exec wg-b sh -c "echo '$BK' > /tmp/b.key"
ip netns exec wg-b wg set wg0 private-key /tmp/b.key listen-port 51821 \
  peer "$APUB" allowed-ips 10.99.0.1/32 endpoint 10.250.0.1:51820 persistent-keepalive 5
ip -n wg-b addr add 10.99.0.2/32 dev wg0
ip -n wg-b link set wg0 up
ip -n wg-b route add 10.99.0.1/32 dev wg0

log "handshaking..."
sleep 2

echo "--- wg-a wg0 ---"; ip netns exec wg-a wg show wg0 | sed 's/^/  /'
echo "--- overlay ping A(10.99.0.1) -> B(10.99.0.2) ---"
if ip netns exec wg-a ping -c 3 -W 2 10.99.0.2; then
  hs=$(ip netns exec wg-a wg show wg0 latest-handshakes | awk '{print $2}')
  rx=$(ip netns exec wg-a wg show wg0 transfer | awk '{print $3}')
  echo
  log "PASS — tunnel up, latest-handshake=${hs} (epoch), rx=${rx}B over the overlay."
  exit 0
else
  echo
  log "FAIL — overlay unreachable across the WireGuard tunnel."
  ip netns exec wg-a wg show wg0 || true
  exit 1
fi
