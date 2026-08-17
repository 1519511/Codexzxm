import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1;
const MAX_LOGS = 2000;
const MAX_TASKS = 1000;
const MAX_SNAPSHOTS = 100;
const MAX_UNTRACKED_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const STATE_LOCK_WAIT_MS = 5_000;
const STATE_LOCK_STALE_MS = 30_000;
const TASK_STATUSES = new Set(["todo", "doing", "blocked", "done"]);

export class WorkbenchWorkspaceManager {
  constructor({ authorityExecutor, processManager = null, stateDir, defaultCwd }) {
    if (!authorityExecutor) throw new Error("WorkbenchWorkspaceManager requires authorityExecutor");
    if (!stateDir) throw new Error("WorkbenchWorkspaceManager requires stateDir");
    if (!defaultCwd) throw new Error("WorkbenchWorkspaceManager requires defaultCwd");
    this.authorityExecutor = authorityExecutor;
    this.processManager = processManager;
    this.stateDir = path.resolve(stateDir);
    this.stateFile = path.join(this.stateDir, "workspaces.json");
    this.stateBackupFile = path.join(this.stateDir, "workspaces.json.bak");
    this.stateLockDir = path.join(this.stateDir, ".state-lock");
    this.snapshotsDir = path.join(this.stateDir, "snapshots");
    this.defaultCwd = path.resolve(defaultCwd);
    this.loaded = false;
    this.stateRecoveredFromBackup = false;
    this.workspaces = new Map();
  }

  async create({ name = null, cwd = this.defaultCwd } = {}) {
    await this.#ensureLoaded();
    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
    const effectiveCwd = await realpath(authority.effectiveCwd);
    for (const workspace of this.workspaces.values()) {
      if (samePath(workspace.cwd, effectiveCwd)) return { ...publicWorkspace(workspace), duplicate: true };
    }
    const now = new Date().toISOString();
    const workspace = {
      workspaceRef: `workspace_${randomUUID()}`,
      name: typeof name === "string" && name.trim() ? name.trim() : path.basename(effectiveCwd),
      cwd: effectiveCwd,
      trustedAncestor: authority.trustedAncestor ?? effectiveCwd,
      createdAt: now,
      updatedAt: now,
      tasks: [],
      logs: [],
      snapshots: [],
    };
    this.workspaces.set(workspace.workspaceRef, workspace);
    appendLog(workspace, "workspace", "Workspace created", { cwd: effectiveCwd });
    await this.#persist();
    return publicWorkspace(workspace);
  }

  async list({ query = "", limit = 100 } = {}) {
    await this.#ensureLoaded();
    const needle = String(query ?? "").trim().toLowerCase();
    const rows = [...this.workspaces.values()]
      .filter((workspace) => !needle || `${workspace.name} ${workspace.cwd}`.toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, clamp(limit, 1, 1000, 100))
      .map(publicWorkspace);
    return { count: rows.length, stateRecoveredFromBackup: this.stateRecoveredFromBackup, workspaces: rows };
  }

  async inspect({ workspaceRef } = {}) {
    const workspace = await this.#requireWorkspace(workspaceRef);
    await this.#resolveWorkspaceAuthority(workspace, "readOnly");
    const changed = await this.#changedFilesInternal(workspace).catch((error) => ({ git: false, error: error.message, raw: "", files: [] }));
    const processList = this.processManager?.list ? await this.processManager.list() : { processes: [] };
    const processes = processList.processes?.filter((row) => samePath(row.cwd, workspace.cwd)) ?? [];
    return {
      ...publicWorkspace(workspace),
      tasks: workspace.tasks.map((task) => ({ ...task })),
      recentLogs: workspace.logs.slice(-50).map((entry) => structuredClone(entry)),
      snapshots: workspace.snapshots.map((snapshot) => publicSnapshot(snapshot)),
      changedFiles: changed,
      processes,
    };
  }

  async changedFiles({ workspaceRef } = {}) {
    const workspace = await this.#requireWorkspace(workspaceRef);
    await this.#resolveWorkspaceAuthority(workspace, "readOnly");
    return this.#changedFilesInternal(workspace);
  }

