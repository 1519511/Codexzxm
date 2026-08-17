#!/bin/sh
set -eu

ALIAS=codexzxm-mac
TUNNEL_ID=""
PROFILE_NAME=""
PROFILE_DIR=""
MCP_COMMAND=""
PROXY=""
DEFAULT_CWD="$HOME"
PERMISSION_PROFILE=':danger-full-access'
TUNNEL_CLIENT=""
NO_START=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --alias) ALIAS=$2; shift 2 ;;
    --tunnel-id) TUNNEL_ID=$2; shift 2 ;;
    --profile-name) PROFILE_NAME=$2; shift 2 ;;
    --profile-dir) PROFILE_DIR=$2; shift 2 ;;
    --mcp-command) MCP_COMMAND=$2; shift 2 ;;
    --proxy) PROXY=$2; shift 2 ;;
    --default-cwd) DEFAULT_CWD=$2; shift 2 ;;
    --permission-profile) PERMISSION_PROFILE=$2; shift 2 ;;
    --tunnel-client) TUNNEL_CLIENT=$2; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) echo "Usage: enable-codexzxm-autostart.sh [--alias codexzxm-mac] [--tunnel-id tunnel_...] [--tunnel-client path] [--proxy url] [--default-cwd path] [--permission-profile profile] [--no-start]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Apple Silicon macOS is required." >&2; exit 1; }
[ -n "${OPENAI_API_KEY:-}" ] || { echo "OPENAI_API_KEY is not set in this shell." >&2; exit 1; }
case "$OPENAI_API_KEY" in sk-*) ;; *) echo "OPENAI_API_KEY does not look like an OpenAI API key." >&2; exit 1 ;; esac
NODE=$(command -v node 2>/dev/null || true); [ -n "$NODE" ] || { echo "Node.js is required." >&2; exit 1; }
INSTALL_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
STATE_ROOT=${CODEXZXM_STATE_ROOT:-"$HOME/.config/codexzxm"}
CONFIG_FILE="$STATE_ROOT/tunnel-macos.json"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.codexzxm.tunnel.plist"
KEYCHAIN_SERVICE=com.codexzxm.openai-runtime
mkdir -p "$STATE_ROOT" "$HOME/Library/LaunchAgents"

existing() {
  [ -f "$CONFIG_FILE" ] || return 0
  "$NODE" -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=c[process.argv[2]];if(v!==undefined&&v!==null)process.stdout.write(String(v))' "$CONFIG_FILE" "$1" 2>/dev/null || true
}
[ "$ALIAS" = codexzxm-mac ] && OLD=$(existing alias) && [ -n "$OLD" ] && ALIAS=$OLD || true
[ -z "$PROFILE_NAME" ] && PROFILE_NAME=$(existing profileName) || true; [ -n "$PROFILE_NAME" ] || PROFILE_NAME=$ALIAS
[ -z "$PROFILE_DIR" ] && PROFILE_DIR=$(existing profileDir) || true; [ -n "$PROFILE_DIR" ] || PROFILE_DIR="$STATE_ROOT/tunnel-profiles"
[ -z "$MCP_COMMAND" ] && MCP_COMMAND=$(existing mcpCommand) || true; [ -n "$MCP_COMMAND" ] || MCP_COMMAND="$INSTALL_ROOT/bin/codexzxm-stdio.sh"
[ -z "$PROXY" ] && PROXY=$(existing proxy) || true
[ "$DEFAULT_CWD" = "$HOME" ] && OLD=$(existing defaultCwd) && [ -n "$OLD" ] && DEFAULT_CWD=$OLD || true
[ "$PERMISSION_PROFILE" = ':danger-full-access' ] && OLD=$(existing permissionProfile) && [ -n "$OLD" ] && PERMISSION_PROFILE=$OLD || true
[ -z "$TUNNEL_CLIENT" ] && TUNNEL_CLIENT=$(existing tunnelClient) || true
[ -z "$TUNNEL_CLIENT" ] && TUNNEL_CLIENT=${CODEXZXM_TUNNEL_CLIENT:-} || true
[ -z "$TUNNEL_CLIENT" ] && TUNNEL_CLIENT=$(command -v tunnel-client 2>/dev/null || true)
[ -n "$TUNNEL_CLIENT" ] && [ -x "$TUNNEL_CLIENT" ] || { echo "tunnel-client was not found. Pass --tunnel-client <path> or put it on PATH." >&2; exit 1; }
[ -z "$TUNNEL_ID" ] && TUNNEL_ID=$(existing tunnelId) || true

