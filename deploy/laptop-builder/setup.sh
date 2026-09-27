#!/usr/bin/env bash
# Makes this laptop the catalog builder during development (owner, 2026-09-27: "during dev periods
# it's ok to use this laptop as the catalog builder only ... 4 GB of RAM is not enough to build these
# artifacts"). Run it yourself: it adds a WireGuard peer on the mesh nodes and needs sudo here.
#
#   1. a WireGuard key for the laptop; the laptop becomes 10.42.0.10 on the mesh network (wg0)
#   2. the laptop added as a peer on surf, edge1, ns1, ns2 (live, and in /etc/wireguard/wg0.conf)
#   3. the laptop's own tunnel, /etc/wireguard/mesh.conf, brought up with wg-quick (sudo)
#   4. ns2's node settings and git credentials copied here, machine to machine, never printed (0600)
#   5. a mesh-serve node in docker: nodeID laptop, parts=queue -- the only node that builds
#
# Undo: docker rm -f mesh-builder; sudo wg-quick down mesh; remove the peer on each node
# (sudo wg set wg0 peer <key> remove, and its [Peer] block in /etc/wireguard/wg0.conf).
set -euo pipefail

VERSION=${VERSION:-v0.9.3}
DIR=$HOME/.mesh-builder
ADDR=10.42.0.10
# name  public-ip        mesh-ip    ssh user (surf was set up by the platform: surfdns)
NODES=(
    "surf  169.197.131.82 10.42.0.5 surfdns"
    "edge1 158.69.213.185 10.42.0.4 ubuntu"
    "ns1   158.69.203.224 10.42.0.2 ubuntu"
    "ns2   51.195.151.109 10.42.0.3 ubuntu"
)

mkdir -p "$DIR/mesh" && chmod 700 "$DIR"

# --- 1. key ---
[ -f "$DIR/wg.key" ] || (umask 077; wg genkey > "$DIR/wg.key")
PUB=$(wg pubkey < "$DIR/wg.key")
echo "laptop public key: $PUB"

# --- 2. peer on every mesh node (no endpoint: the laptop is behind NAT and keeps the tunnel open) ---
for n in "${NODES[@]}"; do
    read -r name ip _ user <<< "$n"
    # `wg set` adds no route (only wg-quick up does): without one, the node's replies to the laptop
    # left by its default route and never came back through the tunnel.
    ssh -o BatchMode=yes "$user@$ip" "sudo -n wg set wg0 peer $PUB allowed-ips $ADDR/32 && sudo -n ip route replace $ADDR/32 dev wg0 && \
        (sudo -n grep -q '$PUB' /etc/wireguard/wg0.conf || printf '\n# laptop builder (dev periods)\n[Peer]\nPublicKey = $PUB\nAllowedIPs = $ADDR/32\n' | sudo -n tee -a /etc/wireguard/wg0.conf >/dev/null)"
    echo "peer added on $name"
done

# --- 3. the laptop's tunnel ---
CONF=$(mktemp)
{
    echo "[Interface]"
    echo "PrivateKey = $(cat "$DIR/wg.key")"
    echo "Address = $ADDR/24"
    for n in "${NODES[@]}"; do
        read -r name ip mesh user <<< "$n"
        peerkey=$(ssh -o BatchMode=yes "$user@$ip" 'sudo -n wg show wg0 public-key')
        echo ""
        echo "# $name"
        echo "[Peer]"
        echo "PublicKey = $peerkey"
        echo "Endpoint = $ip:51820"
        echo "AllowedIPs = $mesh/32"
        echo "PersistentKeepalive = 25"
    done
} > "$CONF"
sudo install -m 600 "$CONF" /etc/wireguard/mesh.conf
rm -f "$CONF"
sudo wg-quick down mesh 2>/dev/null || true
sudo wg-quick up mesh
for n in "${NODES[@]}"; do
    read -r name _ mesh _ <<< "$n"
    ping -c 1 -W 3 "$mesh" >/dev/null && echo "$name ($mesh) answers over the mesh" || echo "WARNING: $name ($mesh) does not answer"
done

# --- 4. settings and git credentials, from ns2, never printed ---
(umask 077; ssh -o BatchMode=yes ubuntu@51.195.151.109 'sudo -n cat /etc/mesh/node.env' > "$DIR/node.env")
(umask 077; ssh -o BatchMode=yes ubuntu@51.195.151.109 'cat /home/ubuntu/.gitconfig' > "$DIR/gitconfig")
echo "settings and git credentials copied ($(wc -l < "$DIR/node.env") setting lines)"

# --- 5. the builder node ---
docker rm -f mesh-builder >/dev/null 2>&1 || true
docker run -d --name mesh-builder --restart unless-stopped --init \
    --network host \
    --env-file "$DIR/node.env" \
    -v "$DIR/mesh:/home/node/.mesh" \
    -v "$DIR/gitconfig:/home/node/.gitconfig:ro" \
    "ghcr.io/flybyme/mesh-serve:$VERSION" \
    start --nodeID laptop --host $ADDR --wsPort 6005 --advertise $ADDR \
    --bootstrapNode ws://10.42.0.5:6005 ws://10.42.0.4:6005 ws://10.42.0.2:6005 ws://10.42.0.3:6005 \
    --labels role=builder parts=queue
echo "builder started: docker logs -f mesh-builder"
