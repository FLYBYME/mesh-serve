#!/usr/bin/env bash
# Makes a fleet machine the platform's builder: a mesh-serve node in docker, labelled
# role=builder parts=queue, so the build queue runs there instead of on the gateway (edge1).
#
#   deploy/builder/setup.sh <name> <public ip> <fleet ip> [version]
#   deploy/builder/setup.sh compute1 51.77.217.101 10.10.0.7 v0.10.5
#
# Run from a machine whose ssh key the fleet trusts (the operator key machine.import authorized).
# The machine must already be imported (machine.import: platform user, fleet address, firewall).
#
#   1. docker on the machine
#   2. the node settings and git credentials, copied from ns2 machine to machine, never printed
#      (ns2 was the builder before edge1; its node.env holds what any node needs to join)
#   3. the builder node, on the machine's fleet address
#
# Then take the queue off edge1, or it keeps taking builds too:
#   mesh-serve serve.node.label --nodeID edge1 --set '{"parts":"api,cdn"}'
#
# Undo: ssh surfdns@<ip> sudo docker rm -f mesh-builder, and put queue back on edge1's parts.
# Written 2026-09-30 for compute1 (OVH KS-B, Gravelines), after edge1's builds kept stalling the
# public sites. Adapted from deploy/laptop-builder/setup.sh.
set -euo pipefail

NAME=${1:?name, e.g. compute1}
IP=${2:?public ip}
FLEET=${3:?fleet ip, e.g. 10.10.0.7}
VERSION=${4:-v0.10.5}
KEY=${KEY:-$HOME/.ssh/paas_infra_ed25519}
SETTINGS_FROM=${SETTINGS_FROM:-ubuntu@51.195.151.109}   # ns2
# The fleet addresses of the host mesh nodes (surf, ns2, edge1, ns1).
BOOTSTRAP="ws://10.10.0.3:6005 ws://10.10.0.4:6005 ws://10.10.0.5:6005 ws://10.10.0.6:6005"

on() { ssh -o BatchMode=yes -i "$KEY" "$@"; }
TARGET="surfdns@$IP"

echo "--- 1. docker on $NAME"
on "$TARGET" 'command -v docker >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io && sudo systemctl enable --now docker; }; docker --version'

echo "--- 2. settings and git credentials, from ns2, never printed"
on "$TARGET" 'sudo install -d -m 700 /etc/mesh && sudo install -d -o 1000 -g 1000 -m 700 /var/lib/mesh-builder/mesh'
on "$SETTINGS_FROM" 'sudo -n cat /etc/mesh/node.env' | on "$TARGET" 'sudo install -m 600 /dev/stdin /etc/mesh/node.env'
on "$SETTINGS_FROM" 'cat /home/ubuntu/.gitconfig' | on "$TARGET" 'sudo install -m 600 -o 1000 -g 1000 /dev/stdin /etc/mesh/gitconfig'
on "$TARGET" 'echo "$(sudo wc -l < /etc/mesh/node.env) setting lines, git credentials $(sudo test -s /etc/mesh/gitconfig && echo present || echo MISSING)"'

echo "--- 3. the builder node: $NAME on $FLEET, mesh-serve $VERSION"
on "$TARGET" "sudo docker rm -f mesh-builder >/dev/null 2>&1 || true
sudo docker run -d --name mesh-builder --restart unless-stopped --init --network host \
    --env-file /etc/mesh/node.env \
    -v /var/lib/mesh-builder/mesh:/home/node/.mesh \
    -v /etc/mesh/gitconfig:/home/node/.gitconfig:ro \
    ghcr.io/flybyme/mesh-serve:$VERSION \
    start --nodeID $NAME --host $FLEET --wsPort 6005 --advertise $FLEET \
    --bootstrapNode $BOOTSTRAP \
    --labels role=builder parts=queue
sleep 20; sudo docker ps --filter name=mesh-builder --format '{{.Status}}'; sudo docker logs --tail 5 mesh-builder 2>&1"

echo
echo "Next: mesh-serve serve.node.version --nodeID $NAME, then take the queue off edge1:"
echo "  mesh-serve serve.node.label --nodeID edge1 --set '{\"parts\":\"api,cdn\"}'"
