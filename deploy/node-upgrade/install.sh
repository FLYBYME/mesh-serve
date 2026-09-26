#!/usr/bin/env bash
# Installs the host half of `serve.node.upgrade` on a mesh node. Run once per node, as root:
#
#   ssh <node> 'sudo bash -s' < deploy/node-upgrade/install.sh
#
# The node (a container under systemd) cannot swap its own image, so it writes the release it wants
# into ~/.mesh/upgrade/request -- a host directory mounted into the container. This installs a systemd
# path unit that watches that file, and the script it runs:
#   - accepts exactly a release version (vX.Y.Z) and builds the image name itself, from a fixed
#     registry path -- a request can never name another image;
#   - pulls ghcr.io/flybyme/mesh-serve:<version>, backs up the unit, points it at the new image,
#     restarts mesh-node;
#   - rolls back to the previous image if mesh-node is not active 20 s later;
#   - writes ~/.mesh/upgrade/result.json, which the node reports through serve.node.version.
# Idempotent: running it again reinstalls the same files.
set -euo pipefail

# Overridable only so test/node-upgrade can run this against a fake host; the defaults are the real ones.
UNIT=${MESH_NODE_UNIT:-/etc/systemd/system/mesh-node.service}
SBIN=${MESH_UPGRADE_SBIN:-/usr/local/sbin}
SYSTEMD_DIR=${MESH_UPGRADE_SYSTEMD_DIR:-/etc/systemd/system}
[ -f "$UNIT" ] || { echo "no $UNIT on this host -- not a mesh node" >&2; exit 1; }

# The host directory the container sees as /home/node/.mesh: "-v <host>:/home/node/.mesh".
DIR=$(grep -oE -- '-v [^ ]+:/home/node/\.mesh( |$)' "$UNIT" | head -1 | sed -E 's/^-v ([^:]+):.*/\1/')
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "cannot find the host directory mounted as /home/node/.mesh in $UNIT" >&2; exit 1; }
OWNER=$(stat -c '%u:%g' "$DIR")

install -d -o "${OWNER%:*}" -g "${OWNER#*:}" "$DIR/upgrade"

cat > "$SBIN/mesh-node-upgrade" <<EOF
#!/usr/bin/env bash
# Installed by mesh-serve deploy/node-upgrade/install.sh -- see there.
set -uo pipefail
UNIT=$UNIT
DIR=$DIR
OWNER=$OWNER
EOF
cat >> "$SBIN/mesh-node-upgrade" <<'EOF'
REQ="$DIR/upgrade/request"
RES="$DIR/upgrade/result.json"
REPO=ghcr.io/flybyme/mesh-serve
[ -f "$REQ" ] || exit 0
want=$(head -c 64 "$REQ" | tr -d ' \r\n')
rm -f "$REQ"
cur=$(grep -oE "$REPO:v[0-9]+\.[0-9]+\.[0-9]+" "$UNIT" | head -1 | sed 's/.*://')

result() {
    local msg=${2//\"/\'}
    printf '{"requested":"%s","from":"%s","status":"%s","message":"%s","at":"%s"}\n' \
        "$want" "$cur" "$1" "$msg" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RES.tmp"
    chown "$OWNER" "$RES.tmp"; mv "$RES.tmp" "$RES"
    logger -t mesh-node-upgrade "$1: $want (from $cur) -- $2"
}

if ! [[ $want =~ ^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$ ]]; then result refused "not a release version"; exit 0; fi
[ -n "$cur" ] || { result refused "the unit names no $REPO image to replace"; exit 0; }
[ "$want" = "$cur" ] && { result unchanged "already running $cur"; exit 0; }
if ! out=$(docker pull -q "$REPO:$want" 2>&1); then result failed "pull failed: ${out:0:200}"; exit 0; fi

cp "$UNIT" "$UNIT.bak-$cur"
sed -i "s|$REPO:$cur|$REPO:$want|" "$UNIT"
systemctl daemon-reload
result restarting "$cur -> $want"
systemctl restart mesh-node
sleep "${MESH_UPGRADE_SETTLE_S:-20}"
if systemctl is-active --quiet mesh-node; then
    result done "$cur -> $want"
else
    cp "$UNIT.bak-$cur" "$UNIT"
    systemctl daemon-reload
    systemctl restart mesh-node
    result rolled-back "$want did not stay up; back on $cur"
fi
EOF
chmod 755 "$SBIN/mesh-node-upgrade"

cat > "$SYSTEMD_DIR/mesh-node-upgrade.service" <<EOF
[Unit]
Description=Move mesh-node to the release it requested (serve.node.upgrade)

[Service]
Type=oneshot
ExecStart=$SBIN/mesh-node-upgrade
EOF

cat > "$SYSTEMD_DIR/mesh-node-upgrade.path" <<EOF
[Unit]
Description=Watch for mesh-node upgrade requests (serve.node.upgrade)

[Path]
PathChanged=$DIR/upgrade/request

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mesh-node-upgrade.path
touch "$DIR/upgrade/agent-installed"; chown "$OWNER" "$DIR/upgrade/agent-installed"
echo "installed: watching $DIR/upgrade/request (mesh-node-upgrade.path is $(systemctl is-active mesh-node-upgrade.path))"
