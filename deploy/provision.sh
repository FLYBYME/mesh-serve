#!/usr/bin/env bash
set -euo pipefail

# Provision a mesh-serve node from bare Ubuntu to running.
# Safe to run twice: re-running converges rather than duplicating.
#
# Usage:
#   cat node.env | ./deploy/provision.sh [OPTIONS] [REF]
#
# Environment variables:
#   MESH_REF            Git branch, tag, or commit to checkout (default: master)
#   MESH_ROLE           Node role: "head", "dialin", or "auto" (default: auto; surf -> head, others -> dialin)
#   MESH_TARGET_DIR     Checkout directory (default: /srv/mesh-serve)
#   MESH_ENV_FILE       Path to environment file (default: /etc/mesh/node.env)
#   MESH_SYSTEMD_DIR    Systemd unit directory (default: /etc/systemd/system)
#   MESH_REPO_URL       Repository URL (default: https://github.com/FLYBYME/mesh-serve.git)
#   MESH_DRY_RUN        Set to 1 for dry run
#   MESH_SKIP_ROOT_CHECK Set to 1 to skip root user check (for testing)
#   MESH_SKIP_BUILD     Set to 1 to skip npm install & build (for testing)

TARGET_DIR="${MESH_TARGET_DIR:-/srv/mesh-serve}"
ENV_FILE="${MESH_ENV_FILE:-/etc/mesh/node.env}"
SYSTEMD_DIR="${MESH_SYSTEMD_DIR:-/etc/systemd/system}"
REPO_URL="${MESH_REPO_URL:-https://github.com/FLYBYME/mesh-serve.git}"
DEFAULT_REF="${MESH_REF:-master}"
PINNED_REF=""
DRY_RUN="${MESH_DRY_RUN:-0}"
ROLE="${MESH_ROLE:-auto}"
VERIFY_ONLY=0
SKIP_ROOT_CHECK="${MESH_SKIP_ROOT_CHECK:-0}"
SKIP_BUILD="${MESH_SKIP_BUILD:-0}"
SYSTEMCTL_BIN="${MESH_SYSTEMCTL_BIN:-systemctl}"
JOURNALCTL_BIN="${MESH_JOURNALCTL_BIN:-journalctl}"
VERIFY_TIMEOUT="${MESH_VERIFY_TIMEOUT:-25}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            echo "Usage: cat node.env | $0 [OPTIONS] [REF]"
            echo ""
            echo "Options:"
            echo "  --ref <ref>       Git branch, tag, or commit to checkout (default: master or MESH_REF)"
            echo "  --dry-run, -n     Dry run mode: show actions without modifying system"
            echo "  --head            Configure as head node (bind mesh port to 0.0.0.0)"
            echo "  --dial-in         Configure as dial-in node (bind mesh port strictly to 127.0.0.1)"
            echo "  --verify-only     Only verify that the running mesh-node service is healthy"
            echo "  --help, -h        Show this help message"
            exit 0
            ;;
        --dry-run|-n)
            DRY_RUN=1
            shift
            ;;
        --head)
            ROLE="head"
            shift
            ;;
        --dial-in|--dialin)
            ROLE="dialin"
            shift
            ;;
        --verify-only)
            VERIFY_ONLY=1
            shift
            ;;
        --ref)
            PINNED_REF="$2"
            shift 2
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            if [ -z "$PINNED_REF" ]; then
                PINNED_REF="$1"
            else
                echo "Unexpected argument: $1" >&2
                exit 1
            fi
            shift
            ;;
    esac
done

if [ -z "$PINNED_REF" ]; then
    PINNED_REF="$DEFAULT_REF"
fi