  async taskUpsert({ workspaceRef, taskId = null, title, status = "todo", details = null } = {}) {
    const workspace = await this.#requireWorkspace(workspaceRef);
    requireString(title, "title");
    if (!TASK_STATUSES.has(status)) throw workspaceError("WORKSPACE_TASK_STATUS_INVALID", "task status must be todo, doing, blocked, or done");
    const now = new Date().toISOString();
    let task;
    if (taskId) {
      task = workspace.tasks.find((row) => row.taskId === taskId);
      if (!task) throw workspaceError("WORKSPACE_TASK_NOT_FOUND", `unknown taskId: ${taskId}`);
      task.title = title.trim();
      task.status = status;
      task.details = details === null ? null : String(details);
      task.updatedAt = now;
    } else {
      if (workspace.tasks.length >= MAX_TASKS) throw workspaceError("WORKSPACE_TASK_LIMIT", `workspace task limit reached (${MAX_TASKS})`);
      task = {
        taskId: `task_${randomUUID()}`,
        title: title.trim(),
        status,
        details: details === null ? null : String(details),
        createdAt: now,
        updatedAt: now,
      };
      workspace.tasks.push(task);
    }
    touch(workspace);
    appendLog(workspace, "task", `Task ${taskId ? "updated" : "created"}: ${task.title}`, { taskId: task.taskId, status: task.status });
    await this.#persist();
    return { ...task };
  }

  async tasks({ workspaceRef, status = null } = {}) {
    const workspace = await this.#requireWorkspace(workspaceRef);
    if (status !== null && !TASK_STATUSES.has(status)) throw workspaceError("WORKSPACE_TASK_STATUS_INVALID", "task status must be todo, doing, blocked, or done");
    const tasks = workspace.tasks.filter((task) => status === null || task.status === status).map((task) => ({ ...task }));
    return { workspaceRef: workspace.workspaceRef, count: tasks.length, tasks };
  }

  async logAppend({ workspaceRef, kind = "note", message, metadata = null } = {}) {
    const workspace = await this.#requireWorkspace(workspaceRef);
    const text = requireString(message, "message");
    const entry = appendLog(workspace, String(kind || "note"), text, metadata && typeof metadata === "object" ? structuredClone(metadata) : null);
    touch(workspace);
    await this.#persist();
    return structuredClone(entry);
  }

  async logs({ workspaceRef, after = null, limit = 100 } = {}) {
    const workspace = await this.#requireWorkspace(workspaceRef);
    const rows = workspace.logs
      .filter((entry) => after === null || entry.at > after)
      .slice(-clamp(limit, 1, 1000, 100))
      .map((entry) => structuredClone(entry));
    return { workspaceRef: workspace.workspaceRef, count: rows.length, logs: rows };
  }

