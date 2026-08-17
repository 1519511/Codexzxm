import assert from "node:assert/strict";
import http from "node:http";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { ACCEPTED_CODEX_VERSIONS } from "../src/codex-authority-executor.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { PRIVATE_WORKBENCH_SURFACE_VERSION, PRIVATE_WORKBENCH_TOOL_NAMES, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
const codexBin = (await resolveCodexExecutable({ acceptedVersions: ACCEPTED_CODEX_VERSIONS })).path;
const probePath = path.join(projectRoot, "test", ".workbench-v1-probe.txt");
const workspaceStateDir = path.join(projectRoot, "test", ".workbench-contract-v5-state");
const processStateDir = path.join(projectRoot, "test", ".workbench-contract-process-state");
const browserHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Workbench Browser V2 Test</title></head>
<body>
  <h1>Workbench Browser V2 Test</h1>
  <label>Name <input aria-label="Name" id="name"></label>
  <label>Mode <select aria-label="Mode" id="mode"><option value="alpha">Alpha</option><option value="beta">Beta</option></select></label>
  <button id="greet">Greet</button>
  <div data-testid="result" id="result">Ready</div>
  <script>
    console.log('V2_PAGE_READY');
    document.getElementById('greet').addEventListener('click', () => {
      const value = document.getElementById('name').value;
      const mode = document.getElementById('mode').value;
      document.getElementById('result').textContent = 'Hello ' + value + ' ' + mode;
      console.log('V2_GREETING:' + value + ':' + mode);
    });
  </script>
</body></html>`;
const browserTestServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(browserHtml);
});
await new Promise((resolve, reject) => {
  browserTestServer.once("error", reject);
  browserTestServer.listen(0, "127.0.0.1", resolve);
});
const browserAddress = browserTestServer.address();
if (!browserAddress || typeof browserAddress === "string") throw new Error("browser test server did not expose a TCP address");
const browserTestUrl = `http://127.0.0.1:${browserAddress.port}/`;
let browserTabRef = null;

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("CODEXLESS_") || key.startsWith("CODEXZXM_")) delete env[key];
}
Object.assign(env, {
  CODEX_BIN: codexBin,
  CODEXLESS_DEFAULT_CWD: projectRoot,
  CODEXLESS_PROFILE: ":danger-full-access",
  CODEXLESS_PRIVATE_WORKBENCH: "1",
  CODEXLESS_PRIVATE_MCP_ALLOWLIST: "*",
  CODEXLESS_PRIVATE_MCP_ALLOW_CODEX_APPS: "1",
  CODEXLESS_WORKSPACE_STATE_DIR: workspaceStateDir,
  CODEXLESS_PROCESS_STATE_DIR: processStateDir,
});

await rm(probePath, { force: true }).catch(() => {});
await rm(workspaceStateDir, { recursive: true, force: true }).catch(() => {});
await rm(processStateDir, { recursive: true, force: true }).catch(() => {});