# Verification logic
verify_node() {
    echo "Verifying mesh-node startup..."
    if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] Would verify service via $SYSTEMCTL_BIN is-active and listening socket / log output"
        return 0
    fi

    local timeout="$VERIFY_TIMEOUT"
    local interval=1
    local elapsed=0
    local is_ready=0

    while [ "$elapsed" -lt "$timeout" ]; do
        local state
        state=$("$SYSTEMCTL_BIN" is-active mesh-node 2>/dev/null || true)

        if [ "$state" = "failed" ]; then
            echo "Verification failure: mesh-node entered 'failed' state." >&2
            echo "--- systemctl status mesh-node ---" >&2
            "$SYSTEMCTL_BIN" status mesh-node --no-pager >&2 || true
            echo "--- Recent journal output ---" >&2
            "$JOURNALCTL_BIN" -u mesh-node -n 40 --no-pager >&2 || true
            return 1
        fi

        if [ "$state" = "active" ]; then
            # Check journal for startup banner
            if "$JOURNALCTL_BIN" -u mesh-node -n 50 --no-pager 2>/dev/null | grep -q "mesh-serve is up"; then
                is_ready=1
                break
            fi
            # Or check if API port (5005) or mesh port (4001) is listening
            if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -E -q ':(5005|4001)\b'; then
                is_ready=1
                break
            fi
        fi

        sleep "$interval"
        elapsed=$((elapsed + interval))
    done

    if [ "$is_ready" -ne 1 ]; then
        echo "Verification failure: mesh-node did not become ready within ${timeout}s." >&2
        echo "--- systemctl status mesh-node ---" >&2
        "$SYSTEMCTL_BIN" status mesh-node --no-pager >&2 || true
        echo "--- Recent journal output ---" >&2
        "$JOURNALCTL_BIN" -u mesh-node -n 40 --no-pager >&2 || true
        return 1
    fi

    echo "Verification success: mesh-node is active and healthy."
    return 0
}

if [ "$VERIFY_ONLY" -eq 1 ]; then
    verify_node
    exit 0
fi

# 1. Privilege check
if [ "$SKIP_ROOT_CHECK" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
    if [ "$(id -u)" -ne 0 ]; then
        echo "Error: this script must be run as root (or with MESH_SKIP_ROOT_CHECK=1 for testing)." >&2
        exit 1
    fi
fi

# 2. Environment and secrets configuration
# Secrets are never accepted via command line arguments (visible in ps).
# They must be piped over stdin into the script or exist in $ENV_FILE.
STDIN_DATA=""
if [ ! -t 0 ]; then
    STDIN_DATA=$(cat)
fi

if [ -n "$STDIN_DATA" ]; then
    echo "Writing environment configuration from stdin to $ENV_FILE..."
    if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] Would create $(dirname "$ENV_FILE") (0700) and write $ENV_FILE (0600)"
    else
        mkdir -p "$(dirname "$ENV_FILE")"
        chmod 700 "$(dirname "$ENV_FILE")" 2>/dev/null || true
        (
            umask 077
            printf "%s\n" "$STDIN_DATA" > "$ENV_FILE"
        )
        chmod 600 "$ENV_FILE"
    fi
elif [ -f "$ENV_FILE" ]; then
    echo "Using existing environment file at $ENV_FILE."
    if [ "$DRY_RUN" = "0" ]; then
        chmod 600 "$ENV_FILE" 2>/dev/null || true
    fi
else
    echo "Error: $ENV_FILE does not exist and no environment configuration was piped via stdin." >&2
    echo "Usage: cat node.env | $0 [ref]" >&2
    exit 1
fi

if [ "$DRY_RUN" = "0" ] && [ ! -s "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE is empty. Node requires environment configuration (e.g. MONGODB_URI, MESH_KEY)." >&2
    exit 1
fi

# 3. Prerequisites (Node 22 + git if absent)
echo "Checking prerequisites (Node.js 22 + git)..."

NEED_GIT=0
if ! command -v git >/dev/null 2>&1; then
    NEED_GIT=1
fi

if [ "$NEED_GIT" -eq 1 ]; then
    echo "Git not found. Installing git..."
    if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] Would run: apt-get update && apt-get install -y git"
    else
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -y
        apt-get install -y git
    fi
fi

NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
    NEED_NODE=1
else
    NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
    if [ "$NODE_MAJOR" -ne 22 ]; then
        echo "Found Node.js v$NODE_MAJOR, but Node 22 is required."
        NEED_NODE=1
    fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
    echo "Installing Node.js 22 via NodeSource..."
    if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] Would configure NodeSource repository and install nodejs (v22)"
    else
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -y
        apt-get install -y ca-certificates curl gnupg
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
        apt-get update -y
        apt-get install -y nodejs
    fi
fi

if [ "$DRY_RUN" = "0" ] && [ ! -x /usr/bin/node ] && command -v node >/dev/null 2>&1; then
    ln -sf "$(command -v node)" /usr/bin/node
fi

