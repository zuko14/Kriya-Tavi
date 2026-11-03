#!/usr/bin/env bash
# kriya-node host setup (CD-34; SELF_HOSTED_OPERATIONS_RUNBOOK §2 step 5).
# Owner-run, as root, on a staging node only after the runbook's preflight.
# Idempotent: re-running replaces Kriya's chain and leaves everything else.
#
# What it does, and nothing more:
#   1. The sandbox network: a bridge with traffic between sandboxes off,
#      no IPv6, its own subnet.
#   2. KRIYA-SBX, jumped to from DOCKER-USER for traffic from that bridge:
#      private, loopback, link-local (incl. cloud metadata), CGNAT and
#      multicast destinations dropped; the public internet allowed (the
#      in-image proxy narrows it to package registries, CD-12).
#   3. INPUT from the bridge: only replies to connections the host opened
#      (kriya-node talking to runners); sandboxes can't reach host services.
#   4. ip6tables: nothing from or to the bridge.
# kriya-node refuses to take sandboxes until rule 2 is in place.
#
#   sudo bash cloud-node/host-setup.sh            # apply
#   sudo bash cloud-node/host-setup.sh --check    # verify only
set -euo pipefail

NETWORK="${KRIYA_NODE_NETWORK:-kriya-sbx}"
BRIDGE="${KRIYA_NODE_BRIDGE:-kriya-sbx0}"
SUBNET="${KRIYA_NODE_SUBNET:-10.89.0.0/24}"
BLOCKED=(0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
         192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4)

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

check() {
  local ok=0
  docker network inspect "$NETWORK" --format '{{index .Options "com.docker.network.bridge.enable_icc"}}' 2>/dev/null \
    | grep -qx false || { echo "missing: network $NETWORK with ICC off"; ok=1; }
  iptables -C DOCKER-USER -i "$BRIDGE" -j KRIYA-SBX 2>/dev/null || { echo "missing: DOCKER-USER jump"; ok=1; }
  iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || { echo "missing: INPUT drop"; ok=1; }
  ip6tables -C FORWARD -i "$BRIDGE" -j DROP 2>/dev/null || { echo "missing: ip6tables drop"; ok=1; }
  [ $ok = 0 ] && echo "kriya-node host rules: OK"
  return $ok
}

if [ "${1:-}" = "--check" ]; then check; exit $?; fi

# 1. Network
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network create --driver bridge \
    --subnet "$SUBNET" \
    --opt com.docker.network.bridge.name="$BRIDGE" \
    --opt com.docker.network.bridge.enable_icc=false \
    --opt com.docker.network.bridge.enable_ip_masquerade=true \
    "$NETWORK"
fi
sysctl -q -w "net.ipv6.conf.$BRIDGE.disable_ipv6=1" || true

# 2. Forwarded traffic from sandboxes
iptables -N KRIYA-SBX 2>/dev/null || iptables -F KRIYA-SBX
iptables -A KRIYA-SBX -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in "${BLOCKED[@]}"; do iptables -A KRIYA-SBX -d "$net" -j DROP; done
iptables -A KRIYA-SBX -j RETURN
iptables -C DOCKER-USER -i "$BRIDGE" -j KRIYA-SBX 2>/dev/null || iptables -I DOCKER-USER 1 -i "$BRIDGE" -j KRIYA-SBX

# 3. Sandboxes to the host itself
iptables -C INPUT -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  || iptables -I INPUT 1 -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || iptables -I INPUT 2 -i "$BRIDGE" -j DROP

# 4. IPv6
for chain in INPUT FORWARD; do
  ip6tables -C "$chain" -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I "$chain" 1 -i "$BRIDGE" -j DROP
done
ip6tables -C FORWARD -o "$BRIDGE" -j DROP 2>/dev/null || ip6tables -I FORWARD 1 -o "$BRIDGE" -j DROP

check
echo "Persist with your distribution's iptables-persistent (runbook §2 step 5)."
