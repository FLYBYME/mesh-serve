#!/usr/bin/env bash
# Pods connect to each other, not only to the node they start from.
#
# Three mesh-serve pods on a k3d cluster, each on its own pod IP and the same port, advertising
# $(POD_IP): pex-a, and pex-b / pex-c bootstrapped to pex-a only. Passes when, after the lease
# (30 s) and prune (60 s) windows, every pod holds a link to both others and none restarted.
# Before mesh v4.8.4 a node with --advertise advertised no address, so b and c never met.
#
# Usage: deploy/k3d-pex/check.sh [k3d-cluster]   (default paas-test; builds the image from here)
set -euo pipefail
CLUSTER="${1:-paas-test}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="k3d-${CLUSTER}-server-0"
K=(docker exec -i "$NODE" kubectl)

docker build -q -t mesh-serve:pextest "$HERE/../.." >/dev/null
# `k3d image import` can hang; loading into the node's containerd directly does not.
docker save mesh-serve:pextest | docker exec -i "$NODE" ctr -n k8s.io images import - >/dev/null
docker image inspect mongo:7 >/dev/null 2>&1 || docker pull -q mongo:7 >/dev/null
docker save mongo:7 | docker exec -i "$NODE" ctr -n k8s.io images import - >/dev/null

"${K[@]}" delete ns pextest --ignore-not-found --wait=true >/dev/null
"${K[@]}" apply -f - < "$HERE/pods.yaml" >/dev/null
"${K[@]}" -n pextest wait --for=condition=Ready pod --all --timeout=180s >/dev/null
sleep 100

fail=0
for p in a b c; do
    links=$("${K[@]}" -n pextest logs "pex-$p" | grep -aoE 'Peer connected: pex-[a-z]+' | sort -u | sed 's/Peer connected: //' | tr '\n' ' ')
    restarts=$("${K[@]}" -n pextest get pod "pex-$p" -o jsonpath='{.status.containerStatuses[0].restartCount}')
    want=$(for q in a b c; do if [ "$q" != "$p" ]; then printf 'pex-%s ' "$q"; fi; done)
    echo "pex-$p links: ${links}restarts: $restarts"
    [ "$links" = "$want" ] && [ "$restarts" = 0 ] || fail=1
done
"${K[@]}" delete ns pextest --wait=false >/dev/null
[ "$fail" = 0 ] && echo PASS || { echo FAIL; exit 1; }