# 4. Clone or pull to pinned ref
echo "Preparing repository in $TARGET_DIR at ref '$PINNED_REF'..."

if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] Would clone or fetch $REPO_URL at $TARGET_DIR, checkout $PINNED_REF"
else
    if [ ! -d "$TARGET_DIR/.git" ]; then
        echo "Cloning $REPO_URL into $TARGET_DIR..."
        mkdir -p "$(dirname "$TARGET_DIR")"
        git clone "$REPO_URL" "$TARGET_DIR"
    else
        echo "Updating existing repository at $TARGET_DIR..."
    fi

    cd "$TARGET_DIR"
    git fetch --tags origin

    if git rev-parse --verify "origin/$PINNED_REF" >/dev/null 2>&1; then
        git checkout -B "$PINNED_REF" "origin/$PINNED_REF"
        git reset --hard "origin/$PINNED_REF"
    else
        git checkout --detach "$PINNED_REF"
    fi
fi

# 5. npm install and npm run build on the box
echo "Building mesh-serve in $TARGET_DIR..."
if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] Would run: cd $TARGET_DIR && npm install && npm run build"
elif [ "$SKIP_BUILD" = "1" ]; then
    echo "Skipping build (MESH_SKIP_BUILD=1)"
else
    cd "$TARGET_DIR"
    npm install --no-audit --no-fund
    npm run build
fi

# 6. Systemd unit installation & mesh port binding
echo "Configuring systemd service..."

CURRENT_HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "unknown")
IS_HEAD=0
if [ "$ROLE" = "head" ]; then
    IS_HEAD=1
elif [ "$ROLE" = "dialin" ]; then
    IS_HEAD=0
elif [ "$CURRENT_HOST" = "surf" ]; then
    IS_HEAD=1
fi

if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] Would copy deploy/mesh-node.service to $SYSTEMD_DIR/mesh-node.service"
    if [ "$IS_HEAD" = "1" ]; then
        echo "[dry-run] Role is HEAD: mesh port 4001 bound to 0.0.0.0"
    else
        echo "[dry-run] Role is DIAL-IN: mesh port 4001 confined to 127.0.0.1 via drop-in override (surfdns#50)"
    fi
else
    mkdir -p "$SYSTEMD_DIR"
    UNIT_SRC=""
    if [ -f "$TARGET_DIR/deploy/mesh-node.service" ]; then
        UNIT_SRC="$TARGET_DIR/deploy/mesh-node.service"
    else
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        if [ -f "$SCRIPT_DIR/mesh-node.service" ]; then
            UNIT_SRC="$SCRIPT_DIR/mesh-node.service"
        fi
    fi

    if [ -z "$UNIT_SRC" ] || [ ! -f "$UNIT_SRC" ]; then
        echo "Error: cannot find mesh-node.service source file" >&2
        exit 1
    fi

    cp "$UNIT_SRC" "$SYSTEMD_DIR/mesh-node.service"
    chmod 644 "$SYSTEMD_DIR/mesh-node.service"

    OVERRIDE_DIR="$SYSTEMD_DIR/mesh-node.service.d"
    OVERRIDE_FILE="$OVERRIDE_DIR/override.conf"

    if [ "$IS_HEAD" = "1" ]; then
        echo "Configured as head node (mesh port bound to 0.0.0.0)."
        rm -f "$OVERRIDE_FILE"
        rmdir "$OVERRIDE_DIR" 2>/dev/null || true
    else
        echo "Configured as dial-in node (mesh port confined to 127.0.0.1 per surfdns#50)."
        mkdir -p "$OVERRIDE_DIR"
        cat > "$OVERRIDE_FILE" << 'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/node bin/node.mjs --ws 4001 --ws-host 127.0.0.1 --cdn 8080 --api 5005 --db mesh-serve-live
EOF
        chmod 644 "$OVERRIDE_FILE"
    fi
fi

# 7. Enable and restart service
echo "Enabling and starting mesh-node service..."
if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] Would run: systemctl daemon-reload && systemctl enable mesh-node.service && systemctl restart mesh-node.service"
else
    "$SYSTEMCTL_BIN" daemon-reload
    "$SYSTEMCTL_BIN" enable mesh-node.service
    "$SYSTEMCTL_BIN" restart mesh-node.service
fi

# 8. Verification step
verify_node
