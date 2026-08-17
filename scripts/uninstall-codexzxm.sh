#!/bin/sh
set -eu
INSTALL_DIR=${CODEXZXM_INSTALL_DIR:-"$HOME/Library/Application Support/Codexzxm/app"}
PURGE_STATE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR=$2; shift 2 ;;
    --purge-state) PURGE_STATE=1; shift ;;
    -h|--help) echo "Usage: sh scripts/uninstall-codexzxm.sh [--install-dir <path>] [--purge-state]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
if [ ! -e "$INSTALL_DIR" ]; then echo "Codexzxm is already absent: $INSTALL_DIR"; exit 0; fi
[ -f "$INSTALL_DIR/package.json" ] || { echo "Refusing to remove directory without package.json: $INSTALL_DIR" >&2; exit 1; }
NAME=$(node -e 'const p=require(process.argv[1]);process.stdout.write(String(p.name||""))' "$INSTALL_DIR/package.json")
[ "$NAME" = "codexzxm" ] || { echo "Refusing to remove non-Codexzxm package '$NAME'." >&2; exit 1; }
if [ -x "$INSTALL_DIR/scripts/disable-codexzxm-autostart.sh" ]; then "$INSTALL_DIR/scripts/disable-codexzxm-autostart.sh" --keep-keychain --keep-config >/dev/null 2>&1 || true; fi
cd /private/tmp
rm -rf "$INSTALL_DIR"
echo "Codexzxm removed: $INSTALL_DIR"
if [ "$PURGE_STATE" -eq 1 ]; then
  security delete-generic-password -s com.codexzxm.openai-runtime -a "$USER" >/dev/null 2>&1 || true
  rm -rf "$HOME/.config/codexzxm"
  echo "Codexzxm state and Keychain runtime credential purged."
else
  echo "Codexzxm state and Keychain runtime credential preserved."
fi
