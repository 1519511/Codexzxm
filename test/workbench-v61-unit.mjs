import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { WorkbenchFsGit } from "../src/workbench-fs-git.mjs";
import { WorkbenchRootRegistry } from "../src/workbench-root-registry.mjs";
import { WorkbenchSecretBroker } from "../src/workbench-secret-broker.mjs";
import { WorkbenchPtyManager } from "../src/workbench-pty.mjs";
import { WorkbenchProBridge } from "../src/workbench-pro-bridge.mjs";
import { WorkbenchWorkflowEngine } from "../src/workbench-workflow.mjs";
import { WorkbenchExecutionManifest, EXECUTION_MANIFEST_PROTOCOL } from "../src/workbench-execution-manifest.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const fixture = path.join(projectRoot, "test", ".workbench-v61-unit");
await rm(fixture, { recursive: true, force: true });
await mkdir(fixture, { recursive: true });

try {
  let authorityReady = true;
  const authorityExecutor = {
    async resolveAuthority({ cwd, access = "inherit" }) {
      if (!authorityReady) throw new Error("authority unavailable");
      return {
        effectiveCwd: path.resolve(cwd),
        trustedAncestor: fixture,
        permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
        permissionCeiling: ":danger-full-access",
        authoritySource: "v61-unit",
      };
    },
    async exec({ command, cwd, access = "readOnly" }) {
      try {
        const result = await execFileAsync(command[0], command.slice(1), { cwd, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
        return { exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", stdoutTruncated: false, stderrTruncated: false, effectiveCwd: path.resolve(cwd), permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access", trustedAncestor: fixture };
      } catch (error) {
        return { exitCode: Number.isInteger(error?.code) ? error.code : 1, stdout: error?.stdout ?? "", stderr: error?.stderr ?? error?.message ?? String(error), stdoutTruncated: false, stderrTruncated: false, effectiveCwd: path.resolve(cwd), permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access", trustedAncestor: fixture };
      }
    },
  };

  const roots = new WorkbenchRootRegistry({ authorityExecutor, stateDir: path.join(fixture, "roots-state"), defaultCwd: fixture });
  const registered = await roots.register({ alias: "fixture", cwd: fixture, description: "V6.1 fixture" });
  assert.equal(registered.permanent, true);
  assert.equal((await roots.status({ alias: "fixture" })).authorityStatus, "ready");
  const resolved = await roots.resolve({ alias: "fixture", path: "subdir" });
  assert.equal(resolved.cwd, path.join(fixture, "subdir"));
  await assert.rejects(roots.resolve({ alias: "fixture", path: "../../escape" }), /escapes registered root/);
  authorityReady = false;
  assert.equal((await roots.status({ alias: "fixture" })).authorityStatus, "unavailable");
  authorityReady = true;

  const fsGit = new WorkbenchFsGit({ authorityExecutor });
  const sourceTree = path.join(fixture, "tree-source");
  await mkdir(path.join(sourceTree, "nested"), { recursive: true });
  await writeFile(path.join(sourceTree, "nested", "a.txt"), "tree-a", "utf8");
  const treeMeta = await fsGit.fsMetadata({ path: sourceTree, cwd: fixture, recursive: true, maxEntries: 100 });
  assert.equal(treeMeta.files, 1);
  const copiedTree = await fsGit.fsCopyTree({ source: sourceTree, destination: path.join(fixture, "tree-copy"), cwd: fixture });
  assert.equal(copiedTree.files, 1);
  const deletePlan = await fsGit.fsDeleteTreePlan({ path: path.join(fixture, "tree-copy"), cwd: fixture, maxEntries: 100 });
  await writeFile(path.join(fixture, "tree-copy", "drift.txt"), "drift", "utf8");
  await assert.rejects(fsGit.fsDeleteTreeCommit({ planRef: deletePlan.planRef, cwd: fixture, confirmedDelete: true }), /contents changed after planning/);
  const deletePlan2 = await fsGit.fsDeleteTreePlan({ path: path.join(fixture, "tree-copy"), cwd: fixture, maxEntries: 100 });
  const deletedTree = await fsGit.fsDeleteTreeCommit({ planRef: deletePlan2.planRef, cwd: fixture, confirmedDelete: true });
  assert.equal(deletedTree.status, "deleted");
  const archiveCreated = await fsGit.fsArchiveCreate({ source: sourceTree, destination: path.join(fixture, "tree-source.tgz"), cwd: fixture, maxBytes: 1024 * 1024 });
  assert.equal(archiveCreated.status, "created");
  const archiveExtracted = await fsGit.fsArchiveExtract({ archive: path.join(fixture, "tree-source.tgz"), destination: path.join(fixture, "tree-extracted"), cwd: fixture, maxEntries: 100, maxBytes: 1024 * 1024 });
  assert.equal(archiveExtracted.status, "extracted");
  assert.equal(await readFile(path.join(fixture, "tree-extracted", "tree-source", "nested", "a.txt"), "utf8"), "tree-a");

  const secretDir = path.join(fixture, "secrets");
  await mkdir(secretDir, { recursive: true });
  await writeFile(path.join(secretDir, "index.json"), JSON.stringify({
    version: 1,
    secrets: [{ alias: "github-main", provider: process.platform === "darwin" ? "macos-keychain" : "windows-dpapi-file", description: "GitHub credential", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", locator: { file: "SHOULD_NOT_LEAK", service: "SHOULD_NOT_LEAK" } }],
  }), "utf8");
  const secrets = new WorkbenchSecretBroker({ stateDir: secretDir });
  const listedSecrets = await secrets.list({});
  assert.equal(listedSecrets.plaintextExposed, false);
  assert.equal(listedSecrets.secrets[0].secretRef, "github-main");
  assert.equal(Object.hasOwn(listedSecrets.secrets[0], "locator"), false);
  assert.equal(JSON.stringify(listedSecrets).includes("SHOULD_NOT_LEAK"), false);

  const ptyState = path.join(fixture, "pty-state");
  const pty = new WorkbenchPtyManager({ authorityExecutor, stateDir: ptyState });
  const shellCommand = process.platform === "win32" ? [process.env.COMSPEC || "cmd.exe", "/Q"] : [process.env.SHELL || "/bin/sh"];
  const session = await pty.start({ command: shellCommand, cwd: fixture, cols: 100, rows: 24, label: "v61-pty" });
  assert.equal(session.state, "running");
  await pty.send({ ptyRef: session.ptyRef, text: "echo PTY_V61", appendNewline: true });
  let sawPty = false;
  for (let i = 0; i < 30 && !sawPty; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const output = await pty.read({ ptyRef: session.ptyRef, afterSeq: 0, maxChars: 50000 });
    sawPty = output.events.some((event) => event.stream === "pty" && event.text.includes("PTY_V61"));
  }
  assert.equal(sawPty, true);
  const resized = await pty.resize({ ptyRef: session.ptyRef, cols: 132, rows: 40 });
  assert.equal(resized.cols, 132);
  await pty.stop({ ptyRef: session.ptyRef, force: true });

  const shortCommand = process.platform === "win32"
    ? [process.env.COMSPEC || "cmd.exe", "/d", "/c", "echo PTY_SHORT_OK"]
    : [process.env.SHELL || "/bin/sh", "-c", "echo PTY_SHORT_OK"];
  const shortSession = await pty.start({ command: shortCommand, cwd: fixture, cols: 80, rows: 20, label: "v61-pty-short" });
  assert.equal(["running", "exited"].includes(shortSession.state), true);
  let shortOutput = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    shortOutput = await pty.read({ ptyRef: shortSession.ptyRef, afterSeq: 0, maxChars: 50000 });
    if (shortOutput.state === "exited" && shortOutput.events.some((event) => event.stream === "pty" && event.text.includes("PTY_SHORT_OK"))) break;
  }
  assert.equal(shortOutput?.state, "exited");
  assert.equal(shortOutput?.events.some((event) => event.stream === "pty" && event.text.includes("PTY_SHORT_OK")), true);

  const browserCalls = [];
  let assistantReady = false;
  const mockBrowser = {
    async openTab() { browserCalls.push("open"); return { tab: { tabRef: "tab_v61", url: "https://chatgpt.com/" } }; },
    async readTab() {
      browserCalls.push("read");
      return { tab: { tabRef: "tab_v61", url: "https://chatgpt.com/c/v61" }, snapshot: '- textbox "与 ChatGPT 聊天"\n- button "Pro"\n- button "发送提示"' };
    },
    async queryTab({ locator }) {
      browserCalls.push(`query:${locator.value ?? locator.name ?? ""}`);
      if (locator.value === '[data-message-author-role="assistant"]') return { action: { matchedCount: assistantReady ? 1 : 0, texts: assistantReady ? ["PRO_RESULT_V61"] : [] } };
      return { action: { matchedCount: 0, texts: [] } };
    },
    async fillTab({ value }) { browserCalls.push(`fill:${value.includes("CODEXZXM PRO BRIDGE")}`); return { action: { filled: true } }; },
    async clickTab() { browserCalls.push("click"); assistantReady = true; return { action: { clicked: true } }; },
    async waitTab() { browserCalls.push("wait"); return { action: { waited: true } }; },
    async closeCreatedTab() { browserCalls.push("close"); return { action: { closed: true } }; },
    async listTabs() { return { tabs: [{ tabRef: "tab_v61", url: "https://chatgpt.com/c/v61" }] }; },
  };
  const proBridge = new WorkbenchProBridge({ browser: mockBrowser, stateDir: path.join(fixture, "pro-state"), defaultCwd: fixture });
  const proStarted = await proBridge.start({ prompt: "Analyze deeply", thinking: "Pro", cwd: fixture });
  assert.equal(proStarted.apiBillingUsed, false);
  assert.equal(proStarted.codexModelTurnUsed, false);
  const proStatus = await proBridge.status({ bridgeRef: proStarted.bridgeRef, cwd: fixture });
  assert.equal(proStatus.status, "completed");
  assert.equal(proStatus.answer, "PRO_RESULT_V61");
  assert.equal(browserCalls.filter((value) => value.startsWith("fill:")).length, 1);
  await proBridge.close({ bridgeRef: proStarted.bridgeRef });

  const dispatchLog = [];
  const components = {
    fsGit: {
      async fsMkdir(args) { dispatchLog.push(`mkdir:${args.path}`); return { status: "created", path: args.path }; },
      async fsCreate(args) { dispatchLog.push(`create:${args.path}`); return { status: "created", path: args.path, sha256: "a".repeat(64) }; },
    },
    processes: {}, pty: {}, browser: null, mcpHub: null,
    proBridge: {
      async start() { dispatchLog.push("pro:start"); return { bridgeRef: "probridge_00000000-0000-0000-0000-000000000001", status: "in_progress" }; },
      async status() { dispatchLog.push("pro:status"); return { bridgeRef: "probridge_00000000-0000-0000-0000-000000000001", status: "completed", answer: "deep plan" }; },
    },
  };
  const stableWorkflow = new WorkbenchWorkflowEngine({ components, roots, stateDir: path.join(fixture, "workflow-stable-state"), defaultCwd: fixture });
  assert.equal(stableWorkflow.stepTypes.includes("pro_reason"), false);
  await assert.rejects(
    stableWorkflow.prepare({ title: "stable-reject", rootAlias: "fixture", basePath: ".", steps: [{ id: "reason", type: "pro_reason", args: { prompt: "reason" } }] }),
    /unsupported workflow step type: pro_reason/
  );

  const workflow = new WorkbenchWorkflowEngine({ components, roots, stateDir: path.join(fixture, "workflow-state"), defaultCwd: fixture, allowProReason: true });
  assert.equal(workflow.stepTypes.includes("pro_reason"), true);
  const prepared = await workflow.prepare({
    title: "V61 flow", rootAlias: "fixture", basePath: ".",
    steps: [
      { id: "one", type: "fs_mkdir", args: { path: "a" } },
      { id: "reason", type: "pro_reason", args: { prompt: "reason", thinking: "Pro" } },
      { id: "three", type: "fs_create", args: { path: "${steps.one.path}/done.txt", content: "ok" } },
    ],
  });
  const firstRun = await workflow.run({ workflowRef: prepared.workflowRef, maxSteps: 10 });
  assert.equal(firstRun.status, "waiting");
  assert.deepEqual(dispatchLog, ["mkdir:a", "pro:start"]);
  const secondRun = await workflow.run({ workflowRef: prepared.workflowRef, maxSteps: 10 });
  assert.equal(secondRun.status, "completed");
  assert.deepEqual(dispatchLog, ["mkdir:a", "pro:start", "pro:status", "create:a/done.txt"]);

  const manifest = new WorkbenchExecutionManifest({ roots, workflow, stateDir: path.join(fixture, "manifest-state") });
  const manifestPrepared = await manifest.prepare({ title: "Manifest V61", rootAlias: "fixture", steps: [{ id: "mk", type: "fs_mkdir", args: { path: "manifest-dir" } }], source: "pro-web" });
  assert.equal(manifestPrepared.protocol, EXECUTION_MANIFEST_PROTOCOL);
  assert.equal(manifestPrepared.temporaryPermissionLease, false);
  assert.equal(manifestPrepared.apiRouteUsed, false);
  const manifestValidated = await manifest.validate({ manifestRef: manifestPrepared.manifestRef });
  assert.equal(manifestValidated.validation.ready, true);
  const manifestRun = await manifest.run({ manifestRef: manifestPrepared.manifestRef, maxSteps: 10 });
  assert.equal(manifestRun.status, "completed");

  console.log("Workbench V6.1 permanent-authority/PTY/Pro/workflow contract passed");
} finally {
  await rm(fixture, { recursive: true, force: true }).catch(() => {});
}