const client = new Client({ name: "codexzxm-private-contract", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-stdio.mjs")],
  cwd: projectRoot,
  env,
  stderr: "pipe",
});
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[workbench] ${chunk}`));

await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.equal(PRIVATE_WORKBENCH_SURFACE_VERSION, "codexzxm-private-v5.2");
  assert.equal(names.length, PUBLIC_TOOL_NAMES.length + PRIVATE_WORKBENCH_TOOL_NAMES.length);
  for (const name of PUBLIC_TOOL_NAMES) assert.equal(names.includes(name), true, `missing public tool ${name}`);
  for (const name of PRIVATE_WORKBENCH_TOOL_NAMES) assert.equal(names.includes(name), true, `missing private Workbench tool ${name}`);

  const workspaceCreated = await client.callTool({
    name: "workbench.workspace_create",
    arguments: { name: "Contract Workspace", cwd: projectRoot },
  });
  assert.equal(workspaceCreated.isError, false);
  const workspaceRef = workspaceCreated.structuredContent?.workspaceRef;
  assert.match(workspaceRef ?? "", /^workspace_/);

  const workspaceTask = await client.callTool({
    name: "workbench.workspace_task_upsert",
    arguments: { workspaceRef, title: "V5 contract task", status: "doing", details: "persistent integration" },
  });
  assert.equal(workspaceTask.isError, false);
  assert.match(workspaceTask.structuredContent?.taskId ?? "", /^task_/);

  const workspaceLog = await client.callTool({
    name: "workbench.workspace_log_append",
    arguments: { workspaceRef, kind: "contract", message: "V5 MCP integration", metadata: { version: 5 } },
  });
  assert.equal(workspaceLog.isError, false);
  assert.match(workspaceLog.structuredContent?.logId ?? "", /^log_/);

  const workspaceInspect = await client.callTool({ name: "workbench.workspace_inspect", arguments: { workspaceRef } });
  assert.equal(workspaceInspect.isError, false);
  assert.equal(workspaceInspect.structuredContent?.tasks?.some((task) => task.title === "V5 contract task"), true);
  assert.equal(Array.isArray(workspaceInspect.structuredContent?.changedFiles?.files), true);

  const mcpServers = await client.callTool({ name: "workbench.mcp_servers", arguments: { limit: 100 } });
  assert.equal(mcpServers.isError, false);
  const codexAppsServer = mcpServers.structuredContent?.servers?.find((server) => server.name === "codex_apps");
  const nodeReplServer = mcpServers.structuredContent?.servers?.find((server) => server.name === "node_repl");
  assert.equal(codexAppsServer?.callable, true);
  assert.equal(nodeReplServer?.callable, true);

  const mcpAppTools = await client.callTool({
    name: "workbench.mcp_tools",
    arguments: { server: "codex_apps", query: "github.get_repo", limit: 20, includeSchemas: false },
  });
  assert.equal(mcpAppTools.isError, false);
  assert.equal(mcpAppTools.structuredContent?.tools?.some((tool) => tool.name === "github.get_repo" && tool.callable === true), true);

  const mcpDescribe = await client.callTool({
    name: "workbench.mcp_describe",
    arguments: { server: "node_repl", tool: "js" },
  });
  assert.equal(mcpDescribe.isError, false);
  assert.equal(mcpDescribe.structuredContent?.tool?.name, "js");
  assert.equal(mcpDescribe.structuredContent?.callable, true);

  const mcpCall = await client.callTool({
    name: "workbench.mcp_call",
    arguments: {
      server: "node_repl",
      tool: "js",
      arguments: { code: "nodeRepl.write('MCP_HUB_OK')", title: "V3 MCP hub contract" },
      cwd: projectRoot,
      timeoutMs: 30000,
      confirmedSideEffects: false,
    },
  });
  assert.equal(mcpCall.isError, false);
  assert.match(mcpCall.structuredContent?.text ?? "", /MCP_HUB_OK/);

  const browserStatus = await client.callTool({ name: "codex.browser_status", arguments: { cwd: projectRoot } });
  assert.equal(browserStatus.isError, false);
  assert.equal(browserStatus.structuredContent?.status, "ok");

  const browserOpen = await client.callTool({ name: "workbench.browser_open", arguments: { cwd: projectRoot } });
  assert.equal(browserOpen.isError, false);
  browserTabRef = browserOpen.structuredContent?.tab?.tabRef ?? null;
  assert.match(browserTabRef ?? "", /^browser_tab_/);

  const browserNavigate = await client.callTool({
    name: "workbench.browser_navigate",
    arguments: { tabRef: browserTabRef, url: browserTestUrl, cwd: projectRoot, timeoutMs: 15000 },
  });
  assert.equal(browserNavigate.isError, false);
  assert.equal(browserNavigate.structuredContent?.tab?.url?.startsWith(browserTestUrl), true);

  const browserInitialRead = await client.callTool({
    name: "codex.browser_read",
    arguments: { tabRef: browserTabRef, cwd: projectRoot, maxChars: 50000 },
  });
  assert.equal(browserInitialRead.isError, false);
  assert.match(browserInitialRead.structuredContent?.snapshot ?? "", /Workbench Browser V2 Test/);
  assert.match(browserInitialRead.structuredContent?.snapshot ?? "", /Ready/);

  const browserFill = await client.callTool({
    name: "workbench.browser_fill",
    arguments: { tabRef: browserTabRef, locator: { kind: "label", value: "Name", exact: true }, value: "Ada", cwd: projectRoot },
  });
  assert.equal(browserFill.isError, false);

  const browserPress = await client.callTool({
    name: "workbench.browser_press",
    arguments: { tabRef: browserTabRef, locator: { kind: "label", value: "Name", exact: true }, key: "End", cwd: projectRoot },
  });
  assert.equal(browserPress.isError, false);

  const browserSelect = await client.callTool({
    name: "workbench.browser_select",
    arguments: { tabRef: browserTabRef, locator: { kind: "label", value: "Mode", exact: true }, option: "beta", cwd: projectRoot },
  });
  assert.equal(browserSelect.isError, false);

  const browserClick = await client.callTool({
    name: "workbench.browser_click",
    arguments: { tabRef: browserTabRef, locator: { kind: "role", role: "button", name: "Greet", exact: true }, cwd: projectRoot },
  });
  assert.equal(browserClick.isError, false);

  const browserWait = await client.callTool({
    name: "workbench.browser_wait",
    arguments: { tabRef: browserTabRef, kind: "locator", locator: { kind: "testId", value: "result" }, state: "visible", cwd: projectRoot, timeoutMs: 5000 },
  });
  assert.equal(browserWait.isError, false);

  const browserAfterRead = await client.callTool({
    name: "codex.browser_read",
    arguments: { tabRef: browserTabRef, cwd: projectRoot, maxChars: 50000 },
  });
  assert.equal(browserAfterRead.isError, false);
  assert.match(browserAfterRead.structuredContent?.snapshot ?? "", /Hello Ada beta/);

  const browserLogs = await client.callTool({
    name: "workbench.browser_logs",
    arguments: { tabRef: browserTabRef, cwd: projectRoot, filter: "V2_", limit: 50 },
  });
  assert.equal(browserLogs.isError, false);
  assert.equal(Array.isArray(browserLogs.structuredContent?.action?.logs), true);

  const browserScreenshot = await client.callTool({
    name: "workbench.browser_screenshot",
    arguments: { tabRef: browserTabRef, cwd: projectRoot, fullPage: false, maxBytes: 5000000 },
  });
  assert.equal(browserScreenshot.isError, false);
  assert.equal(browserScreenshot.content?.some((item) => item.type === "image" && typeof item.data === "string" && item.data.length > 100), true);
  assert.equal((browserScreenshot.structuredContent?.action?.byteLength ?? 0) > 0, true);
  assert.equal(Object.hasOwn(browserScreenshot.structuredContent?.action ?? {}, "base64"), false);

  const browserReload = await client.callTool({
    name: "workbench.browser_reload",
    arguments: { tabRef: browserTabRef, cwd: projectRoot, timeoutMs: 15000 },
  });
  assert.equal(browserReload.isError, false);
  const browserReloadRead = await client.callTool({
    name: "codex.browser_read",
    arguments: { tabRef: browserTabRef, cwd: projectRoot, maxChars: 50000 },
  });
  assert.equal(browserReloadRead.isError, false);
  assert.match(browserReloadRead.structuredContent?.snapshot ?? "", /Ready/);

  const browserClose = await client.callTool({ name: "workbench.browser_close", arguments: { tabRef: browserTabRef, cwd: projectRoot } });
  assert.equal(browserClose.isError, false);
  browserTabRef = null;

  const listed = await client.callTool({ name: "workbench.fs_list", arguments: { path: ".", cwd: projectRoot } });
  assert.equal(listed.isError, false);
  assert.equal(Array.isArray(listed.structuredContent?.entries), true);

  const searched = await client.callTool({ name: "workbench.project_search", arguments: { query: "Codexzxm", cwd: projectRoot, maxMatches: 5 } });
  assert.equal(searched.isError, false);
  assert.equal(Array.isArray(searched.structuredContent?.matches), true);

  const gitStatus = await client.callTool({ name: "workbench.git_status", arguments: { cwd: projectRoot } });
  assert.equal(gitStatus.isError, false);
  assert.match(gitStatus.structuredContent?.stdout ?? "", /hardening\/v1|workbench\/v5-persistent-workspace|workbench\/v4-computer-use|workbench\/v3-mcp-hub|workbench\/v2-browser|workbench\/v1|main/);

  const started = await client.callTool({
    name: "workbench.process_start",
    arguments: {
      command: [process.execPath, "-e", "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('MCP-ECHO:'+d));setInterval(()=>{},1000)"],
      cwd: projectRoot,
      label: "mcp-contract-echo",
    },
  });
  assert.equal(started.isError, false);
  const processRef = started.structuredContent?.processRef;
  assert.match(processRef ?? "", /^proc_/);

  const sent = await client.callTool({
    name: "workbench.process_send",
    arguments: { processRef, text: "ping", appendNewline: true },
  });
  assert.equal(sent.isError, false);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const processOutput = await client.callTool({
    name: "workbench.process_read",
    arguments: { processRef, afterSeq: 0, maxChars: 50000 },
  });
  assert.equal(processOutput.isError, false);
  assert.equal(processOutput.structuredContent?.events?.some((event) => event.stream === "stdout" && event.text.includes("MCP-ECHO:ping")), true);

  const stopped = await client.callTool({
    name: "workbench.process_stop",
    arguments: { processRef, force: true },
  });
  assert.equal(stopped.isError, false);
  assert.equal(stopped.structuredContent?.stopRequested, true);

  const created = await client.callTool({ name: "workbench.fs_create", arguments: { path: "test/.workbench-v1-probe.txt", content: "alpha\n", cwd: projectRoot } });
  assert.equal(created.isError, false);
  const createdSha = created.structuredContent?.sha256;
  assert.match(createdSha ?? "", /^[0-9a-f]{64}$/);

  const written = await client.callTool({ name: "workbench.fs_write", arguments: { path: "test/.workbench-v1-probe.txt", content: "beta\n", expectedSha256: createdSha, cwd: projectRoot } });
  assert.equal(written.isError, false);
  const writtenSha = written.structuredContent?.afterSha256;
  assert.match(writtenSha ?? "", /^[0-9a-f]{64}$/);

  const readBack = await client.callTool({ name: "workbench.fs_read", arguments: { path: "test/.workbench-v1-probe.txt", cwd: projectRoot } });
  assert.equal(readBack.isError, false);
  assert.equal(readBack.structuredContent?.text, "beta\n");

  const deleted = await client.callTool({ name: "workbench.fs_delete", arguments: { path: "test/.workbench-v1-probe.txt", expectedSha256: writtenSha, cwd: projectRoot } });
  assert.equal(deleted.isError, false);
} finally {
  if (browserTabRef) {
    await client.callTool({ name: "workbench.browser_close", arguments: { tabRef: browserTabRef, cwd: projectRoot } }).catch(() => {});
  }
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  await rm(probePath, { force: true }).catch(() => {});
  await rm(workspaceStateDir, { recursive: true, force: true }).catch(() => {});
  await rm(processStateDir, { recursive: true, force: true }).catch(() => {});
  browserTestServer.closeAllConnections?.();
  await new Promise((resolve) => browserTestServer.close(() => resolve()));
}
