import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkbenchFsGit } from "../src/workbench-fs-git.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const fixture = path.join(projectRoot, "test", ".git-hardening-fixture");

async function rawGit(args) {
  const result = await execFileAsync("git", args, { cwd: fixture, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const authorityExecutor = {
  async resolveAuthority({ cwd = fixture, access = "readOnly" } = {}) {
    return {
      effectiveCwd: path.resolve(cwd),
      trustedAncestor: fixture,
      permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
      permissionCeiling: ":danger-full-access",
      authoritySource: "git-hardening-unit",
    };
  },
  async exec({ command, cwd = fixture, access = "readOnly", timeoutMs = 30_000 }) {
    try {
      const result = await execFileAsync(command[0], command.slice(1), { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      return {
        exitCode: 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        stdoutTruncated: false,
        stderrTruncated: false,
        effectiveCwd: path.resolve(cwd),
        permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
        trustedAncestor: fixture,
      };
    } catch (error) {
      return {
        exitCode: Number.isInteger(error?.code) ? error.code : 1,
        stdout: error?.stdout ?? "",
        stderr: error?.stderr ?? error?.message ?? String(error),
        stdoutTruncated: false,
        stderrTruncated: false,
        effectiveCwd: path.resolve(cwd),
        permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
        trustedAncestor: fixture,
      };
    }
  },
};

await rm(fixture, { recursive: true, force: true });
await mkdir(fixture, { recursive: true });
try {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: fixture, windowsHide: true });
  await rawGit(["config", "user.name", "Codexzxm Git Test"]);
  await rawGit(["config", "user.email", "git-hardening@test.invalid"]);
  await rawGit(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(fixture, "tracked.txt"), "base\n", "utf8");
  await rawGit(["add", "tracked.txt"]);
  await rawGit(["commit", "-q", "-m", "baseline"]);

  const workbench = new WorkbenchFsGit({ authorityExecutor });
  const branches = await workbench.gitBranches({ cwd: fixture });
  assert.equal(branches.exitCode, 0);
  assert.match(branches.stdout, /main/);

  const created = await workbench.gitSwitch({ cwd: fixture, branch: "feature/hardening", create: true, startPoint: "main" });
  assert.equal(created.exitCode, 0);
  const branchNow = (await rawGit(["branch", "--show-current"])).stdout.trim();
  assert.equal(branchNow, "feature/hardening");

  await writeFile(path.join(fixture, "tracked.txt"), "changed\n", "utf8");
  await writeFile(path.join(fixture, "new.txt"), "new\n", "utf8");
  const stashed = await workbench.gitStashPush({ cwd: fixture, message: "hardening", includeUntracked: true });
  assert.equal(stashed.exitCode, 0);
  assert.equal(await readFile(path.join(fixture, "tracked.txt"), "utf8"), "base\n");

  const stashList = await workbench.gitStashList({ cwd: fixture, count: 10 });
  assert.equal(stashList.exitCode, 0);
  assert.match(stashList.stdout, /hardening/);

  const popped = await workbench.gitStashPop({ cwd: fixture, stashRef: "stash@{0}" });
  assert.equal(popped.exitCode, 0);
  assert.equal(await readFile(path.join(fixture, "tracked.txt"), "utf8"), "changed\n");
  assert.equal(await readFile(path.join(fixture, "new.txt"), "utf8"), "new\n");

  await assert.rejects(workbench.gitSwitch({ cwd: fixture, branch: "--detach", create: false }), /invalid git branch/);
  await assert.rejects(workbench.gitFetch({ cwd: fixture, remote: "--upload-pack=evil", prune: true }), /invalid git remote/);

  console.log("Workbench Git hardening contract passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