  async snapshot({ workspaceRef, label = "snapshot" } = {}) {
    const workspace = await this.#requireWorkspace(workspaceRef);
    return publicSnapshot(await this.#createSnapshot(workspace, label));
  }

  async restore({ workspaceRef, snapshotId, confirmedRestore = false, overwriteUntracked = false } = {}) {
    if (confirmedRestore !== true) {
      throw workspaceError("WORKSPACE_RESTORE_CONFIRMATION_REQUIRED", "restore is destructive to current tracked changes; retry with confirmedRestore=true only for an explicitly requested restore");
    }
    const workspace = await this.#requireWorkspace(workspaceRef);
    const authority = await this.#resolveWorkspaceAuthority(workspace, "inherit");
    requireDirectWriteAuthority(authority);
    const target = workspace.snapshots.find((snapshot) => snapshot.snapshotId === snapshotId);
    if (!target) throw workspaceError("WORKSPACE_SNAPSHOT_NOT_FOUND", `unknown snapshotId: ${snapshotId}`);
    await this.#preflightRestore(workspace, target, { overwriteUntracked });
    const backup = await this.#createSnapshot(workspace, `auto-before-restore:${snapshotId}`);
    try {
      await this.#applySnapshot(workspace, target, { overwriteUntracked });
      touch(workspace);
      appendLog(workspace, "restore", `Restored snapshot ${snapshotId}`, { snapshotId, preRestoreSnapshotId: backup.snapshotId });
      await this.#persist();
      return {
        status: "restored",
        workspaceRef: workspace.workspaceRef,
        snapshot: publicSnapshot(target),
        preRestoreSnapshot: publicSnapshot(backup),
        preservedOtherUntrackedFiles: true,
      };
    } catch (error) {
      let rollbackError = null;
      try {
        await this.#applySnapshot(workspace, backup, { overwriteUntracked: true });
        appendLog(workspace, "restore", `Restore ${snapshotId} failed and pre-restore snapshot was reapplied`, { snapshotId, preRestoreSnapshotId: backup.snapshotId, error: error.message });
        await this.#persist();
      } catch (rollback) {
        rollbackError = rollback;
      }
      if (rollbackError) {
        throw new AggregateError([error, rollbackError], `restore failed and automatic rollback also failed: ${error.message}; rollback: ${rollbackError.message}`);
      }
      throw workspaceError("WORKSPACE_RESTORE_FAILED_ROLLED_BACK", `restore failed; pre-restore snapshot ${backup.snapshotId} was reapplied. Original error: ${error.message}`);
    }
  }

  async #changedFilesInternal(workspace) {
    const repo = await this.#repoInfo(workspace, "readOnly");
    const result = await runGit(repo.root, ["status", "--short", "--untracked-files=all"], { timeoutMs: 30_000 });
    const raw = result.stdout;
    const files = raw.split(/\r?\n/).filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
    return { git: true, root: repo.root, head: repo.head, raw, files };
  }

