import { createRequire } from "node:module";
import { WorkbenchComputerUse } from "./workbench-computer-use.mjs";
import { WorkbenchFsGit } from "./workbench-fs-git.mjs";
import { WorkbenchImageHandoff } from "./workbench-image-handoff.mjs";
import { WorkbenchMcpHub } from "./workbench-mcp-hub.mjs";
import { WorkbenchProcessManager } from "./workbench-process.mjs";
import { WorkbenchWorkspaceManager } from "./workbench-workspaces.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function createPrivateWorkbench({
  authorityExecutor,
  browserReader = null,
  publicContext = null,
  defaultCwd = null,
  workspaceStateDir = null,
  processStateDir = null,
  mcpAllowedServers = null,
  mcpAllowCodexApps = false,
} = {}) {
  const fsGit = new WorkbenchFsGit({ authorityExecutor });
  const imageHandoff = new WorkbenchImageHandoff({ authorityExecutor });
  const processes = new WorkbenchProcessManager({ authorityExecutor, stateDir: processStateDir });
  const mcpHub = publicContext
    ? new WorkbenchMcpHub({ context: publicContext, allowedServers: mcpAllowedServers ?? undefined, allowCodexApps: mcpAllowCodexApps })
    : null;
  const computerUse = publicContext && defaultCwd
    ? new WorkbenchComputerUse({ context: publicContext, defaultCwd })
    : null;
  const workspaces = workspaceStateDir && defaultCwd
    ? new WorkbenchWorkspaceManager({ authorityExecutor, processManager: processes, stateDir: workspaceStateDir, defaultCwd })
    : null;
  return {
    fsGit,
    imageHandoff,
    processes,
    browser: browserReader,
    mcpHub,
    computerUse,
    workspaces,
    async close() { await processes.close(); },
  };
}

