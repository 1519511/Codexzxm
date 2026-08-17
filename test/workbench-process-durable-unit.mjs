import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { WorkbenchProcessManager } from "../src/workbench-process.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const stateDir = path.join(projectRoot, "test", ".workbench-process-durable-state");
await rm(stateDir, { recursive: true, force: true });

const authorityExecutor = {
  async resolveAuthority({ cwd = projectRoot, access = "inherit" } = {}) {
    return {
      effectiveCwd: path.resolve(cwd),
      trustedAncestor: projectRoot,
      permissionProfile: access === "readOnly" ? ":read-only" : ":danger-full-access",
      permissionCeiling: ":danger-full-access",
      authoritySource: "durable-process-unit",
    };
  },
};

let processRef = null;
try {
  const first = new WorkbenchProcessManager({ authorityExecutor, stateDir });
  const started = await first.start({
    command: [
      process.execPath,
      "-e",
      "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('DURABLE:'+d));setInterval(()=>{},1000)",
    ],
    cwd: projectRoot,
    label: "durable-reattach",
  });
  processRef = started.processRef;
  assert.equal(started.durable, true);
  assert.equal(started.reattachable, true);

  await first.send({ processRef, text: "before-restart", appendNewline: true });
  await sleep(300);
  const before = await first.read({ processRef, afterSeq: 0, maxChars: 50000 });
  assert.equal(before.events.some((event) => event.stream === "stdout" && event.text.includes("DURABLE:before-restart")), true);

  const closed = await first.close();
  assert.equal(closed.durableProcessesPreserved, true);

  const second = new WorkbenchProcessManager({ authorityExecutor, stateDir });
  const listed = await second.list();
  const reattached = listed.processes.find((row) => row.processRef === processRef);
  assert.equal(reattached?.state, "running");
  assert.equal(reattached?.durable, true);

  await second.send({ processRef, text: "after-restart", appendNewline: true });
  await sleep(300);
  const after = await second.read({ processRef, afterSeq: 0, maxChars: 50000 });
  assert.equal(after.events.some((event) => event.stream === "stdout" && event.text.includes("DURABLE:after-restart")), true);

  const stopped = await second.stop({ processRef, force: true });
  assert.equal(stopped.stopRequested, true);
  assert.equal(stopped.stopAcknowledged, true);
  console.log("Workbench durable process reattach contract passed");
} finally {
  if (processRef) {
    const cleanup = new WorkbenchProcessManager({ authorityExecutor, stateDir });
    await cleanup.stop({ processRef, force: true }).catch(() => {});
  }
  await rm(stateDir, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
