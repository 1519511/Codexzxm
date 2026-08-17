#!/bin/sh
set -eu

MODE=watch
FORCE=0
INTERVAL=${CODEXZXM_TUNNEL_INTERVAL:-30}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --once) MODE=once; shift ;;
    --status) MODE=status; shift ;;
    --force-reconnect) FORCE=1; shift ;;
    --interval) INTERVAL=$2; shift 2 ;;
    -h|--help) echo "Usage: codexzxm-tunnel-supervisor.sh [--once|--status] [--force-reconnect] [--interval seconds]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

STATE_ROOT=${CODEXZXM_STATE_ROOT:-"$HOME/.config/codexzxm"}
CONFIG_FILE=${CODEXZXM_TUNNEL_CONFIG:-"$STATE_ROOT/tunnel-macos.json"}
LOG_DIR="$STATE_ROOT/supervisor"
LOG_FILE="$LOG_DIR/tunnel-supervisor.log"
LOCK_DIR="$STATE_ROOT/.tunnel-supervisor-lock"
KEYCHAIN_SERVICE=com.codexzxm.openai-runtime
mkdir -p "$LOG_DIR"

[ -f "$CONFIG_FILE" ] || { echo "Codexzxm tunnel config is missing: $CONFIG_FILE" >&2; exit 1; }
NODE=$(command -v node 2>/dev/null || true)
[ -n "$NODE" ] || { echo "Node.js is required." >&2; exit 1; }

cfg() {
  "$NODE" -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];if(v!==undefined&&v!==null)process.stdout.write(String(v))' "$CONFIG_FILE" "$1"
}
ALIAS=$(cfg alias); TUNNEL_ID=$(cfg tunnelId); PROFILE_NAME=$(cfg profileName); PROFILE_DIR=$(cfg profileDir); MCP_COMMAND=$(cfg mcpCommand)
PROXY=$(cfg proxy || true); DEFAULT_CWD=$(cfg defaultCwd || true); PERMISSION_PROFILE=$(cfg permissionProfile || true); CONFIG_CLIENT=$(cfg tunnelClient || true)
[ -n "$ALIAS" ] && [ -n "$TUNNEL_ID" ] && [ -n "$PROFILE_NAME" ] && [ -n "$PROFILE_DIR" ] && [ -n "$MCP_COMMAND" ] || { echo "Tunnel config is incomplete." >&2; exit 1; }

resolve_client() {
  for candidate in "${CODEXZXM_TUNNEL_CLIENT:-}" "$CONFIG_CLIENT"; do [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s' "$candidate"; return; }; done
  command -v tunnel-client 2>/dev/null || true
}
TUNNEL_CLIENT=$(resolve_client)
[ -n "$TUNNEL_CLIENT" ] || { echo "tunnel-client was not found. Set CODEXZXM_TUNNEL_CLIENT or tunnelClient in $CONFIG_FILE." >&2; exit 1; }
HEALTH_FILE="$HOME/.local/state/tunnel-client/health/$ALIAS.url"
PROFILE_PATH="$PROFILE_DIR/$PROFILE_NAME.yaml"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG_FILE" 2>/dev/null || true; }
runtime_status() {
  BASE=""
  [ -f "$HEALTH_FILE" ] && BASE=$(cat "$HEALTH_FILE" 2>/dev/null | tr -d '\r\n' || true)
  if [ -n "$BASE" ] && curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1 && curl -fsS --max-time 2 "$BASE/readyz" >/dev/null 2>&1; then return 0; fi
  return 1
}

if [ "$MODE" = status ]; then
  if runtime_status; then RUNNING=true; READY=true; else RUNNING=false; READY=false; fi
  if security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$USER" -w >/dev/null 2>&1; then CRED=true; else CRED=false; fi
  ALIAS_ENV="$ALIAS" TUNNEL_ENV="$TUNNEL_ID" PROFILE_ENV="$PROFILE_PATH" PROXY_ENV="$PROXY" RUNNING_ENV="$RUNNING" READY_ENV="$READY" CRED_ENV="$CRED" CONFIG_ENV="$CONFIG_FILE" "$NODE" -e 'const e=process.env;console.log(JSON.stringify({alias:e.ALIAS_ENV,tunnelId:e.TUNNEL_ENV,profile:e.PROFILE_ENV,runtimeRunning:e.RUNNING_ENV==="true",runtimeReady:e.READY_ENV==="true",credentialPresent:e.CRED_ENV==="true",proxy:e.PROXY_ENV||null,config:e.CONFIG_ENV},null,2))'
  exit 0
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then exit 0; fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

read_key() {
  security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$USER" -w 2>/dev/null || { echo "Codexzxm runtime credential is missing from macOS Keychain service $KEYCHAIN_SERVICE" >&2; exit 1; }
}
repair_profile() {
  mkdir -p "$PROFILE_DIR"
  ALIAS_ENV="$ALIAS" TUNNEL_ENV="$TUNNEL_ID" MCP_ENV="$MCP_COMMAND" HEALTH_ENV="$HEALTH_FILE" PROXY_ENV="$PROXY" PROFILE_ENV="$PROFILE_PATH" "$NODE" -e 'const fs=require("fs");const e=process.env;const p={admin_ui:{open_browser:false},config_version:1,control_plane:{api_key:"env:OPENAI_API_KEY",base_url:"https://api.openai.com",tunnel_id:e.TUNNEL_ENV},health:{listen_addr:"127.0.0.1:0",url_file:e.HEALTH_ENV},log:{format:"json",level:"info"},mcp:{commands:[{channel:"main",command:e.MCP_ENV}]}};if(e.PROXY_ENV)p.http_proxy=e.PROXY_ENV;fs.writeFileSync(e.PROFILE_ENV,JSON.stringify(p,null,2)+"\n")'
}
ensure_runtime() {
  if [ "$FORCE" -eq 1 ] && runtime_status; then "$TUNNEL_CLIENT" runtimes stop "$ALIAS" --json >/dev/null 2>&1 || true; sleep 1; fi
  if [ "$FORCE" -eq 0 ] && runtime_status; then return 0; fi
  KEY=$(read_key)
  export OPENAI_API_KEY="$KEY"
  if [ -n "$PROXY" ]; then export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" NO_PROXY='127.0.0.1,localhost'; fi
  [ -n "$DEFAULT_CWD" ] && export CODEXZXM_DEFAULT_CWD="$DEFAULT_CWD"
  [ -n "$PERMISSION_PROFILE" ] && export CODEXZXM_PROFILE="$PERMISSION_PROFILE"
  if "$TUNNEL_CLIENT" runtimes connect --alias "$ALIAS" --tunnel-id "$TUNNEL_ID" --runtime-api-key env:OPENAI_API_KEY --profile "$PROFILE_NAME" --profile-dir "$PROFILE_DIR" --mcp-command "$MCP_COMMAND" --json >/dev/null 2>>"$LOG_FILE"; then
    repair_profile
  else
    log "runtimes connect failed"
  fi
  unset OPENAI_API_KEY CODEXZXM_DEFAULT_CWD CODEXZXM_PROFILE
  KEY=''
  sleep 2
  runtime_status
}

log "supervisor started"
while :; do
  if ensure_runtime; then log "runtime ready"; else log "runtime not ready"; fi
  [ "$MODE" = once ] && break
  sleep "$INTERVAL"
done
