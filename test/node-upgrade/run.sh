#!/usr/bin/env bash
# Runs deploy/node-upgrade/install.sh and the upgrade script it installs against a fake host:
# a temp unit file, and stand-ins for systemctl/docker/logger that record what they were asked.
set -uo pipefail
# Usage: bash test/node-upgrade/run.sh  (from anywhere; needs nothing but bash)
INSTALL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/deploy/node-upgrade/install.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/etc" "$T/sbin" "$T/bin" "$T/mesh"
UNIT="$T/etc/mesh-node.service"
cat > "$UNIT" <<EOF
[Service]
ExecStart=/usr/bin/docker run --rm --init --name mesh-node \\
  -v $T/mesh:/home/node/.mesh \\
  ghcr.io/flybyme/mesh-serve:v0.8.16 \\
  start
EOF
echo active > "$T/state"
cat > "$T/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >> "$T/calls"
if [ "\$1" = is-active ]; then
  [ "\$2" = --quiet ] && { [ "\$(cat $T/state)" = active ]; exit \$?; }
  echo active; exit 0
fi
exit 0
EOF
cat > "$T/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$T/calls"
[ -f "$T/pullfail" ] && { echo "manifest unknown" >&2; exit 1; }
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/logger"
chmod +x "$T/bin/"*

export PATH="$T/bin:$PATH" MESH_NODE_UNIT="$UNIT" MESH_UPGRADE_SBIN="$T/sbin" MESH_UPGRADE_SYSTEMD_DIR="$T/etc" MESH_UPGRADE_SETTLE_S=0
fails=0
check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fails=$((fails+1)); fi; }
image() { grep -oE 'mesh-serve:v[0-9.]+' "$UNIT" | head -1; }
status() { sed -E 's/.*"status":"([^"]+)".*/\1/' "$T/mesh/upgrade/result.json"; }
request() { printf '%s\n' "$1" > "$T/mesh/upgrade/request"; : > "$T/calls"; "$T/sbin/mesh-node-upgrade"; }

bash "$INSTALL" > "$T/install.out" 2>&1
check "installer finds the mounted directory and installs" "grep -q 'watching $T/mesh/upgrade/request' '$T/install.out'"
check "path unit watches the request file" "grep -q 'PathChanged=$T/mesh/upgrade/request' '$T/etc/mesh-node-upgrade.path'"
check "agent marked installed for the node to see" "[ -f '$T/mesh/upgrade/agent-installed' ]"

request v0.8.17
check "a release: done, unit moved to it" "[ \"\$(status)\" = done ] && [ \"\$(image)\" = mesh-serve:v0.8.17 ]"
check "the old unit is backed up" "grep -q 'mesh-serve:v0.8.16' '$UNIT.bak-v0.8.16'"
check "pulled the fixed registry image, then restarted" "grep -q 'docker pull -q ghcr.io/flybyme/mesh-serve:v0.8.17' '$T/calls' && grep -q 'systemctl restart mesh-node' '$T/calls'"
check "the request is consumed" "[ ! -f '$T/mesh/upgrade/request' ]"

request v0.8.17
check "the same release again: unchanged, nothing pulled" "[ \"\$(status)\" = unchanged ] && ! grep -q docker '$T/calls'"

request 'v0.8.1; rm -rf /'
check "an injection attempt: refused, nothing run" "[ \"\$(status)\" = refused ] && ! grep -q docker '$T/calls' && [ \"\$(image)\" = mesh-serve:v0.8.17 ]"

request 'ghcr.io/evil/image:v1.0.0'
check "another image named: refused" "[ \"\$(status)\" = refused ] && [ \"\$(image)\" = mesh-serve:v0.8.17 ]"

touch "$T/pullfail"; request v0.8.18; rm -f "$T/pullfail"
check "a pull that fails: failed, unit untouched, no restart" "[ \"\$(status)\" = failed ] && [ \"\$(image)\" = mesh-serve:v0.8.17 ] && ! grep -q restart '$T/calls'"

echo inactive > "$T/state"; request v0.8.19
check "a release that does not stay up: rolled back to the previous" "[ \"\$(status)\" = rolled-back ] && [ \"\$(image)\" = mesh-serve:v0.8.17 ]"
echo active > "$T/state"

bash "$INSTALL" > /dev/null 2>&1
check "the installer can run again (idempotent)" "[ -f '$T/sbin/mesh-node-upgrade' ] && [ \"\$(image)\" = mesh-serve:v0.8.17 ]"

echo "--- $fails failure(s)"
exit $fails
