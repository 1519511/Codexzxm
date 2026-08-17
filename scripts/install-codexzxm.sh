#!/bin/sh
set -eu

SOURCE_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
INSTALL_DIR=${CODEXZXM_INSTALL_DIR:-"$HOME/Library/Application Support/Codexzxm/app"}
CACHE_DIR=${CODEXZXM_NPM_CACHE:-"$HOME/Library/Caches/Codexzxm/npm"}
JSON=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) [ "$#" -ge 2 ] || { echo "--install-dir requires a path" >&2; exit 2; }; INSTALL_DIR=$2; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) echo "Usage: sh scripts/install-codexzxm.sh [--install-dir <path>] [--json]"; exit 0 ;;
    *) echo "Unknown installer argument: $1" >&2; exit 2 ;;
  esac
done

case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
PARENT_DIR=$(dirname "$INSTALL_DIR")
STAGE_DIR=""
BACKUP_DIR=""
INSTALLED=0

fail() {
  message=$1
  [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ] && rm -rf "$STAGE_DIR"
  if [ "$INSTALLED" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then rm -rf "$INSTALL_DIR"; INSTALLED=0; fi
  if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && [ ! -e "$INSTALL_DIR" ]; then mv "$BACKUP_DIR" "$INSTALL_DIR"; BACKUP_DIR=""; fi
  if [ "$JSON" -eq 1 ] && command -v node >/dev/null 2>&1; then MESSAGE="$message" node -e 'console.log(JSON.stringify({ok:false,error:process.env.MESSAGE}))'; else echo "Codexzxm install failed: $message" >&2; fi
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Codexzxm macOS installer requires macOS."
[ "$(uname -m)" = "arm64" ] || fail "Codexzxm currently requires Apple Silicon arm64 on macOS."
NODE=$(command -v node 2>/dev/null || true)
NPM=$(command -v npm 2>/dev/null || true)
[ -n "$NODE" ] || fail "Node.js was not found on PATH."
[ -n "$NPM" ] || fail "npm was not found on PATH."
NODE_VERSION=$($NODE -p 'process.versions.node' 2>/dev/null || true)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "Codexzxm requires Node.js 22+. Current: v$NODE_VERSION"

CODEX_JSON=$($NODE "$SOURCE_ROOT/scripts/resolve-codex.mjs" 2>/dev/null || true)
[ -n "$CODEX_JSON" ] || fail "Codex prerequisite check returned no result."
CODEX_OK=$(printf '%s' "$CODEX_JSON" | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(s).ok)))' 2>/dev/null || true)
[ "$CODEX_OK" = "true" ] || fail "Codex prerequisite check failed: $CODEX_JSON"
CODEX_BIN_RESOLVED=$(printf '%s' "$CODEX_JSON" | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).path||""))')

mkdir -p "$PARENT_DIR" "$CACHE_DIR"
STAGE_DIR=$(mktemp -d "$PARENT_DIR/.Codexzxm-stage.XXXXXX") || fail "Unable to create staging directory."
for entry in src config scripts bin package.json README.md README.zh-CN.md SECURITY.md THIRD_PARTY_NOTICES.md LICENSE; do
  [ -e "$SOURCE_ROOT/$entry" ] || fail "Release source is missing: $entry"
  cp -R "$SOURCE_ROOT/$entry" "$STAGE_DIR/$entry" || fail "Failed to stage: $entry"
done
if [ -f "$SOURCE_ROOT/npm-shrinkwrap.json" ]; then cp "$SOURCE_ROOT/npm-shrinkwrap.json" "$STAGE_DIR/npm-shrinkwrap.json"; elif [ -f "$SOURCE_ROOT/package-lock.json" ]; then cp "$SOURCE_ROOT/package-lock.json" "$STAGE_DIR/package-lock.json"; else fail "Frozen npm lockfile is missing."; fi

chmod +x "$STAGE_DIR/scripts/install-codexzxm.sh" "$STAGE_DIR/scripts/uninstall-codexzxm.sh" "$STAGE_DIR/scripts/codexzxm-tunnel-supervisor.sh" "$STAGE_DIR/scripts/enable-codexzxm-autostart.sh" "$STAGE_DIR/scripts/disable-codexzxm-autostart.sh" "$STAGE_DIR/scripts/codexzxm-secret-set.sh" "$STAGE_DIR/bin/codexzxm-install.sh" "$STAGE_DIR/bin/codexzxm-doctor.sh" "$STAGE_DIR/bin/codexzxm-http.sh" "$STAGE_DIR/bin/codexzxm-stdio.sh" "$STAGE_DIR/bin/codexzxm-uninstall.sh" || fail "Failed to mark scripts executable."

(cd "$STAGE_DIR" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --cache "$CACHE_DIR" 1>&2) || fail "npm production dependency install failed."
(cd "$STAGE_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" "$NODE" scripts/doctor.mjs --json >/dev/null) || fail "Staging doctor failed."
IDENTITY=$(cd "$STAGE_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" CODEXZXM_PRIVATE_WORKBENCH=1 "$NODE" -e 'import("./src/surface-contracts.mjs").then(m=>console.log(JSON.stringify({surface:m.PRIVATE_WORKBENCH_SURFACE_VERSION,tools:m.PUBLIC_TOOL_NAMES.length+m.PRIVATE_WORKBENCH_TOOL_NAMES.length})))') || fail "Surface identity check failed."

if [ -e "$INSTALL_DIR" ]; then
  [ -f "$INSTALL_DIR/package.json" ] || fail "Refusing to replace a directory without package.json: $INSTALL_DIR"
  EXISTING_NAME=$($NODE -e 'const p=require(process.argv[1]);process.stdout.write(String(p.name||""))' "$INSTALL_DIR/package.json" 2>/dev/null || true)
  [ "$EXISTING_NAME" = "codexzxm" ] || fail "Refusing to replace non-Codexzxm package '$EXISTING_NAME'."
  BACKUP_DIR="$PARENT_DIR/.Codexzxm-backup.$$"
  [ ! -e "$BACKUP_DIR" ] || fail "Backup path already exists: $BACKUP_DIR"
  mv "$INSTALL_DIR" "$BACKUP_DIR" || fail "Unable to move current install to backup."
fi

mv "$STAGE_DIR" "$INSTALL_DIR" || fail "Unable to activate staged install."
STAGE_DIR=""; INSTALLED=1
(cd "$INSTALL_DIR" && CODEX_BIN="$CODEX_BIN_RESOLVED" "$NODE" scripts/doctor.mjs --json >/dev/null) || fail "Installed doctor failed."
[ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && rm -rf "$BACKUP_DIR"
BACKUP_DIR=""; INSTALLED=0
VERSION=$($NODE -e 'const p=require(process.argv[1]);process.stdout.write(String(p.version))' "$INSTALL_DIR/package.json")

if [ "$JSON" -eq 1 ]; then
  INSTALL_DIR="$INSTALL_DIR" VERSION="$VERSION" IDENTITY="$IDENTITY" "$NODE" -e 'console.log(JSON.stringify({ok:true,name:"Codexzxm",version:process.env.VERSION,installDir:process.env.INSTALL_DIR,identity:JSON.parse(process.env.IDENTITY),stdio:process.env.INSTALL_DIR+"/bin/codexzxm-stdio.sh"}))'
else
  echo "Codexzxm installed: $VERSION"
  echo "Location: $INSTALL_DIR"
  echo "Surface: $IDENTITY"
  echo "Next: configure a Mac-specific Secure MCP Tunnel with scripts/enable-codexzxm-autostart.sh"
fi