  async #createSnapshot(workspace, label) {
    await this.#ensureLoaded();
    const repo = await this.#repoInfo(workspace, "readOnly");
    const snapshotId = `snapshot_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const tmpDir = path.join(this.snapshotsDir, workspace.workspaceRef, `${snapshotId}.tmp`);
    const finalDir = path.join(this.snapshotsDir, workspace.workspaceRef, snapshotId);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(path.join(tmpDir, "untracked"), { recursive: true });

    try {
      const [statusResult, stagedResult, unstagedResult, untrackedResult] = await Promise.all([
        runGit(repo.root, ["status", "--short", "--untracked-files=all"], { timeoutMs: 30_000 }),
        runGit(repo.root, ["diff", "--binary", "--cached", "HEAD", "--", "."], { timeoutMs: 30_000 }),
        runGit(repo.root, ["diff", "--binary", "--", "."], { timeoutMs: 30_000 }),
        runGitBuffer(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"], { timeoutMs: 30_000 }),
      ]);
      const stagedPatch = stagedResult.stdout;
      const unstagedPatch = unstagedResult.stdout;
      await writeFile(path.join(tmpDir, "staged.patch"), stagedPatch, "utf8");
      await writeFile(path.join(tmpDir, "unstaged.patch"), unstagedPatch, "utf8");

      const names = untrackedResult.toString("utf8").split("\u0000").filter(Boolean);
      const manifest = [];
      let totalBytes = 0;
      for (const relative of names) {
        const rel = safeRelativePath(relative);
        const source = path.resolve(repo.root, rel);
        const sourceLstat = await lstat(source);
        if (sourceLstat.isSymbolicLink()) throw workspaceError("WORKSPACE_SNAPSHOT_SYMLINK_REFUSED", `untracked symlink refused: ${rel}`);
        const canonical = await realpath(source);
        assertWithin(repo.root, canonical);
        const info = await stat(canonical);
        if (!info.isFile()) continue;
        if (info.size > MAX_UNTRACKED_FILE_BYTES) throw workspaceError("WORKSPACE_SNAPSHOT_FILE_TOO_LARGE", `untracked file exceeds ${MAX_UNTRACKED_FILE_BYTES} bytes: ${rel}`);
        totalBytes += info.size;
        if (totalBytes > MAX_UNTRACKED_TOTAL_BYTES) throw workspaceError("WORKSPACE_SNAPSHOT_TOO_LARGE", `untracked snapshot exceeds ${MAX_UNTRACKED_TOTAL_BYTES} bytes total`);
        const destination = path.join(tmpDir, "untracked", rel);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(canonical, destination);
        manifest.push({ path: rel, size: info.size, sha256: sha256(await readFile(canonical)) });
      }
      await writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify({ version: 1, untracked: manifest }, null, 2), "utf8");
      await mkdir(path.dirname(finalDir), { recursive: true });
      await rename(tmpDir, finalDir);

      const snapshot = {
        snapshotId,
        label: String(label ?? "snapshot").slice(0, 500),
        createdAt,
        head: repo.head,
        gitRoot: repo.root,
        status: statusResult.stdout,
        stagedPatchBytes: Buffer.byteLength(stagedPatch, "utf8"),
        stagedPatchSha256: sha256(Buffer.from(stagedPatch, "utf8")),
        unstagedPatchBytes: Buffer.byteLength(unstagedPatch, "utf8"),
        unstagedPatchSha256: sha256(Buffer.from(unstagedPatch, "utf8")),
        untrackedCount: manifest.length,
        untrackedBytes: totalBytes,
        directory: finalDir,
      };
      workspace.snapshots.push(snapshot);
      while (workspace.snapshots.length > MAX_SNAPSHOTS) {
        const removed = workspace.snapshots.shift();
        await rm(removed.directory, { recursive: true, force: true }).catch(() => {});
      }
      touch(workspace);
      appendLog(workspace, "snapshot", `Snapshot created: ${snapshot.label}`, { snapshotId, head: repo.head, untrackedCount: manifest.length });
      await this.#persist();
      return snapshot;
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async #preflightRestore(workspace, snapshot, { overwriteUntracked }) {
    const repo = await this.#repoInfo(workspace, "inherit");
    if (!samePath(repo.root, snapshot.gitRoot)) throw workspaceError("WORKSPACE_RESTORE_REPO_CHANGED", "snapshot Git root no longer matches workspace repository root");
    if (repo.head !== snapshot.head) throw workspaceError("WORKSPACE_RESTORE_HEAD_CHANGED", `snapshot was captured at ${snapshot.head}, current HEAD is ${repo.head}`);
    const manifest = await readSnapshotManifest(snapshot);
    for (const entry of manifest.untracked) {
      const target = path.resolve(repo.root, safeRelativePath(entry.path));
      assertWithin(repo.root, target);
      try {
        const info = await stat(target);
        if (!info.isFile()) {
          if (!overwriteUntracked) throw workspaceError("WORKSPACE_RESTORE_UNTRACKED_COLLISION", `snapshot untracked path collides with non-file: ${entry.path}`);
          continue;
        }
        const currentHash = sha256(await readFile(target));
        if (currentHash !== entry.sha256 && !overwriteUntracked) {
          throw workspaceError("WORKSPACE_RESTORE_UNTRACKED_COLLISION", `current file differs from snapshot untracked file: ${entry.path}; retry with overwriteUntracked=true if intentional`);
        }
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }
  }

  async #applySnapshot(workspace, snapshot, { overwriteUntracked }) {
    const authority = await this.#resolveWorkspaceAuthority(workspace, "inherit");
    requireDirectWriteAuthority(authority);
    const repo = await this.#repoInfo(workspace, "inherit");
    if (repo.head !== snapshot.head) throw workspaceError("WORKSPACE_RESTORE_HEAD_CHANGED", `snapshot HEAD ${snapshot.head} differs from current HEAD ${repo.head}`);
    const stagedPatch = path.join(snapshot.directory, "staged.patch");
    const unstagedPatch = path.join(snapshot.directory, "unstaged.patch");
    const manifest = await readSnapshotManifest(snapshot);

    await runGit(repo.root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."], { timeoutMs: 60_000 });
    if ((await stat(stagedPatch)).size > 0) await runGit(repo.root, ["apply", "--binary", "--index", "--whitespace=nowarn", stagedPatch], { timeoutMs: 60_000 });
    if ((await stat(unstagedPatch)).size > 0) await runGit(repo.root, ["apply", "--binary", "--whitespace=nowarn", unstagedPatch], { timeoutMs: 60_000 });

    for (const entry of manifest.untracked) {
      const rel = safeRelativePath(entry.path);
      const source = path.join(snapshot.directory, "untracked", rel);
      const target = path.resolve(repo.root, rel);
      assertWithin(repo.root, target);
      try {
        const info = await stat(target);
        if (info.isFile()) {
          const currentHash = sha256(await readFile(target));
          if (currentHash !== entry.sha256 && !overwriteUntracked) throw workspaceError("WORKSPACE_RESTORE_UNTRACKED_COLLISION", `current file differs from snapshot: ${rel}`);
        } else if (!overwriteUntracked) {
          throw workspaceError("WORKSPACE_RESTORE_UNTRACKED_COLLISION", `current non-file occupies snapshot path: ${rel}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }

  async #repoInfo(workspace, accessMode) {
    await this.#resolveWorkspaceAuthority(workspace, accessMode);
    const rootResult = await runGit(workspace.cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 15_000 });
    const root = await realpath(rootResult.stdout.trim());
    const cwd = await realpath(workspace.cwd);
    if (!samePath(root, cwd)) throw workspaceError("WORKSPACE_SNAPSHOT_REPO_ROOT_REQUIRED", `V5 snapshot/restore currently requires workspace cwd to be the Git repository root; repo root is ${root}`);
    const headResult = await runGit(root, ["rev-parse", "HEAD"], { timeoutMs: 15_000 });
    return { root, head: headResult.stdout.trim() };
  }

  async #resolveWorkspaceAuthority(workspace, accessMode) {
    const authority = await this.authorityExecutor.resolveAuthority({ cwd: workspace.cwd, access: accessMode });
    const effective = await realpath(authority.effectiveCwd);
    if (!samePath(effective, workspace.cwd)) throw workspaceError("WORKSPACE_AUTHORITY_DRIFT", `workspace authority resolved to a different cwd: ${effective}`);
    return authority;
  }

  async #requireWorkspace(workspaceRef) {
    await this.#ensureLoaded();
    const ref = requireString(workspaceRef, "workspaceRef");
    const workspace = this.workspaces.get(ref);
    if (!workspace) throw workspaceError("WORKSPACE_NOT_FOUND", `unknown workspaceRef: ${ref}`);
    return workspace;
  }

  async #ensureLoaded() {
    if (this.loaded) return;
    await mkdir(this.snapshotsDir, { recursive: true });
    let parsed = null;
    let primaryError = null;
    try {
      parsed = await readWorkspaceStateFile(this.stateFile);
    } catch (error) {
      if (error?.code !== "ENOENT") primaryError = error;
    }
    if (primaryError) {
      try {
        parsed = await readWorkspaceStateFile(this.stateBackupFile);
        this.stateRecoveredFromBackup = true;
      } catch (backupError) {
        throw workspaceError(
          "WORKSPACE_STATE_CORRUPT",
          `primary workspace state is corrupt (${primaryError.message}) and backup recovery failed (${backupError.message})`
        );
      }
    }
    if (parsed !== null) {
      validateWorkspaceStatePayload(parsed);
      for (const raw of parsed.workspaces) {
        if (!raw || typeof raw.workspaceRef !== "string" || typeof raw.cwd !== "string") continue;
        raw.tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
        raw.logs = Array.isArray(raw.logs) ? raw.logs : [];
        raw.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
        this.workspaces.set(raw.workspaceRef, raw);
      }
    }
    this.loaded = true;
    if (this.stateRecoveredFromBackup && parsed !== null) {
      await this.#writeStatePayload(parsed, { backupCurrent: false });
    }
  }

  async #persist() {
    await mkdir(this.stateDir, { recursive: true });
    const payload = { version: STATE_VERSION, workspaces: [...this.workspaces.values()] };
    await this.#writeStatePayload(payload, { backupCurrent: true });
  }

  async #writeStatePayload(payload, { backupCurrent }) {
    validateWorkspaceStatePayload(payload);
    await this.#withStateLock(async () => {
      if (backupCurrent) {
        try {
          const current = await readWorkspaceStateFile(this.stateFile);
          validateWorkspaceStatePayload(current);
          await copyFile(this.stateFile, this.stateBackupFile);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            // A corrupt primary must never replace the last known-good backup.
          }
        }
      }
      const tmp = `${this.stateFile}.tmp-${randomUUID()}`;
      await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.stateFile);
      try {
        await readWorkspaceStateFile(this.stateBackupFile);
      } catch (error) {
        if (error?.code === "ENOENT") await copyFile(this.stateFile, this.stateBackupFile);
      }
    });
  }

  async #withStateLock(task) {
    const deadline = Date.now() + STATE_LOCK_WAIT_MS;
    await mkdir(this.stateDir, { recursive: true });
    while (true) {
      try {
        await mkdir(this.stateLockDir);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const info = await stat(this.stateLockDir);
          if (Date.now() - info.mtimeMs > STATE_LOCK_STALE_MS) {
            await rm(this.stateLockDir, { recursive: true, force: true });
            continue;
          }
        } catch {}
        if (Date.now() >= deadline) throw workspaceError("WORKSPACE_STATE_LOCK_TIMEOUT", "timed out waiting for workspace state lock");
        await sleep(50);
      }
    }
    try {
      return await task();
    } finally {
      await rm(this.stateLockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function readWorkspaceStateFile(file) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  validateWorkspaceStatePayload(parsed);
  return parsed;
}

function validateWorkspaceStatePayload(parsed) {
  if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.workspaces)) {
    throw workspaceError("WORKSPACE_STATE_CORRUPT", "unsupported or invalid workspace state schema");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSnapshotManifest(snapshot) {
  const parsed = JSON.parse(await readFile(path.join(snapshot.directory, "manifest.json"), "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.untracked)) throw workspaceError("WORKSPACE_SNAPSHOT_CORRUPT", `invalid manifest for ${snapshot.snapshotId}`);
  return parsed;
}

async function runGit(cwd, args, { timeoutMs = 30_000 } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    throw workspaceError("WORKSPACE_GIT_ERROR", `git ${args.join(" ")} failed: ${error?.stderr ?? error?.message ?? String(error)}`);
  }
}

async function runGitBuffer(cwd, args, { timeoutMs = 30_000 } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "buffer",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  } catch (error) {
    throw workspaceError("WORKSPACE_GIT_ERROR", `git ${args.join(" ")} failed: ${Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : error?.stderr ?? error?.message ?? String(error)}`);
  }
}

function publicWorkspace(workspace) {
  return {
    workspaceRef: workspace.workspaceRef,
    name: workspace.name,
    cwd: workspace.cwd,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    taskCount: workspace.tasks.length,
    openTaskCount: workspace.tasks.filter((task) => task.status !== "done").length,
    logCount: workspace.logs.length,
    snapshotCount: workspace.snapshots.length,
  };
}

function publicSnapshot(snapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    label: snapshot.label,
    createdAt: snapshot.createdAt,
    head: snapshot.head,
    status: snapshot.status,
    stagedPatchBytes: snapshot.stagedPatchBytes,
    unstagedPatchBytes: snapshot.unstagedPatchBytes,
    untrackedCount: snapshot.untrackedCount,
    untrackedBytes: snapshot.untrackedBytes,
  };
}

function appendLog(workspace, kind, message, metadata = null) {
  const entry = {
    logId: `log_${randomUUID()}`,
    at: new Date().toISOString(),
    kind: String(kind || "note"),
    message: String(message),
    metadata: metadata === null ? null : structuredClone(metadata),
  };
  workspace.logs.push(entry);
  while (workspace.logs.length > MAX_LOGS) workspace.logs.shift();
  return entry;
}

function touch(workspace) {
  workspace.updatedAt = new Date().toISOString();
}

function safeRelativePath(value) {
  const rel = String(value).replaceAll("/", path.sep);
  if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) throw workspaceError("WORKSPACE_PATH_REFUSED", `unsafe repository-relative path: ${value}`);
  return rel;
}

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw workspaceError("WORKSPACE_PATH_REFUSED", `path escapes workspace root: ${target}`);
}

function requireDirectWriteAuthority(authority) {
  if (authority?.permissionProfile !== ":danger-full-access") throw workspaceError("WORKSPACE_WRITE_AUTHORITY_REQUIRED", `snapshot restore requires :danger-full-access authority; resolved ${String(authority?.permissionProfile)}`);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw workspaceError("WORKSPACE_ARGUMENT_INVALID", `${name} must be a non-empty string`);
  return value.trim();
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
