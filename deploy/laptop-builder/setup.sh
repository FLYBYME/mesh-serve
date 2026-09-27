#!/usr/bin/env bash
# Makes this laptop a catalog builder during development (owner, 2026-09-27: "during dev periods
# it's ok to use this laptop as the catalog builder only"). Builds normally run on ns2 (parts=queue);
# this is for when a laptop build is wanted. Run it yourself.
#
#   1. the laptop on the fleet network: run fleet.sh first (a device, 10.10.0.x; needs sudo there)
#   2. ns2's node settings and git credentials copied here, machine to machine, never printed (0600)
#   3. a mesh-serve node in docker: nodeID laptop, on its fleet address, parts=queue
#
# The mesh moved from the old wg0 (10.42.0.0/24) to the fleet network on 2026-09-27; this used to set
# up its own wg0 tunnel and peers. The builder only takes builds while ns2 does not: set ns2's parts
# label to none (serve.node.label) if both should not build.
#
# Undo: docker rm -f mesh-builder; fleet.sh's own undo for the tunnel.
set -euo pipefail

VERSION=${VERSION:-v0.9.10}
DIR=$HOME/.mesh-builder
# The fleet addresses of the host mesh nodes.
BOOTSTRAP=(ws://10.10.0.3:6005 ws://10.10.0.4:6005 ws://10.10.0.5:6005 ws://10.10.0.6:6005)

# --- 1. on the fleet ---
ADDR=$(ip -4 -o addr show fleet 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
if [ -z "$ADDR" ]; then
    echo "No fleet interface here: run $(dirname "$0")/fleet.sh first." >&2
    exit 1
fi
echo "fleet address: $ADDR"
mkdir -p "$DIR/mesh" && chmod 700 "$DIR"

# --- 2. settings and git credentials, from ns2, never printed ---
(umask 077; ssh -o BatchMode=yes ubuntu@51.195.151.109 'sudo -n cat /etc/mesh/node.env' > "$DIR/node.env")
(umask 077; ssh -o BatchMode=yes ubuntu@51.195.151.109 'cat /home/ubuntu/.gitconfig' > "$DIR/gitconfig")
echo "settings and git credentials copied ($(wc -l < "$DIR/node.env") setting lines)"

# --- 3. the builder node ---
docker rm -f mesh-builder >/dev/null 2>&1 || true
docker run -d --name mesh-builder --restart unless-stopped --init \
    --network host \
    --env-file "$DIR/node.env" \
    -v "$DIR/mesh:/home/node/.mesh" \
    -v "$DIR/gitconfig:/home/node/.gitconfig:ro" \
    "ghcr.io/flybyme/mesh-serve:$VERSION" \
    start --nodeID laptop --host "$ADDR" --wsPort 6005 --advertise "$ADDR" \
    --bootstrapNode "${BOOTSTRAP[@]}" \
    --labels role=builder parts=queue
echo "builder started: docker logs -f mesh-builder"
