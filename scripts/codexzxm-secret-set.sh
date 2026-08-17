#!/bin/sh
set -eu
ALIAS=${1:-}
DESCRIPTION=${2:-}
case "$ALIAS" in ''|*[!A-Za-z0-9._-]* ) echo "Usage: $0 <alias> [description]" >&2; exit 2 ;; esac
[ "$(uname -s)" = Darwin ] || { echo "macOS is required." >&2; exit 1; }
STATE_ROOT=${CODEXZXM_SECRET_STATE_DIR:-"$HOME/.config/codexzxm/secrets-v1"}
INDEX_FILE="$STATE_ROOT/index.json"
SERVICE="com.codexzxm.secret.$ALIAS"
mkdir -p "$STATE_ROOT"
printf 'Secret value for %s: ' "$ALIAS" >&2
stty -echo
IFS= read -r VALUE
stty echo
printf '\n' >&2
[ -n "$VALUE" ] || { echo "Secret value cannot be empty." >&2; exit 1; }
security add-generic-password -U -s "$SERVICE" -a "$USER" -w "$VALUE" >/dev/null
VALUE=''
node - "$INDEX_FILE" "$ALIAS" "$DESCRIPTION" "$SERVICE" "$USER" <<'NODE'
const fs=require('fs');
const [file,alias,description,service,account]=process.argv.slice(2);
let index={version:1,secrets:[]};
try{index=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(index.version!==1||!Array.isArray(index.secrets))throw new Error('Secret index is corrupt');
const now=new Date().toISOString();
const old=index.secrets.find(x=>x.alias===alias);
index.secrets=index.secrets.filter(x=>x.alias!==alias);
index.secrets.push({alias,provider:'macos-keychain',description,createdAt:old?.createdAt??now,updatedAt:now,locator:{service,account}});
fs.writeFileSync(file,JSON.stringify(index,null,2)+'\n',{mode:0o600});
NODE
chmod 600 "$INDEX_FILE"
echo "Stored permanent secretRef '$ALIAS' in macOS Keychain."
echo "Metadata index: $INDEX_FILE"