if [ -z "$TUNNEL_ID" ]; then
  if [ -n "$PROXY" ]; then export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" NO_PROXY='127.0.0.1,localhost'; fi
  LIST=$($TUNNEL_CLIENT runtimes list --json 2>/dev/null || true)
  [ -n "$LIST" ] && TUNNEL_ID=$(printf '%s' "$LIST" | ALIAS_ENV="$ALIAS" "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const j=JSON.parse(s);const r=(j.aliases||[]).find(x=>x.alias===process.env.ALIAS_ENV);if(r?.tunnel_id)process.stdout.write(r.tunnel_id)})' 2>/dev/null || true)
fi
[ -n "$TUNNEL_ID" ] || { echo "No tunnel ID was supplied or discovered for alias '$ALIAS'. Create a Mac-specific workspace-scoped tunnel, then retry with --tunnel-id." >&2; exit 1; }

security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$USER" -w "$OPENAI_API_KEY" >/dev/null
chmod +x "$MCP_COMMAND" "$INSTALL_ROOT/scripts/codexzxm-tunnel-supervisor.sh" 2>/dev/null || true
mkdir -p "$PROFILE_DIR"
ALIAS_ENV="$ALIAS" TUNNEL_ENV="$TUNNEL_ID" PROFILE_ENV="$PROFILE_NAME" PROFILEDIR_ENV="$PROFILE_DIR" MCP_ENV="$MCP_COMMAND" PROXY_ENV="$PROXY" CWD_ENV="$DEFAULT_CWD" PERM_ENV="$PERMISSION_PROFILE" CLIENT_ENV="$TUNNEL_CLIENT" CONFIG_ENV="$CONFIG_FILE" "$NODE" -e 'const fs=require("fs"),e=process.env;const o={version:1,platform:"macos",alias:e.ALIAS_ENV,tunnelId:e.TUNNEL_ENV,profileName:e.PROFILE_ENV,profileDir:e.PROFILEDIR_ENV,mcpCommand:e.MCP_ENV,proxy:e.PROXY_ENV||"",defaultCwd:e.CWD_ENV,permissionProfile:e.PERM_ENV,tunnelClient:e.CLIENT_ENV};fs.writeFileSync(e.CONFIG_ENV,JSON.stringify(o,null,2)+"\n",{mode:0o600})'
chmod 600 "$CONFIG_FILE"

SUPERVISOR="$INSTALL_ROOT/scripts/codexzxm-tunnel-supervisor.sh"
SUPERVISOR_ENV="$SUPERVISOR" OUT_ENV="$STATE_ROOT/supervisor/launchd.out.log" ERR_ENV="$STATE_ROOT/supervisor/launchd.err.log" PLIST_ENV="$LAUNCH_AGENT" "$NODE" -e 'const fs=require("fs"),e=process.env,esc=s=>String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");const p=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.codexzxm.tunnel</string>\n<key>ProgramArguments</key><array><string>/bin/sh</string><string>${esc(e.SUPERVISOR_ENV)}</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${esc(e.OUT_ENV)}</string><key>StandardErrorPath</key><string>${esc(e.ERR_ENV)}</string>\n</dict></plist>\n`;fs.writeFileSync(e.PLIST_ENV,p)'

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/com.codexzxm.tunnel" >/dev/null 2>&1 || true
if [ "$NO_START" -eq 0 ]; then
  /bin/sh "$SUPERVISOR" --once --force-reconnect
  launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENT"
  launchctl enable "$DOMAIN/com.codexzxm.tunnel" >/dev/null 2>&1 || true
fi

echo "Codexzxm macOS tunnel configuration saved: $CONFIG_FILE"
echo "Runtime API key stored in macOS Keychain service: $KEYCHAIN_SERVICE"
echo "LaunchAgent: $LAUNCH_AGENT"
[ "$NO_START" -eq 0 ] && echo "Mac tunnel supervisor launched."
