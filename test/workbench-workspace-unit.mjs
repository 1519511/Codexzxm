import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkbenchWorkspaceManager } from "../src/workbench-workspaces.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const fixture = path.join(projectRoot, "test", ".workspace-v5-fixture");
const stateDir = path.join(projectRoot, "test", ".workspace-v5-state");

async function git(args) {
  const result = await execFileAsync("git", args, {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(result.stdout ?? "").trim();
}

const authorityExecutor = {
  async resolveAuthority({ cwd = fixture, access = "readOnly" } = {}) {
    const effectiveCwd = path.resolve(cwd);
    assert.equal(effectiveCwd, fixture);
    return {
      effectiveCwd,
      trustedAncestor: fixture,
      permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
      permissionCeiling: ":danger-full-access",
      authoritySource: "workspace-v5-unit",
    };
  },
};

await rm(fixture, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
await mkdir(fixture, { recursive: true });

try {
  await execFileAsync("git", ["init", "-q"], { cwd: fixture, windowsHide: true });
  await git(["config", "user.name", "Workspace V5 Test"]);
  await git(["config", "user.email", "workspace-v5@test.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(fixture, "tracked.txt"), "base\n", "utf8");
  await git(["add", "tracked.txt"]);
  await git(["commit", "-q", "-m", "baseline"]);

  const manager = new WorkbenchWorkspaceManager({ authorityExecutor, stateDir, defaultCwd: fixture });
  const created = await manager.create({ name: "Fixture", cwd: fixture });
  assert.match(created.workspaceRef, /^workspace_/);
  const duplicate = await manager.create({ name: "Ignored duplicate name", cwd: fixture });
  assert.equal(duplicate.workspaceRef, created.workspaceRef);
  assert.equal(duplicate.duplicate, true);

  const task = await manager.taskUpsert({
    workspaceRef: created.workspaceRef,
    title: "Restore exact Git state",
    status: "doing",
    details: "V5 persistence contract",
  });
  assert.match(task.taskId, /^task_/);
  const log = await manager.logAppend({ workspaceRef: created.workspaceRef, kind: "test", message: "before snapshot" });
  assert.match(log.logId, /^log_/);

  await writeFile(path.join(fixture, "tracked.txt"), "staged\n", "utf8");
  await git(["add", "tracked.txt"]);
  await writeFile(path.join(fixture, "tracked.txt"), "unstaged\n", "utf8");
  await writeFile(path.join(fixture, "new.txt"), "snapshot-untracked\n", "utf8");

  const snapshot = await manager.snapshot({ workspaceRef: created.workspaceRef, label: "exact-state" });
  assert.match(snapshot.snapshotId, /^snapshot_/);
  assert.equal(snapshot.untrackedCount, 1);
  assert.equal(snapshot.stagedPatchBytes > 0, true);
  assert.equal(snapshot.unstagedPatchBytes > 0, true);

  await writeFile(path.join(fixture, "tracked.txt"), "later-working\n", "utf8");
  await writeFile(path.join(fixture, "new.txt"), "later-untracked\n", "utf8");
  await writeFile(path.join(fixture, "other.txt"), "preserve-me\n", "utf8");

  const restored = await manager.restore({
    workspaceRef: created.workspaceRef,
    snapshotId: snapshot.snapshotId,
    confirmedRestore: true,
    overwriteUntracked: true,
  });
  assert.equal(restored.status, "restored");
  assert.match(restored.preRestoreSnapshot.snapshotId, /^snapshot_/);

  assert.equal(await readFile(path.join(fixture, "tracked.txt"), "utf8"), "unstaged\n");
  assert.equal(await git(["show", ":tracked.txt"]), "staged");
  assert.equal(await readFile(path.join(fixture, "new.txt"), "utf8"), "snapshot-untracked\n");
  assert.equal(await readFile(path.join(fixture, "other.txt"), "utf8"), "preserve-me\n");

  const status = await git(["status", "--short", "--untracked-files=all"]);
  assert.match(status, /MM tracked\.txt/);
  assert.match(status, /\?\? new\.txt/);
  assert.match(status, /\?\? other\.txt/);

  const changed = await manager.changedFiles({ workspaceRef: created.workspaceRef });
  assert.equal(changed.git, true);
  assert.equal(changed.files.some((row) => row.path === "tracked.txt"), true);

  const second = new WorkbenchWorkspaceManager({ authorityExecutor, stateDir, defaultCwd: fixture });
  const listed = await second.list();
  assert.equal(listed.count, 1);
  assert.equal(listed.workspaces[0].workspaceRef, created.workspaceRef);
  const persistedTasks = await second.tasks({ workspaceRef: created.workspaceRef });
  assert.equal(persistedTasks.tasks.some((row) => row.taskId === task.taskId && row.status === "doing"), true);
  const persistedLogs = await second.logs({ workspaceRef: created.workspaceRef, limit: 1000 });
  assert.equal(persistedLogs.logs.some((row) => row.message === "before snapshot"), true);
  const inspection = await second.inspect({ workspaceRef: created.workspaceRef });
  assert.equal(inspection.snapshots.length >= 2, true);

  await writeFile(path.join(stateDir, "workspaces.json"), "{corrupt-primary", "utf8");
  const recovered = new WorkbenchWorkspaceManager({ authorityExecutor, stateDir, defaultCwd: fixture });
  const recoveredList = await recovered.list();
  assert.equal(recoveredList.stateRecoveredFromBackup, true);
  assert.equal(recoveredList.workspaces.some((row) => row.workspaceRef === created.workspaceRef), true);
  const repairedPrimary = JSON.parse(await readFile(path.join(stateDir, "workspaces.json"), "utf8"));
  assert.equal(repairedPrimary.version, 1);

  console.log("Workbench V5 workspace persistence contract passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}
