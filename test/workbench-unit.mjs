import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkbenchFsGit } from "../src/workbench-fs-git.mjs";
import { WorkbenchProcessManager } from "../src/workbench-process.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const testDirRel = "test/.workbench-v1-unit";
const testDir = path.join(projectRoot, testDirRel);

const authorityExecutor = {
  async resolveAuthority({ cwd = projectRoot, access = "inherit" } = {}) {
    return {
      effectiveCwd: path.resolve(cwd),
      trustedAncestor: projectRoot,
      permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
      permissionCeiling: ":danger-full-access",
      authoritySource: "workbench-unit-test",
    };
  },
  async exec({ command, cwd = projectRoot, access = "readOnly", timeoutMs = 10000 }) {
    try {
      const result = await execFileAsync(command[0], command.slice(1), {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        exitCode: 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        stdoutTruncated: false,
        stderrTruncated: false,
        effectiveCwd: path.resolve(cwd),
        permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
        trustedAncestor: projectRoot,
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
        trustedAncestor: projectRoot,
      };
    }
  },
};

const fsGit = new WorkbenchFsGit({ authorityExecutor });
const processes = new WorkbenchProcessManager({ authorityExecutor });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await rm(testDir, { recursive: true, force: true });
try {
  const made = await fsGit.fsMkdir({ path: testDirRel, cwd: projectRoot });
  assert.equal(made.status, "created");

  const created = await fsGit.fsCreate({ path: `${testDirRel}/alpha.txt`, content: "alpha\n", cwd: projectRoot });
  assert.match(created.sha256, /^[0-9a-f]{64}$/);

  const listed = await fsGit.fsList({ path: testDirRel, cwd: projectRoot });
  assert.equal(listed.entries.some((entry) => entry.name === "alpha.txt" && entry.type === "file"), true);

  const tree = await fsGit.fsTree({ path: "test", cwd: projectRoot, maxDepth: 2, maxEntries: 1000 });
  assert.equal(tree.entries.some((entry) => entry.relativePath.replaceAll("\\", "/").endsWith(".workbench-v1-unit/alpha.txt")), true);

  const read1 = await fsGit.fsRead({ path: `${testDirRel}/alpha.txt`, cwd: projectRoot });
  assert.equal(read1.text, "alpha\n");
  assert.equal(read1.sha256, created.sha256);

  const written = await fsGit.fsWrite({
    path: `${testDirRel}/alpha.txt`,
    content: "beta\nneedle-v1\n",
    expectedSha256: created.sha256,
    cwd: projectRoot,
  });
  assert.notEqual(written.afterSha256, created.sha256);

  await assert.rejects(
    fsGit.fsWrite({
      path: `${testDirRel}/alpha.txt`,
      content: "must-not-write\n",
      expectedSha256: created.sha256,
      cwd: projectRoot,
    }),
    /expectedSha256 does not match/
  );

  const search = await fsGit.projectSearch({ query: "needle-v1", path: testDirRel, cwd: projectRoot, maxMatches: 20 });
  assert.equal(search.matches.some((match) => match.kind === "content" && match.line === 2), true);

  const regexSearch = await fsGit.projectSearch({ query: "needle-v[0-9]+", regex: true, path: testDirRel, cwd: projectRoot, maxMatches: 20 });
  assert.equal(regexSearch.engine, "ripgrep");
  assert.equal(regexSearch.matches.some((match) => match.kind === "content" && match.line === 2), true);

  const moved = await fsGit.fsMove({
    source: `${testDirRel}/alpha.txt`,
    destination: `${testDirRel}/moved.txt`,
    expectedSha256: written.afterSha256,
    cwd: projectRoot,
  });
  assert.equal(moved.status, "moved");

  const read2 = await fsGit.fsRead({ path: `${testDirRel}/moved.txt`, cwd: projectRoot });
  assert.equal(read2.text, "beta\nneedle-v1\n");

  const copied = await fsGit.fsCopy({ source: `${testDirRel}/moved.txt`, destination: `${testDirRel}/copied.txt`, expectedSha256: read2.sha256, cwd: projectRoot });
  assert.equal(copied.status, "copied");
  const copiedRead = await fsGit.fsRead({ path: `${testDirRel}/copied.txt`, cwd: projectRoot });
  assert.equal(copiedRead.sha256, read2.sha256);

  await assert.rejects(
    fsGit.fsCreate({ path: "../workbench-must-not-escape.txt", content: "x", cwd: projectRoot }),
    /outside trusted root/
  );

  const git = await fsGit.gitStatus({ cwd: projectRoot });
  assert.equal(git.exitCode, 0);
  assert.match(git.stdout, /hardening\/v1|main|workbench\/v5-persistent-workspace|workbench\/v4-computer-use|workbench\/v3-mcp-hub|workbench\/v2-browser|workbench\/v1/);

  const proc = await processes.start({
    command: [process.execPath, "-e", "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('ECHO:'+d));setInterval(()=>{},1000)"],
    cwd: projectRoot,
    label: "workbench-unit-echo",
  });
  assert.equal(proc.state, "running");
  assert.ok(proc.processRef.startsWith("proc_"));

  await processes.send({ processRef: proc.processRef, text: "ping", appendNewline: true });
  await sleep(250);
  const output = await processes.read({ processRef: proc.processRef, afterSeq: 0, maxChars: 50000 });
  assert.equal(output.events.some((event) => event.stream === "stdout" && event.text.includes("ECHO:ping")), true);

  const stopped = await processes.stop({ processRef: proc.processRef, force: true });
  assert.equal(stopped.stopRequested, true);
  await sleep(250);
  const finalState = await processes.read({ processRef: proc.processRef, afterSeq: 0, maxChars: 50000 });
  assert.equal(["exited", "running"].includes(finalState.state), true);

  const deletedCopy = await fsGit.fsDelete({ path: `${testDirRel}/copied.txt`, expectedSha256: copiedRead.sha256, cwd: projectRoot });
  assert.equal(deletedCopy.status, "deleted");
  const deleted = await fsGit.fsDelete({ path: `${testDirRel}/moved.txt`, expectedSha256: read2.sha256, cwd: projectRoot });
  assert.equal(deleted.status, "deleted");
  const deletedDir = await fsGit.fsDelete({ path: testDirRel, cwd: projectRoot });
  assert.equal(deletedDir.type, "directory");
} finally {
  await processes.close().catch(() => {});
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
}

console.log("Workbench V1 unit contract passed");
