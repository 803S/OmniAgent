#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$ROOT_DIR")"
VENV_DIR="$ROOT_DIR/.venv"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/start-$(date +%Y%m%d-%H%M%S).log"

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[INFO] OmniAgent Gemini Baseline Rebuild"
echo "[INFO] root=$ROOT_DIR"
echo "[INFO] project=$PROJECT_DIR"
echo "[INFO] log_file=$LOG_FILE"
echo "[INFO] python=$(command -v python3 || true)"
echo "[INFO] runtime_env_primary=$ROOT_DIR/.env"
echo "[INFO] project_root_env_opt_in=${OMNIAGENT_ALLOW_PROJECT_ROOT_ENV:-0}"
echo "[INFO] ccswitch_endpoint_resolution=CCSWITCH_BASE_URL > CCSWITCH_PROXY_URL > CCSWITCH_PROXY_HOST:PORT > trusted_system_proxy > host_ccswitch_discovery"
echo "[INFO] ccswitch_http_proxy_mode=${CCSWITCH_USE_HTTP_PROXY:-0}"

if [ ! -d "$VENV_DIR" ]; then
  echo "[INFO] creating virtualenv: $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

echo "[INFO] venv_python=$VENV_DIR/bin/python"
echo "[INFO] venv_pip=$VENV_DIR/bin/pip"

if [ "${OMNIAGENT_SKIP_INSTALL:-0}" = "1" ]; then
  echo "[INFO] skipping dependency install because OMNIAGENT_SKIP_INSTALL=1"
else
  echo "[INFO] installing requirements"
  "$VENV_DIR/bin/pip" install -r "$ROOT_DIR/backend/requirements.txt"
fi

echo "[INFO] running syntax check"
"$VENV_DIR/bin/python" -m py_compile "$ROOT_DIR/backend/server.py" "$ROOT_DIR/backend/db.py"

echo "[INFO] starting backend on default http://127.0.0.1:8765"
cd "$ROOT_DIR"
exec "$VENV_DIR/bin/python" -m backend.server
