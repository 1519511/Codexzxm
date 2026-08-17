import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { WorkbenchComputerUse } from "./workbench-computer-use.mjs";
import { WorkbenchExecutionManifest } from "./workbench-execution-manifest.mjs";
import { WorkbenchFsGit } from "./workbench-fs-git.mjs";
import { WorkbenchImageHandoff } from "./workbench-image-handoff.mjs";
import { WorkbenchMcpHub } from "./workbench-mcp-hub.mjs";
import { WorkbenchProcessManager } from "./workbench-process.mjs";
import { WorkbenchPtyManager } from "./workbench-pty.mjs";
import { WorkbenchRootRegistry } from "./workbench-root-registry.mjs";
import { WorkbenchSecretBroker } from "./workbench-secret-broker.mjs";
import { WorkbenchProBridge } from "./workbench-pro-bridge.mjs";
import { WorkbenchWorkflowEngine, WORKFLOW_STEP_TYPES } from "./workbench-workflow.mjs";
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
  const stateRoot = path.join(os.homedir(), ".config", "codexzxm");
  const roots = defaultCwd ? new WorkbenchRootRegistry({ authorityExecutor, stateDir: path.join(stateRoot, "roots-v1"), defaultCwd }) : null;
  const secrets = new WorkbenchSecretBroker({ stateDir: path.join(stateRoot, "secrets-v1") });
  const pty = new WorkbenchPtyManager({ authorityExecutor, stateDir: path.join(stateRoot, "pty-v1") });
  const proBridge = browserReader && defaultCwd ? new WorkbenchProBridge({ browser: browserReader, stateDir: path.join(stateRoot, "pro-bridge-v1"), defaultCwd }) : null;
  const mcpHub = publicContext
    ? new WorkbenchMcpHub({ context: publicContext, allowedServers: mcpAllowedServers ?? undefined, allowCodexApps: mcpAllowCodexApps })
    : null;
  const computerUse = publicContext && defaultCwd
    ? new WorkbenchComputerUse({ context: publicContext, defaultCwd })
    : null;
  const workspaces = workspaceStateDir && defaultCwd
    ? new WorkbenchWorkspaceManager({ authorityExecutor, processManager: processes, stateDir: workspaceStateDir, defaultCwd })
    : null;
  const workflowComponents = { fsGit, processes, pty, browser: browserReader, mcpHub, proBridge };
  const workflow = roots && defaultCwd ? new WorkbenchWorkflowEngine({ components: workflowComponents, roots, stateDir: path.join(stateRoot, "workflows-v1"), defaultCwd }) : null;
  const executionManifest = roots && workflow ? new WorkbenchExecutionManifest({ roots, workflow, stateDir: path.join(stateRoot, "execution-manifests-v1") }) : null;
  return {
    fsGit,
    imageHandoff,
    processes,
    pty,
    roots,
    secrets,
    proBridge,
    workflow,
    executionManifest,
    browser: browserReader,
    mcpHub,
    computerUse,
    workspaces,
    async close() { await Promise.allSettled([processes.close(), pty.close()]); },
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
  const secretEnv = z.record(z.string(), z.string().min(1).max(64)).default({});

  if (workbench.roots) {
    register(server, "workbench.root_register", {
      title: "Register Permanent Authorized Root",
      description: "Persist a stable alias for a root that Codex already resolves to explicit :danger-full-access authority. Registration is permanent until removed and never creates or widens Codex trust.",
      inputSchema: z.object({ alias: z.string().min(1).max(64), cwd, description: z.string().max(2000).nullable().default(null) }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.roots.register(input));
    register(server, "workbench.root_list", {
      title: "List Permanent Authorized Roots",
      description: "List permanent root aliases. refreshAuthority=true revalidates each alias against current Codex authority without changing permissions.",
      inputSchema: z.object({ query: z.string().max(2000).default(""), refreshAuthority: z.boolean().default(false) }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.roots.list(input));
    register(server, "workbench.root_status", {
      title: "Check Permanent Root Authority",
      description: "Revalidate one permanent root alias against current Codex trust and :danger-full-access authority.",
      inputSchema: z.object({ alias: z.string().min(1).max(64) }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.roots.status(input));
    register(server, "workbench.root_resolve", {
      title: "Resolve Permanent Root Path",
      description: "Resolve a root alias plus a relative path into an authority-checked local cwd. Refuses path escape and authority drift.",
      inputSchema: z.object({ alias: z.string().min(1).max(64), path: z.string().min(1).max(32768).default(".") }).strict(),
      annotations: readOnly(false),
    }, (input) => workbench.roots.resolve(input));
    register(server, "workbench.root_remove", {
      title: "Remove Permanent Root Alias",
      description: "Remove only the Codexzxm alias record. It does not change Codex trust, permissions, or local files.",
      inputSchema: z.object({ alias: z.string().min(1).max(64) }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.roots.remove(input));
  }

  register(server, "workbench.secret_list", {
    title: "List Permanent Secret References",
    description: "List secretRef metadata backed by Windows DPAPI or macOS Keychain. Secret plaintext is never returned.",
    inputSchema: z.object({ query: z.string().max(2000).default("") }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.secrets.list(input));
  register(server, "workbench.secret_metadata", {
    title: "Read Secret Reference Metadata",
    description: "Read metadata for one permanent secretRef without exposing its plaintext value.",
    inputSchema: z.object({ alias: z.string().min(1).max(64) }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.secrets.metadata(input));

  register(server, "workbench.pty_start", {
    title: "Start Durable PTY Session",
    description: "Start a true durable terminal/PTY session for interactive CLIs and REPLs. Requires explicit Codex :danger-full-access authority. secretEnv maps environment names to permanent secretRef values without persisting plaintext.",
    inputSchema: z.object({ command: z.array(z.string().max(32768)).min(1).max(128).nullable().default(null), cwd, env: z.record(z.string(), z.string()).default({}), secretEnv, cols: z.number().int().min(20).max(500).default(120), rows: z.number().int().min(5).max(200).default(30), label: z.string().max(200).nullable().default(null) }).strict(),
    annotations: processTool(),
  }, (input) => workbench.pty.start(input));
  register(server, "workbench.pty_list", {
    title: "List Durable PTY Sessions",
    description: "List Codexzxm-owned PTY sessions that remain discoverable across runtime restarts.",
    inputSchema: z.object({}).strict(),
    annotations: readOnly(true),
  }, () => workbench.pty.list());
  register(server, "workbench.pty_read", {
    title: "Read PTY Output",
    description: "Read bounded PTY output/events after a sequence number.",
    inputSchema: z.object({ ptyRef: z.string().min(1).max(128), afterSeq: z.number().int().min(0).default(0), maxChars: z.number().int().min(1000).max(500000).default(50000) }).strict(),
    annotations: readOnly(true),
  }, (input) => workbench.pty.read(input));
  register(server, "workbench.pty_send", {
    title: "Send PTY Input",
    description: "Send literal text to one running PTY session.",
    inputSchema: z.object({ ptyRef: z.string().min(1).max(128), text: z.string().max(200000), appendNewline: z.boolean().default(false) }).strict(),
    annotations: processTool(),
  }, (input) => workbench.pty.send(input));
  register(server, "workbench.pty_resize", {
    title: "Resize PTY Session",
    description: "Resize one running PTY session for TUI/interactive CLI compatibility.",
    inputSchema: z.object({ ptyRef: z.string().min(1).max(128), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict(),
    annotations: processTool(),
  }, (input) => workbench.pty.resize(input));
  register(server, "workbench.pty_stop", {
    title: "Stop PTY Session",
    description: "Stop one Codexzxm-owned PTY session; force=true requests forceful termination.",
    inputSchema: z.object({ ptyRef: z.string().min(1).max(128), force: z.boolean().default(false) }).strict(),
    annotations: processTool(),
  }, (input) => workbench.pty.stop(input));

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

  register(server, "workbench.fs_metadata", {
    title: "Workbench File/Tree Metadata",
    description: "Read metadata for a regular file or directory. recursive=true performs a bounded symlink-refusing tree scan and content digest.",
    inputSchema: z.object({ path: filePath, cwd, recursive: z.boolean().default(false), maxEntries: z.number().int().min(1).max(100000).default(10000) }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.fsMetadata(input));

  register(server, "workbench.fs_copy_tree", {
    title: "Workbench Copy Directory Tree",
    description: "Recursively copy one authority-bounded directory tree after refusing symbolic links/junctions. Destination must not exist and copied content is rescanned.",
    inputSchema: z.object({ source: filePath, destination: filePath, cwd }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsCopyTree(input));

  register(server, "workbench.fs_archive_create", {
    title: "Workbench Create Tar Archive",
    description: "Create an authority-bounded .tar/.tar.gz/.tgz archive from one regular file or symlink-free directory tree, with a bounded source-size check.",
    inputSchema: z.object({ source: filePath, destination: filePath, cwd, maxBytes: z.number().int().min(1).max(2147483648).default(536870912) }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsArchiveCreate(input));

  register(server, "workbench.fs_archive_extract", {
    title: "Workbench Extract Tar Archive",
    description: "Extract .tar/.tar.gz/.tgz content into a new authority-bounded directory after rejecting absolute paths, parent traversal, symlink entries, and hardlink entries.",
    inputSchema: z.object({ archive: filePath, destination: filePath, cwd, maxEntries: z.number().int().min(1).max(100000).default(100000), maxBytes: z.number().int().min(1).max(2147483648).default(536870912) }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsArchiveExtract(input));

  register(server, "workbench.fs_delete_tree_plan", {
    title: "Plan Recursive Directory Delete",
    description: "Scan a directory tree, refuse symlinks/critical system directories, and return a one-runtime planRef plus strong content digest. This plans an operation; it does not grant temporary authority.",
    inputSchema: z.object({ path: filePath, cwd, maxEntries: z.number().int().min(1).max(100000).default(100000) }).strict(),
    annotations: readOnly(false),
  }, (input) => workbench.fsGit.fsDeleteTreePlan(input));

  register(server, "workbench.fs_delete_tree_commit", {
    title: "Commit Planned Recursive Delete",
    description: "Execute one reviewed recursive-delete plan only when confirmedDelete=true and a fresh rescan exactly matches the planned digest. Plan refs are one-runtime/one-use and never widen permissions.",
    inputSchema: z.object({ planRef: z.string().min(1).max(128), cwd, confirmedDelete: z.boolean().default(false) }).strict(),
    annotations: writeTool(),
  }, (input) => workbench.fsGit.fsDeleteTreeCommit(input));

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
      secretEnv,
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

    register(server, "workbench.browser_back", {
      title: "Workbench Navigate Chrome Back",
      description: "Navigate one known Chrome tab backward in its browser history without replaying any other browser action.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.backTab(input));

    register(server, "workbench.browser_forward", {
      title: "Workbench Navigate Chrome Forward",
      description: "Navigate one known Chrome tab forward in its browser history.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.forwardTab(input));

    register(server, "workbench.browser_dialog", {
      title: "Workbench Handle Chrome JavaScript Dialog",
      description: "Observe, dismiss, or accept an active JavaScript confirm/prompt dialog. Alert/beforeunload acceptance is refused when the browser backend exposes dismiss only.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), action: z.enum(["observe", "accept", "dismiss"]).default("observe"), text: z.string().max(200000).default(""), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.dialogTab(input));

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

    register(server, "workbench.browser_query", {
      title: "Workbench Query Chrome DOM",
      description: "Read rendered text for zero, one, or many DOM elements using a semantic locator. This is read-only and is suitable for polling dynamic UIs without requiring unique matches.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), locator: browserLocator, index: browserIndex, cwd, maxChars: z.number().int().min(1000).max(500000).default(100000) }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.browser.queryTab(input));

    register(server, "workbench.browser_upload", {
      title: "Workbench Upload Local Files in Chrome",
      description: "Upload 1-20 authority-bounded regular local files through a real browser file chooser. Symlinks and paths outside the current Codex trusted root are refused.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), locator: browserLocator, paths: z.array(z.string().min(1).max(32768)).min(1).max(20), index: browserIndex, cwd, timeoutMs: browserTimeout.default(15000) }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.uploadTab(input));

    register(server, "workbench.browser_download", {
      title: "Workbench Download Chrome File",
      description: "Trigger one browser download and copy the downloaded bytes to an authority-bounded local output path. Existing destinations are refused unless overwrite=true.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), locator: browserLocator, outputPath: z.string().min(1).max(32768), index: browserIndex, cwd, timeoutMs: browserTimeout.default(30000), overwrite: z.boolean().default(false) }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.downloadTab(input));

    register(server, "workbench.browser_close", {
      title: "Workbench Close Created Chrome Tab",
      description: "Close only a Chrome tab created by workbench.browser_open. Existing user tabs are deliberately refused.",
      inputSchema: z.object({ tabRef: z.string().min(1).max(256), cwd }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.browser.closeCreatedTab(input));
  }

  if (workbench.proBridge) {
    register(server, "workbench.pro_bridge_start", {
      title: "Start ChatGPT Web Pro Reasoning",
      description: "Open a dedicated authenticated ChatGPT Web tab and submit an authorized reasoning task using the visibly available subscription thinking level (default Pro). This route uses the user's ChatGPT Web subscription, not the OpenAI API, and starts no Codex model turn.",
      inputSchema: z.object({ prompt: z.string().min(1).max(180000), thinking: z.enum(["极速", "中", "高", "极高", "Pro"]).default("Pro"), files: z.array(z.string().min(1).max(32768)).max(20).default([]), cwd, title: z.string().max(500).nullable().default(null) }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.proBridge.start(input));
    register(server, "workbench.pro_bridge_status", {
      title: "Poll ChatGPT Web Pro Reasoning",
      description: "Poll one dedicated ChatGPT Web reasoning task and return only newly generated assistant output when complete. It never re-sends an uncertain request.",
      inputSchema: z.object({ bridgeRef: z.string().min(1).max(128), cwd }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.proBridge.status(input));
    register(server, "workbench.pro_bridge_close", {
      title: "Close ChatGPT Web Pro Bridge Tab",
      description: "Close only the dedicated Workbench-created ChatGPT Web tab for one Pro Bridge task while preserving its persisted task record.",
      inputSchema: z.object({ bridgeRef: z.string().min(1).max(128) }).strict(),
      annotations: browserMutationTool(),
    }, (input) => workbench.proBridge.close(input));
  }

  if (workbench.workflow) {
    const workflowSteps = z.array(z.object({
      id: z.string().min(1).max(64).optional(),
      type: z.enum(WORKFLOW_STEP_TYPES),
      args: z.record(z.string(), z.unknown()).default({}),
    }).strict()).min(1).max(50);
    register(server, "workbench.workflow_prepare", {
      title: "Prepare Persistent Workflow",
      description: "Persist a 1-50 step workflow rooted at a permanent authority alias. Step outcomes are checkpointed immediately so successful mutations are never replayed after failure or restart.",
      inputSchema: z.object({ title: z.string().max(500).default("workflow"), rootAlias: z.string().min(1).max(64), basePath: z.string().min(1).max(32768).default("."), steps: workflowSteps }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.workflow.prepare(input));
    register(server, "workbench.workflow_run", {
      title: "Run Persistent Workflow",
      description: "Continue a prepared workflow from its first unfinished step. Pro Web reasoning steps enter waiting state and are polled later; uncertain mutations are never automatically replayed.",
      inputSchema: z.object({ workflowRef: z.string().min(1).max(128), maxSteps: z.number().int().min(1).max(50).default(10) }).strict(),
      annotations: processTool(),
    }, (input) => workbench.workflow.run(input));
    register(server, "workbench.workflow_status", {
      title: "Read Workflow Status",
      description: "Read durable workflow step states and bounded results without executing another step.",
      inputSchema: z.object({ workflowRef: z.string().min(1).max(128) }).strict(),
      annotations: readOnly(true),
    }, (input) => workbench.workflow.status(input));
    register(server, "workbench.workflow_cancel", {
      title: "Cancel Workflow",
      description: "Mark a workflow canceled so later run calls do not execute more steps. Already completed side effects are preserved and are not rolled back implicitly.",
      inputSchema: z.object({ workflowRef: z.string().min(1).max(128) }).strict(),
      annotations: writeTool(),
    }, (input) => workbench.workflow.cancel(input));

    if (workbench.executionManifest) {
      register(server, "workbench.execution_prepare", {
        title: "Prepare Pro Execution Manifest",
        description: "Persist a codexzxm-pro-execution-manifest-v1 plan using permanent root aliases. There is no temporary permission lease and no API route in this protocol.",
        inputSchema: z.object({
          title: z.string().max(500).default("execution"),
          rootAlias: z.string().min(1).max(64),
          basePath: z.string().min(1).max(32768).default("."),
          steps: workflowSteps,
          assumptions: z.array(z.string().max(10000)).max(100).default([]),
          verification: z.array(z.string().max(10000)).max(100).default([]),
          rollback: z.record(z.string(), z.unknown()).nullable().default(null),
          source: z.string().max(100).default("manual"),
        }).strict(),
        annotations: writeTool(),
      }, (input) => workbench.executionManifest.prepare(input));
      register(server, "workbench.execution_validate", {
        title: "Validate Pro Execution Manifest",
        description: "Validate a manifest's permanent root authority and workflow definition immediately before execution.",
        inputSchema: z.object({ manifestRef: z.string().min(1).max(128) }).strict(),
        annotations: readOnly(false),
      }, (input) => workbench.executionManifest.validate(input));
      register(server, "workbench.execution_run", {
        title: "Run Pro Execution Manifest",
        description: "Compile a validated Pro execution manifest into a durable workflow and continue it without replaying completed mutations.",
        inputSchema: z.object({ manifestRef: z.string().min(1).max(128), maxSteps: z.number().int().min(1).max(50).default(10) }).strict(),
        annotations: processTool(),
      }, (input) => workbench.executionManifest.run(input));
      register(server, "workbench.execution_status", {
        title: "Read Pro Execution Manifest Status",
        description: "Read manifest validation and its underlying durable workflow state.",
        inputSchema: z.object({ manifestRef: z.string().min(1).max(128) }).strict(),
        annotations: readOnly(true),
      }, (input) => workbench.executionManifest.status(input));
    }
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
