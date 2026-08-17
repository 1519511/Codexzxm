#!/bin/sh
set -eu
KEEP_KEYCHAIN=0
KEEP_CONFIG=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-keychain) KEEP_KEYCHAIN=1; shift ;;
    --keep-config) KEEP_CONFIG=1; shift ;;
    -h|--help) echo "Usage: disable-codexzxm-autostart.sh [--keep-keychain] [--keep-config]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
STATE_ROOT=${CODEXZXM_STATE_ROOT:-"$HOME/.config/codexzxm"}
CONFIG_FILE="$STATE_ROOT/tunnel-macos.json"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.codexzxm.tunnel.plist"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/com.codexzxm.tunnel" >/dev/null 2>&1 || true
rm -f "$LAUNCH_AGENT"
if [ "$KEEP_KEYCHAIN" -eq 0 ]; then security delete-generic-password -s com.codexzxm.openai-runtime -a "$USER" >/dev/null 2>&1 || true; fi
if [ "$KEEP_CONFIG" -eq 0 ]; then rm -f "$CONFIG_FILE"; fi
echo "Codexzxm macOS LaunchAgent removed."
[ "$KEEP_KEYCHAIN" -eq 1 ] && echo "Keychain runtime credential retained." || echo "Keychain runtime credential removed."
[ "$KEEP_CONFIG" -eq 1 ] && echo "Tunnel configuration retained." || echo "Tunnel configuration removed."
