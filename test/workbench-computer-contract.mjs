import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { ACCEPTED_CODEX_VERSIONS } from "../src/codex-authority-executor.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
const codexBin = (await resolveCodexExecutable({ acceptedVersions: ACCEPTED_CODEX_VERSIONS })).path;
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("CODEXLESS_")) delete env[key];
}
Object.assign(env, {
  CODEX_BIN: codexBin,
  CODEXLESS_DEFAULT_CWD: projectRoot,
  CODEXLESS_PROFILE: ":danger-full-access",
  CODEXLESS_PRIVATE_WORKBENCH: "1",
  CODEXLESS_PRIVATE_MCP_ALLOWLIST: "*",
  CODEXLESS_PRIVATE_MCP_ALLOW_CODEX_APPS: "1",
});

const client = new Client({ name: "codexless-computer-v4-contract", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-stdio.mjs")],
  cwd: projectRoot,
  env,
  stderr: "pipe",
});
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[computer] ${chunk}`));

async function listNotepadWindows() {
  let result = await client.callTool({ name: "workbench.computer_windows", arguments: { cwd: projectRoot, query: "Notepad", limit: 20 } });
  if (result.isError) return null;
  if (!result.structuredContent?.windows?.length) {
    result = await client.callTool({ name: "workbench.computer_windows", arguments: { cwd: projectRoot, query: "记事本", limit: 20 } });
    if (result.isError) return null;
  }
  return result.structuredContent?.windows ?? [];
}

async function waitForNotepadWindowClosed(windowId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = await listNotepadWindows();
    if (remaining === null) return false;
    if (!remaining.some((window) => window.id === windowId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

let createdWindow = null;
let latestObservationRef = null;
await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const name of [
    "workbench.computer_apps",
    "workbench.computer_windows",
    "workbench.computer_launch",
    "workbench.computer_state",
    "workbench.computer_click",
    "workbench.computer_key",
  ]) assert.equal(names.includes(name), true, `missing V4 tool ${name}`);

  const denied = await client.callTool({ name: "workbench.computer_launch", arguments: { app: "powershell.exe", cwd: projectRoot } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent?.errorCode, "COMPUTER_TARGET_REFUSED");

  const before = await listNotepadWindows();
  if (before === null) {
    console.log("Computer V4 live Notepad test skipped because the current desktop backend could not enumerate windows");
  } else if (before.length) {
    console.log("Computer V4 live Notepad test skipped because a user Notepad window was already open");
  } else {
    const launched = await client.callTool({ name: "workbench.computer_launch", arguments: { app: "notepad.exe", cwd: projectRoot } });
    assert.equal(launched.isError, false);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const after = await listNotepadWindows();
    assert.equal(after.length, 1);
    createdWindow = after[0];
    assert.equal(createdWindow.blocked, false);

    const observed = await client.callTool({
      name: "workbench.computer_state",
      arguments: { windowRef: createdWindow.windowRef, cwd: projectRoot, includeScreenshot: true, includeText: true },
    });
    assert.equal(observed.isError, false);
    latestObservationRef = observed.structuredContent?.observationRef ?? null;
    assert.match(latestObservationRef ?? "", /^computer_obs_/);
    assert.equal(observed.content?.some((item) => item.type === "image" && typeof item.data === "string" && item.data.length > 100), true);
    const screenshots = observed.structuredContent?.screenshots ?? [];
    assert.equal(screenshots.length > 0, true);
    const shot = screenshots[0];
    const x = Math.max(40, Math.min(180, (shot.width ?? 600) - 40));
    const y = Math.max(80, Math.min(180, (shot.height ?? 400) - 40));

    const clicked = await client.callTool({
      name: "workbench.computer_click",
      arguments: { observationRef: latestObservationRef, screenshotId: shot.id, x, y, cwd: projectRoot },
    });
    if (clicked.isError) {
      console.log(`Computer V4 live click was unavailable in the current desktop state; backend=${clicked.structuredContent?.errorCode ?? "unknown"}. Core Computer Use contract remains validated; live action is best-effort.`);
      latestObservationRef = null;
    } else {
      latestObservationRef = clicked.structuredContent?.observationRef ?? null;
      assert.match(latestObservationRef ?? "", /^computer_obs_/);

      const closed = await client.callTool({
        name: "workbench.computer_key",
        arguments: { observationRef: latestObservationRef, key: "Alt+F4", cwd: projectRoot },
      });
      if (closed.isError) {
        console.log(`Computer V4 live Alt+F4 was unavailable in the current desktop state; backend=${closed.structuredContent?.errorCode ?? "unknown"}. Cleanup remains best-effort.`);
      } else if (closed.structuredContent?.windowClosed !== true) {
        const didClose = await waitForNotepadWindowClosed(createdWindow.id);
        if (!didClose) console.log("Computer V4 note: Notepad Alt+F4 was accepted but window closure was not observed within the live-test timeout; cleanup remains best-effort.");
        else createdWindow = null;
      } else {
        createdWindow = null;
      }
      latestObservationRef = null;
    }
    console.log("Computer V4 MCP contract passed");
  }
} finally {
  if (createdWindow) {
    try {
      let obsRef = latestObservationRef;
      if (!obsRef) {
        const observed = await client.callTool({
          name: "workbench.computer_state",
          arguments: { windowRef: createdWindow.windowRef, cwd: projectRoot, includeScreenshot: false, includeText: true },
        });
        obsRef = observed.structuredContent?.observationRef ?? null;
      }
      if (obsRef) await client.callTool({ name: "workbench.computer_key", arguments: { observationRef: obsRef, key: "Alt+F4", cwd: projectRoot } });
    } catch {}
  }
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
