import assert from "node:assert/strict";
import { acceptedCodexVersionsFor, acceptedCodexVersionsFromEnv, isCodexVersionAccepted } from "../src/codex-version-policy.mjs";

const windowsBase = acceptedCodexVersionsFor({ platform: "win32", arch: "x64" });
assert.deepEqual([...windowsBase], ["0.147.0", "0.147.0-alpha.6.6"]);
assert.equal(isCodexVersionAccepted("0.147.0", { acceptedVersions: windowsBase, platform: "win32", arch: "x64" }), true);
assert.equal(isCodexVersionAccepted("0.147.1", { acceptedVersions: windowsBase, platform: "win32", arch: "x64" }), true);
assert.equal(isCodexVersionAccepted("0.147.99", { acceptedVersions: windowsBase, platform: "win32", arch: "x64" }), true);
assert.equal(isCodexVersionAccepted("0.147.1-alpha.1", { acceptedVersions: windowsBase, platform: "win32", arch: "x64" }), false);
assert.equal(isCodexVersionAccepted("0.148.0", { acceptedVersions: windowsBase, platform: "win32", arch: "x64" }), false);
assert.equal(isCodexVersionAccepted("1.147.0", { acceptedVersions: windowsBase, platform: "win32", arch: "x64" }), false);

const withExtra = acceptedCodexVersionsFromEnv({ env: { CODEXZXM_EXTRA_CODEX_VERSIONS: "0.148.0, 0.149.0-alpha.1" }, platform: "win32", arch: "x64" });
assert.equal(withExtra.includes("0.148.0"), true);
assert.equal(withExtra.includes("0.149.0-alpha.1"), true);
assert.equal(isCodexVersionAccepted("0.148.0", { acceptedVersions: withExtra, platform: "win32", arch: "x64" }), true);
assert.equal(isCodexVersionAccepted("0.149.0-alpha.1", { acceptedVersions: withExtra, platform: "win32", arch: "x64" }), true);

const macBase = acceptedCodexVersionsFor({ platform: "darwin", arch: "arm64" });
assert.deepEqual([...macBase], ["0.148.0-alpha.9"]);
assert.equal(isCodexVersionAccepted("0.148.0-alpha.9", { acceptedVersions: macBase, platform: "darwin", arch: "arm64" }), true);
assert.equal(isCodexVersionAccepted("0.148.0", { acceptedVersions: macBase, platform: "darwin", arch: "arm64" }), false);

console.log("Codex version policy contract passed");
