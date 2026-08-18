import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const server = await readFile(path.join(root, "scripts", "codexzxm-ephemeral-share-server.mjs"), "utf8");
const wrapper = await readFile(path.join(root, "scripts", "codexzxm-heygen-share.ps1"), "utf8");

assert.match(server, /server\.listen\(0, "127\.0\.0\.1"/);
assert.match(server, /crypto\.randomBytes\(24\)/);
assert.match(server, /Accept-Ranges/);
assert.match(server, /Content-Range/);
assert.match(server, /statusCode = 206/);
assert.match(server, /Cache-Control/);
assert.match(server, /no-store/);
assert.doesNotMatch(server, /readdir|directory listing/i);

assert.match(wrapper, /ValidateSet\('Start','Status','Stop'\)/);
assert.match(wrapper, /ValidateRange\(1,120\)/);
assert.match(wrapper, /trycloudflare\\\.com/);
assert.match(wrapper, /--no-autoupdate/);
assert.match(wrapper, /127\.0\.0\.1/);
assert.match(wrapper, /LeaseMinutes/);
assert.match(wrapper, /Anyone with an unguessable URL can fetch the asset until this share is stopped or expires/);
assert.match(wrapper, /cloudflaredPid\) -Force/);
assert.match(wrapper, /serverPid\) -Force/);

console.log("Windows HeyGen ephemeral HTTPS share contract passed");