export function registerPrivateWorkbenchTools(server, workbench) {
  if (!workbench) return;
  const cwd = z.string().min(1).max(32768).optional();
  const filePath = z.string().min(1).max(32768);
  const sha = z.string().regex(/^[0-9a-fA-F]{64}$/);
  const browserLocator = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("role"), role: z.string().min(1).max(200), name: z.string().max(1000).optional(), exact: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal("text"), value: z.string().min(1).max(2000), exact: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal("label"), value: z.string().min(1).max(2000), exact: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal("placeholder"), value: z.string().min(1).max(2000), exact: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal("testId"), value: z.string().min(1).max(2000), exact: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal("css"), value: z.string().min(1).max(4000), exact: z.boolean().default(false) }).strict(),
  ]);
  const browserIndex = z.number().int().min(0).max(10000).nullable().default(null);
  const browserTimeout = z.number().int().min(100).max(60000).default(10000);

  register(server, "workbench.fs_list", {
    title: "Workbench List Directory",
    description: "List one directory inside the locally authorized Codex trusted root. Symbolic links/junctions are reported but never followed.",
    inputSchema: z.object({ path: z.string().min(1).max(32768).default("."), cwd }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.fsList(input));

  register(server, "workbench.fs_tree", {
    title: "Workbench Project Tree",
    description: "Recursively inspect an authority-bounded project tree without following symbolic links or junctions.",
    inputSchema: z.object({
      path: z.string().min(1).max(32768).default("."),
      cwd,
      maxDepth: z.number().int().min(1).max(8).default(3),
      maxEntries: z.number().int().min(1).max(5000).default(1000),
    }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.fsTree(input));

  register(server, "workbench.fs_read", {
    title: "Workbench Read File Range",
    description: "Read a bounded line range from one UTF-8 file inside the trusted root and return its SHA-256 for guarded follow-up writes.",
    inputSchema: z.object({
      path: filePath,
      cwd,
      startLine: z.number().int().min(1).default(1),
      endLine: z.number().int().min(1).nullable().default(null),
      maxChars: z.number().int().min(1000).max(500000).default(200000),
    }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.fsRead(input));

  register(server, "workbench.fs_create", {
    title: "Workbench Create File",
    description: "Create a new UTF-8 file inside an existing authorized directory. Refuses overwrite and refuses path escape.",
    inputSchema: z.object({ path: filePath, content: z.string().max(2000000), cwd }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsCreate(input));

  register(server, "workbench.fs_write", {
    title: "Workbench Guarded File Write",
    description: "Replace an existing UTF-8 file only when the caller supplies its exact current SHA-256. The write is verified after completion.",
    inputSchema: z.object({ path: filePath, content: z.string().max(2000000), expectedSha256: sha, cwd }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsWrite(input));

  register(server, "workbench.fs_mkdir", {
    title: "Workbench Create Directory",
    description: "Create one new directory under an existing directory inside the trusted root. Refuses overwrite and path escape.",
    inputSchema: z.object({ path: filePath, cwd }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsMkdir(input));

  register(server, "workbench.fs_move", {
    title: "Workbench Move File or Directory",
    description: "Move one regular file or directory within the trusted root without overwriting the destination. Optional file hash guards source drift.",
    inputSchema: z.object({ source: filePath, destination: filePath, expectedSha256: sha.nullable().default(null), cwd }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsMove(input));

  register(server, "workbench.fs_copy", {
    title: "Workbench Guarded File Copy",
    description: "Copy one regular file inside the trusted root without overwriting the destination. Optional SHA-256 guards source drift and the copied bytes are verified.",
    inputSchema: z.object({ source: filePath, destination: filePath, expectedSha256: sha.nullable().default(null), cwd }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsCopy(input));

  register(server, "workbench.fs_delete", {
    title: "Workbench Guarded Delete",
    description: "Delete one regular file or one empty directory inside the trusted root. File deletion requires the exact current SHA-256. Recursive directory deletion is intentionally absent in V1.",
    inputSchema: z.object({ path: filePath, expectedSha256: sha.nullable().default(null), cwd }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsDelete(input));

  register(server, "workbench.project_search", {
    title: "Workbench Project Search",
    description: "Search filenames and UTF-8 text recursively inside an authorized project tree with bounded files and matches. Common build/vendor directories are excluded by default.",
    inputSchema: z.object({
      query: z.string().min(1).max(4096),
      cwd,
      path: z.string().min(1).max(32768).default("."),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      maxMatches: z.number().int().min(1).max(2000).default(200),
      maxFiles: z.number().int().min(1).max(20000).default(3000),
      maxFileBytes: z.number().int().min(1024).max(10000000).default(2000000),
      excludeDirs: z.array(z.string().min(1).max(255)).max(100).default([]),
    }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.projectSearch(input));

  server.registerTool(
    "workbench.image_handoff_prepare",
    {
      title: "Prepare ChatGPT Image Handoff",
      description: "Prepare a read-only handoff packet for ChatGPT built-in image generation. It can forward bounded local UTF-8 source excerpts and PNG/JPG/WebP reference images from the authorized root into the current conversation. Codexzxm does not invoke Image2/image_gen or an OpenAI image API itself.",
      inputSchema: z.object({
        cwd,
        goal: z.string().min(1).max(20000),
        sourceTextPaths: z.array(filePath).max(20).default([]),
        sourceImagePaths: z.array(filePath).max(12).default([]),
        exactText: z.array(z.string().max(10000)).max(100).default([]),
        styleNotes: z.array(z.string().max(10000)).max(100).default([]),
        mustKeep: z.array(z.string().max(10000)).max(100).default([]),
        mustAvoid: z.array(z.string().max(10000)).max(100).default([]),
        canvas: z.object({ width: z.number().int().min(1).max(20000).nullable().default(null), height: z.number().int().min(1).max(20000).nullable().default(null), aspectRatio: z.string().max(100).nullable().default(null) }).strict().nullable().default(null),
        outputBasename: z.string().max(500).nullable().default(null),
        maxCharsPerText: z.number().int().min(1000).max(100000).default(20000),
        maxTotalTextChars: z.number().int().min(1000).max(300000).default(100000),
        maxImageBytes: z.number().int().min(10000).max(10000000).default(5000000),
        maxTotalImageBytes: z.number().int().min(10000).max(30000000).default(20000000),
      }).strict(),
      annotations: readOnly(false),
    },
    async (input) => imageHandoffStructured(() => workbench.imageHandoff.prepare(input))
  );

  register(server, "workbench.process_start", {
    title: "Workbench Start Persistent Process",
    description: "Start a durable local process with disk-backed status/events and a detached runner. The same processRef can be rediscovered after the Codexzxm service restarts. This lane fails closed unless Codex resolves the cwd to explicit :danger-full-access authority.",
    inputSchema: z.object({
      command: z.array(z.string().max(32768)).min(1).max(128),
      cwd,
      env: z.record(z.string(), z.string()).default({}),
      label: z.string().max(200).nullable().default(null),
    }).strict(),
    annotations: processTool(),
  }, (input) => workbench.processes.start(input));

  register(server, "workbench.process_list", {
    title: "Workbench List Processes",
    description: "List durable Codexzxm process sessions from the disk registry, including processes that were started by a previous Codexzxm service instance.",
    inputSchema: z.object({}).strict(),
    annotations: readOnly(true),
  }, () => workbench.processes.list());

  register(server, "workbench.process_read", {
    title: "Workbench Read Process Events",
    description: "Read bounded stdout/stderr/stdin/system events from one Workbench-owned process after a sequence number.",
    inputSchema: z.object({
      processRef: z.string().min(1).max(128),
      afterSeq: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(1000).max(500000).default(50000),
    }).strict(),
    annotations: readOnly(true),
  }, (input) => workbench.processes.read(input));

  register(server, "workbench.process_send", {
    title: "Workbench Send Process Input",
    description: "Write text to stdin of one currently running Workbench-owned process.",
    inputSchema: z.object({
      processRef: z.string().min(1).max(128),
      text: z.string().max(200000),
      appendNewline: z.boolean().default(false),
    }).strict(),
    annotations: processTool(),
  }, (input) => workbench.processes.send(input));

  register(server, "workbench.process_stop", {
    title: "Workbench Stop Process",
    description: "Request termination of one Workbench-owned process. force=true uses a forceful process-tree termination on Windows.",
    inputSchema: z.object({ processRef: z.string().min(1).max(128), force: z.boolean().default(false) }).strict(),
    annotations: processTool(),
  }, (input) => workbench.processes.stop(input));

  register(server, "workbench.git_status", {
    title: "Workbench Git Status",
    description: "Run git status through the Codex model-free command lane under read-only authority.",
    inputSchema: z.object({ cwd }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.gitStatus(input));

  register(server, "workbench.git_diff", {
    title: "Workbench Git Diff",
    description: "Read working-tree or staged Git diff through the Codex model-free command lane.",
    inputSchema: z.object({ cwd, staged: z.boolean().default(false), path: z.string().min(1).max(32768).nullable().default(null) }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.gitDiff(input));

  register(server, "workbench.git_log", {
    title: "Workbench Git Log",
    description: "Read recent Git history through the Codex model-free command lane.",
    inputSchema: z.object({ cwd, count: z.number().int().min(1).max(100).default(20) }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.gitLog(input));

  register(server, "workbench.git_stage", {
    title: "Workbench Git Stage",
    description: "Stage explicitly named paths through the Codex model-free command lane under inherited local authority.",
    inputSchema: z.object({ cwd, paths: z.array(z.string().min(1).max(32768)).min(1).max(100) }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.gitStage(input));

  register(server, "workbench.git_commit_staged", {
    title: "Workbench Commit Staged Changes",
    description: "Create one local Git commit from the currently staged index. This tool never pushes to a remote.",
    inputSchema: z.object({ cwd, message: z.string().min(1).max(10000) }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.gitCommitStaged(input));

  register(server, "workbench.git_branches", {
    title: "Workbench Git Branches",
    description: "List local or all Git branches with current/upstream markers.",
    inputSchema: z.object({ cwd, all: z.boolean().default(false) }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.gitBranches(input));

  register(server, "workbench.git_switch", {
    title: "Workbench Git Switch",
    description: "Switch to an existing local branch or create a new local branch from an optional start point. Never pushes remotely.",
    inputSchema: z.object({ cwd, branch: z.string().min(1).max(1024), create: z.boolean().default(false), startPoint: z.string().min(1).max(1024).nullable().default(null) }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.gitSwitch(input));

  register(server, "workbench.git_stash_push", {
    title: "Workbench Git Stash Push",
    description: "Create a local Git stash, optionally including untracked files. Never changes a remote repository.",
    inputSchema: z.object({ cwd, message: z.string().max(2000).nullable().default(null), includeUntracked: z.boolean().default(false) }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.gitStashPush(input));

  register(server, "workbench.git_stash_list", {
    title: "Workbench Git Stash List",
    description: "Read recent local Git stash entries.",
    inputSchema: z.object({ cwd, count: z.number().int().min(1).max(100).default(20) }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.gitStashList(input));

  register(server, "workbench.git_stash_pop", {
    title: "Workbench Git Stash Pop",
    description: "Apply and remove one named local stash entry. This mutates the working tree and can produce conflicts.",
    inputSchema: z.object({ cwd, stashRef: z.string().min(1).max(1024).default("stash@{0}") }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.gitStashPop(input));

  register(server, "workbench.git_fetch", {
    title: "Workbench Git Fetch",
    description: "Fetch remote Git refs through the model-free command lane. This contacts an external Git remote and updates local remote-tracking refs.",
    inputSchema: z.object({ cwd, remote: z.string().min(1).max(1024).default("origin"), prune: z.boolean().default(true) }).strict(),
    annotations: networkMutationTool(false),
  }, (input) => workbench.fsGit.gitFetch(input));

  register(server, "workbench.git_pull", {
    title: "Workbench Git Pull",
    description: "Pull from an external Git remote into the current branch using fast-forward-only by default or rebase when requested.",
    inputSchema: z.object({ cwd, remote: z.string().min(1).max(1024).default("origin"), branch: z.string().min(1).max(1024).nullable().default(null), rebase: z.boolean().default(false), ffOnly: z.boolean().default(true) }).strict(),
    annotations: networkMutationTool(true),
  }, (input) => workbench.fsGit.gitPull(input));

  register(server, "workbench.git_push", {
    title: "Workbench Git Push",
    description: "Push commits to an external Git remote. force=true is intentionally unavailable; the strongest option exposed is --force-with-lease.",
    inputSchema: z.object({ cwd, remote: z.string().min(1).max(1024).default("origin"), branch: z.string().min(1).max(1024).nullable().default(null), setUpstream: z.boolean().default(false), forceWithLease: z.boolean().default(false) }).strict(),
    annotations: networkMutationTool(true),
  }, (input) => workbench.fsGit.gitPush(input));

  if (workbench.browser) {
    register(server, "workbench.browser_recover", {
      title: "Workbench Recover Browser Runtime",
      description: "Restart the Codex Browser/node_repl context after a timeout or backend failure. This invalidates all prior browser tabRef values and never replays a browser mutation automatically.",
      inputSchema: z.object({ cwd }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.browser.recover(input));

    register(server, "workbench.browser_open", {
      title: "Workbench Open Chrome Tab",
      description: "Create a new Workbench-owned Chrome tab, optionally navigate it, and return an opaque tabRef. The tab is kept for follow-up Workbench calls.",
      inputSchema: z.object({ url: z.string().min(1).max(32768).nullable().default(null), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.openTab(input));

    register(server, "workbench.browser_navigate", {
      title: "Workbench Navigate Chrome Tab",
      description: "Navigate one known Workbench/user Chrome tabRef to a URL. Browser content is untrusted; callers remain responsible for action-time confirmation before risky external side effects.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), url: z.string().min(1).max(32768), cwd, timeoutMs: browserTimeout.default(15000) }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.navigateTab(input));

    register(server, "workbench.browser_reload", {
      title: "Workbench Reload Chrome Tab",
      description: "Reload one known Chrome tabRef and wait for DOMContentLoaded when available. Useful after local web-app code changes.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), cwd, timeoutMs: browserTimeout.default(15000) }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.reloadTab(input));

    register(server, "workbench.browser_click", {
      title: "Workbench Click Chrome Element",
      description: "Click exactly one semantically located element in Chrome. Ambiguous locators fail closed unless an explicit zero-based index is supplied. Callers must obtain any browser confirmation required for the resulting external side effect.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), locator: browserLocator, index: browserIndex, cwd, timeoutMs: browserTimeout }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.clickTab(input));

    register(server, "workbench.browser_fill", {
      title: "Workbench Fill Chrome Field",
      description: "Replace the value of exactly one semantically located form field. Typing sensitive data is transmission and requires action-time user confirmation under browser safety policy.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), locator: browserLocator, value: z.string().max(200000), index: browserIndex, cwd, timeoutMs: browserTimeout }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.fillTab(input));

    register(server, "workbench.browser_press", {
      title: "Workbench Press Key in Chrome Element",
      description: "Press a named keyboard key on exactly one semantically located Chrome element.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), locator: browserLocator, key: z.string().min(1).max(200), index: browserIndex, cwd, timeoutMs: browserTimeout }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.pressTab(input));

    register(server, "workbench.browser_select", {
      title: "Workbench Select Chrome Option",
      description: "Select an option on exactly one native select element using a string value or a value/label/index descriptor.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256),
        locator: browserLocator,
        option: z.union([
          z.string().max(2000),
          z.object({ value: z.string().max(2000).optional(), label: z.string().max(2000).optional(), index: z.number().int().min(0).max(10000).optional() }).strict(),
        ]),
        index: browserIndex,
        cwd,
        timeoutMs: browserTimeout,
      }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.selectTab(input));

    register(server, "workbench.browser_wait", {
      title: "Workbench Wait for Chrome State",
      description: "Wait for a load state, URL, locator state, or bounded timeout on one known Chrome tabRef.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256),
        kind: z.enum(["loadState", "url", "locator", "timeout"]),
        state: z.string().max(100).nullable().default(null),
        url: z.string().max(32768).nullable().default(null),
        locator: browserLocator.nullable().default(null),
        index: browserIndex,
        cwd,
        timeoutMs: browserTimeout,
      }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.browser.waitTab(input));

    server.registerTool(
      "workbench.browser_screenshot",
      {
        title: "Workbench Screenshot Chrome Tab",
        description: "Capture a PNG screenshot of one known Chrome tabRef. Returns image content plus bounded metadata; it does not expose cookies, storage, passwords, or browser profile files.",
        inputSchema: z.object({
          tabRef: z.string().min(1).max(256),
          cwd,
          fullPage: z.boolean().default(false),
          maxBytes: z.number().int().min(100000).max(10000000).default(5000000),
        }).strict(),
        annotations: readOnly(true),
      },
      async (input) => screenshotStructured(() => workbench.browser.screenshotTab(input))
    );

    register(server, "workbench.browser_logs", {
      title: "Workbench Read Chrome Console Logs",
      description: "Read bounded console logs captured for one known Chrome tabRef. Useful for local web development and debugging.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256),
        cwd,
        levels: z.array(z.enum(["debug", "info", "log", "warn", "error", "warning"])).max(6).default([]),
        filter: z.string().max(2000).nullable().default(null),
        limit: z.number().int().min(1).max(500).default(100),
      }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.browser.logsTab(input));

    register(server, "workbench.browser_close", {
      title: "Workbench Close Created Chrome Tab",
      description: "Close only a Chrome tab created by workbench.browser_open. Existing user tabs are deliberately refused.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.closeCreatedTab(input));
  }

  if (workbench.mcpHub) {
    register(server, "workbench.mcp_servers", {
      title: "Workbench List MCP Servers",
      description: "Discover MCP servers currently visible through the local Codex App Server and report whether this private Workbench may call each one.",
      inputSchema: z.object({ query: z.string().max(2000).default(""), limit: z.number().int().min(1).max(500).default(100) }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.mcpHub.listServers(input));

    register(server, "workbench.mcp_tools", {
      title: "Workbench Search MCP Tools",
      description: "Search one MCP server's live tool catalog. Use this before generic calls when the exact tool name or schema is not already known.",
      inputSchema: z.object({
        server: z.string().min(1).max(512),
        query: z.string().max(4000).default(""),
        offset: z.number().int().min(0).max(100000).default(0),
        limit: z.number().int().min(1).max(200).default(50),
        includeSchemas: z.boolean().default(false),
      }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.mcpHub.listTools(input));

    register(server, "workbench.mcp_describe", {
      title: "Workbench Describe MCP Tool",
      description: "Read the current full descriptor and input schema for one exact MCP tool before constructing a generic call.",
      inputSchema: z.object({ server: z.string().min(1).max(512), tool: z.string().min(1).max(1024) }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.mcpHub.describeTool(input));

    server.registerTool(
      "workbench.mcp_call",
      {
        title: "Workbench Call MCP Tool",
        description: "Call one exact live MCP tool through Codex App Server without a Codex model turn. External apps are enabled only by local private policy. Set confirmedSideEffects=true for tools not declared read-only when the user's task authorizes the mutation or external action. Recursive calls back into codexless_mcp.* are refused.",
        inputSchema: z.object({
          server: z.string().min(1).max(512),
          tool: z.string().min(1).max(1024),
          arguments: z.record(z.string(), z.unknown()).default({}),
          cwd,
          timeoutMs: z.number().int().min(1000).max(120000).default(60000),
          confirmedSideEffects: z.boolean().default(false),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async (input) => mcpCallStructured(() => workbench.mcpHub.call(input))
    );
  }

  if (workbench.computerUse) {
    register(server, "workbench.computer_apps", {
      title: "Workbench List Windows Apps",
      description: "List Windows apps and their targetable windows through the official @oai/sky Computer Use runtime. Protected/forbidden targets are marked blocked.",
      inputSchema: z.object({ cwd, query: z.string().max(2000).default(""), limit: z.number().int().min(1).max(500).default(100) }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.computerUse.listApps(input));

    register(server, "workbench.computer_windows", {
      title: "Workbench List Windows Windows",
      description: "List currently open targetable Windows windows and return opaque windowRef values. Never guess raw window ids.",
      inputSchema: z.object({ cwd, query: z.string().max(2000).default(""), limit: z.number().int().min(1).max(500).default(100) }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.computerUse.listWindows(input));

    register(server, "workbench.computer_launch", {
      title: "Workbench Launch Windows App",
      description: "Launch an allowed Windows app by an app id previously returned by Computer Use or by an explicit executable identifier. Terminals, ChatGPT/Codex, authentication/security apps and password managers are hard-refused.",
      inputSchema: z.object({ app: z.string().min(1).max(32768), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.computerUse.launchApp(input));

    register(server, "workbench.computer_activate", {
      title: "Workbench Activate Windows Window",
      description: "Bring one previously listed allowed windowRef to the foreground. Follow Computer Use confirmation policy for any subsequent risky UI action.",
      inputSchema: z.object({ windowRef: z.string().min(1).max(256), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.computerUse.activateWindow(input));

    server.registerTool(
      "workbench.computer_state",
      {
        title: "Workbench Observe Windows Window",
        description: "Capture a fresh point-in-time Windows UI observation. Returns a one-use observationRef, optional UI Automation tree/focus state, and screenshot images/ids. Actions must use the newest observationRef.",
        inputSchema: z.object({
          windowRef: z.string().min(1).max(256),
          cwd,
          includeScreenshot: z.boolean().default(true),
          includeText: z.boolean().default(true),
        }).strict(),
        annotations: readOnly(true),
      },
      async (input) => computerStructured(() => workbench.computerUse.observe(input))
    );

    server.registerTool(
      "workbench.computer_click",
      {
        title: "Workbench Click Windows UI",
        description: "Click once using either a fresh accessibility element index or coordinates plus screenshotId from the supplied observationRef, then automatically refresh state. Risky UI side effects still require the Computer Use action-time confirmation policy.",
        inputSchema: z.object({
          observationRef: z.string().min(1).max(256),
          elementIndex: z.number().int().min(0).max(1000000).nullable().default(null),
          screenshotId: z.string().max(256).nullable().default(null),
          x: z.number().nullable().default(null),
          y: z.number().nullable().default(null),
          mouseButton: z.enum(["left", "right", "middle", "l", "r", "m"]).default("left"),
          clickCount: z.number().int().min(1).max(3).default(1),
          cwd,
        }).strict(),
        annotations: browserMutationTool(),
      },
      async (input) => computerStructured(() => workbench.computerUse.click(input))
    );

    server.registerTool(
      "workbench.computer_set_value",
      {
        title: "Workbench Set Windows UI Value",
        description: "Replace the value of one editable accessibility element from a fresh observation, then refresh state.",
        inputSchema: z.object({ observationRef: z.string().min(1).max(256), elementIndex: z.number().int().min(0).max(1000000), value: z.string().max(200000), cwd }).strict(),
        annotations: browserMutationTool(),
      },
      async (input) => computerStructured(() => workbench.computerUse.setValue(input))
    );

    server.registerTool(
      "workbench.computer_type",
      {
        title: "Workbench Type Windows Text",
        description: "Type literal text only after a fresh observation confirms the intended element currently has focus, then refresh state. Sensitive-data transmission and representational actions must follow Computer Use confirmations.",
        inputSchema: z.object({ observationRef: z.string().min(1).max(256), text: z.string().max(200000), cwd }).strict(),
        annotations: browserMutationTool(),
      },
      async (input) => computerStructured(() => workbench.computerUse.typeText(input))
    );

    server.registerTool(
      "workbench.computer_key",
      {
        title: "Workbench Press Windows Key Chord",
        description: "Press a key/chord in an allowed target window and refresh state. Windows/Meta/Cmd/Super key shortcuts are hard-refused.",
        inputSchema: z.object({ observationRef: z.string().min(1).max(256), key: z.string().min(1).max(200), cwd }).strict(),
        annotations: browserMutationTool(),
      },
      async (input) => computerStructured(() => workbench.computerUse.pressKey(input))
    );

    server.registerTool(
      "workbench.computer_scroll",
      {
        title: "Workbench Scroll Windows UI",
        description: "Scroll from coordinates tied to a fresh screenshot observation, then refresh state.",
        inputSchema: z.object({ observationRef: z.string().min(1).max(256), screenshotId: z.string().min(1).max(256), x: z.number(), y: z.number(), scrollX: z.number().default(0), scrollY: z.number(), cwd }).strict(),
        annotations: browserMutationTool(),
      },
      async (input) => computerStructured(() => workbench.computerUse.scroll(input))
    );

    server.registerTool(
      "workbench.computer_drag",
      {
        title: "Workbench Drag Windows UI",
        description: "Drag between coordinates tied to a fresh screenshot observation, then refresh state.",
        inputSchema: z.object({ observationRef: z.string().min(1).max(256), screenshotId: z.string().min(1).max(256), fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number(), cwd }).strict(),
        annotations: browserMutationTool(),
      },
      async (input) => computerStructured(() => workbench.computerUse.drag(input))
    );

    server.registerTool(
      "workbench.computer_secondary_action",
      {
        title: "Workbench Windows Secondary Action",
        description: "Invoke a secondary UI Automation action such as Expand, Collapse, Raise, or Scroll on an element from a fresh accessibility observation, then refresh state.",
        inputSchema: z.object({ observationRef: z.string().min(1).max(256), elementIndex: z.number().int().min(0).max(1000000), action: z.string().min(1).max(200), cwd }).strict(),
        annotations: browserMutationTool(),
      },
      async (input) => computerStructured(() => workbench.computerUse.secondaryAction(input))
    );
  }

  if (workbench.workspaces) {
    register(server, "workbench.workspace_create", {
      title: "Workbench Create Persistent Workspace",
      description: "Create or recover a persistent Workbench workspace for one authorized project cwd. Workspace tasks, logs, and snapshot metadata survive Workbench service restarts.",
      inputSchema: z.object({ name: z.string().max(500).nullable().default(null), cwd }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.workspaces.create(input));

    register(server, "workbench.workspace_list", {
      title: "Workbench List Persistent Workspaces",
      description: "List persisted Workbench workspaces and compact task/log/snapshot counts.",
      inputSchema: z.object({ query: z.string().max(2000).default(""), limit: z.number().int().min(1).max(1000).default(100) }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.workspaces.list(input));

    register(server, "workbench.workspace_inspect", {
      title: "Workbench Inspect Persistent Workspace",
      description: "Inspect one persistent workspace including tasks, recent logs, snapshots, current Git changes, and Workbench-owned processes for that cwd.",
      inputSchema: z.object({ workspaceRef: z.string().min(1).max(256) }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.workspaces.inspect(input));

    register(server, "workbench.workspace_changed_files", {
      title: "Workbench Workspace Changed Files",
      description: "Read current Git changed/untracked files for a persistent workspace without modifying the project.",
      inputSchema: z.object({ workspaceRef: z.string().min(1).max(256) }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.workspaces.changedFiles(input));

    register(server, "workbench.workspace_task_upsert", {
      title: "Workbench Upsert Persistent Task",
      description: "Create or update a persistent project task with todo/doing/blocked/done status.",
      inputSchema: z.object({
        workspaceRef: z.string().min(1).max(256),
        taskId: z.string().min(1).max(256).nullable().default(null),
        title: z.string().min(1).max(2000),
        status: z.enum(["todo", "doing", "blocked", "done"]).default("todo"),
        details: z.string().max(20000).nullable().default(null),
      }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.workspaces.taskUpsert(input));

    register(server, "workbench.workspace_tasks", {
      title: "Workbench List Persistent Tasks",
      description: "List all or status-filtered persistent tasks in one workspace.",
      inputSchema: z.object({
        workspaceRef: z.string().min(1).max(256),
        status: z.enum(["todo", "doing", "blocked", "done"]).nullable().default(null),
      }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.workspaces.tasks(input));

    register(server, "workbench.workspace_log_append", {
      title: "Workbench Append Workspace Log",
      description: "Append one durable project note/event to a workspace audit log.",
      inputSchema: z.object({
        workspaceRef: z.string().min(1).max(256),
        kind: z.string().min(1).max(200).default("note"),
        message: z.string().min(1).max(20000),
        metadata: z.record(z.string(), z.unknown()).nullable().default(null),
      }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.workspaces.logAppend(input));

    register(server, "workbench.workspace_logs", {
      title: "Workbench Read Workspace Logs",
      description: "Read bounded persistent workspace logs, optionally after an ISO timestamp.",
      inputSchema: z.object({
        workspaceRef: z.string().min(1).max(256),
        after: z.string().max(100).nullable().default(null),
        limit: z.number().int().min(1).max(1000).default(100),
      }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.workspaces.logs(input));

    register(server, "workbench.workspace_snapshot", {
      title: "Workbench Snapshot Git Workspace",
      description: "Persist the exact current Git staged/unstaged patches plus bounded untracked-file copies for a workspace. V5 snapshots require workspace cwd to be the repository root.",
      inputSchema: z.object({ workspaceRef: z.string().min(1).max(256), label: z.string().max(500).default("snapshot") }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.workspaces.snapshot(input));

    register(server, "workbench.workspace_restore", {
      title: "Workbench Restore Git Workspace Snapshot",
      description: "Restore a V5 snapshot at the same Git HEAD. This changes tracked/staged state and selected snapshot untracked files. It first creates an automatic pre-restore snapshot and attempts rollback on failure. confirmedRestore=true is mandatory.",
      inputSchema: z.object({
        workspaceRef: z.string().min(1).max(256),
        snapshotId: z.string().min(1).max(256),
        confirmedRestore: z.boolean().default(false),
        overwriteUntracked: z.boolean().default(false),
      }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.workspaces.restore(input));
  }
}

function register(server, name, definition, handler) {
  server.registerTool(name, definition, async (input) => structured(() => handler(input)));
}

function readOnly(openWorld) {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: openWorld };
}

function writeTool() {
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
}

function processTool() {
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}

function networkMutationTool(destructive = true) {
  return { readOnlyHint: false, destructiveHint: destructive === true, idempotentHint: false, openWorldHint: true };
}

function browserMutationTool() {
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}

async function computerStructured(task) {
  try {
    const payload = await task();
    const forwarded = Array.isArray(payload?.contentItems) ? payload.contentItems.filter((item) => item?.type !== "text") : [];
    const summary = { ...payload };
    delete summary.contentItems;
    const content = [...forwarded];
    content.push({ type: "text", text: JSON.stringify(summary) });
    return { content, structuredContent: summary, isError: false };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}

async function imageHandoffStructured(task) {
  try {
    const payload = await task();
    const forwarded = Array.isArray(payload?.contentItems) ? payload.contentItems : [];
    const summary = { ...payload };
    delete summary.contentItems;
    return {
      content: [...forwarded, { type: "text", text: JSON.stringify(summary) }],
      structuredContent: summary,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}

async function mcpCallStructured(task) {
  try {
    const payload = await task();
    const forwarded = Array.isArray(payload?.contentItems) ? payload.contentItems : [];
    const summary = { ...payload };
    delete summary.contentItems;
    const content = [...forwarded];
    content.push({ type: "text", text: JSON.stringify(summary) });
    return { content, structuredContent: summary, isError: payload?.resultIsError === true };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}

async function screenshotStructured(task) {
  try {
    const payload = await task();
    const action = payload?.action && typeof payload.action === "object" ? { ...payload.action } : null;
    const data = typeof action?.base64 === "string" ? action.base64 : null;
    const mimeType = typeof action?.mimeType === "string" ? action.mimeType : "image/png";
    if (!data) throw new Error("browser screenshot returned no base64 image data");
    delete action.base64;
    const publicPayload = { ...payload, action };
    return {
      content: [
        { type: "image", data, mimeType },
        { type: "text", text: JSON.stringify(publicPayload) },
      ],
      structuredContent: publicPayload,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}

async function structured(task) {
  try {
    const payload = await task();
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}
