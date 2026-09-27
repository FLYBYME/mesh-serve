#!/usr/bin/env bash
# Puts this laptop on the fleet network (10.10.0.0/24) as a device, beside the old wg0 tunnel that
# setup.sh made. The mesh is moving from wg0 to the fleet (2026-09-28); the builder follows it once
# the host nodes have moved. Run it yourself -- the last step needs sudo here. Rerunnable.
#
#   1. a fleet WireGuard key for the laptop, kept in ~/.mesh-builder (never leaves it)
#   2. machine.device_add: the platform allocates the laptop's fleet address and adds it as a peer
#      on every machine (from the records -- nothing is edited on the machines by hand)
#   3. /etc/wireguard/fleet.conf from what device_add returned, brought up with wg-quick (sudo)
#
# Undo: sudo wg-quick down fleet; mesh-serve machine.device_remove --name laptop
set -euo pipefail

DIR=$HOME/.mesh-builder
NAME=${NAME:-laptop}
CLI="node $(cd "$(dirname "$0")/../.." && pwd)/bin/mesh-serve.mjs"
mkdir -p "$DIR" && chmod 700 "$DIR"

# --- 1. key ---
[ -f "$DIR/fleet.key" ] || (umask 077; wg genkey > "$DIR/fleet.key")
PUB=$(wg pubkey < "$DIR/fleet.key")

# --- 2. on the fleet, as a device ---
# The CLI can print an error and still exit 0 (an unknown command): judge by what came back. A run
# that went on with an empty address wrote a useless fleet.conf and had wg-quick fail on "/".
OUT=$($CLI machine.device_add --name "$NAME" --publicKey "$PUB" --description "operator laptop, the builder during dev periods" 2>&1) || true
ADDR=$(jq -r '.tunnelIp // empty' <<< "$OUT" 2>/dev/null || true)
PREFIX=$(jq -r '.prefix // empty' <<< "$OUT" 2>/dev/null || true)
if [ -z "$ADDR" ] || [ -z "$PREFIX" ]; then
    echo "machine.device_add did not give this laptop a fleet address; nothing changed here:" >&2
    echo "$OUT" >&2
    exit 1
fi
echo "fleet address: $ADDR/$PREFIX"
jq -r '.notUpdated[]? | "WARNING: not updated yet: \(.)"' <<< "$OUT"

# --- 3. the laptop's side ---
CONF=$(mktemp)
{
    echo "# Rendered by mesh-serve deploy/laptop-builder/fleet.sh from machine.device_add."
    echo "[Interface]"
    echo "PrivateKey = $(cat "$DIR/fleet.key")"
    echo "Address = $ADDR/$PREFIX"
    # Every machine: this end dials them and keeps the tunnel open through the NAT.
    jq -r '.peers[] | "\n# \(.hostname)\n[Peer]\nPublicKey = \(.publicKey)\nEndpoint = \(.endpoint)\nAllowedIPs = \(.tunnelIp)/32\nPersistentKeepalive = 25"' <<< "$OUT"
} > "$CONF"
sudo install -m 600 "$CONF" /etc/wireguard/fleet.conf
rm -f "$CONF"
sudo wg-quick down fleet 2>/dev/null || true
sudo wg-quick up fleet
jq -r '.peers[] | "\(.hostname) \(.tunnelIp)"' <<< "$OUT" | while read -r host ip; do
    ping -c 1 -W 3 "$ip" >/dev/null && echo "$host ($ip) answers over the fleet" || echo "WARNING: $host ($ip) does not answer"
done
