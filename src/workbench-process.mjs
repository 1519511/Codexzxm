import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PROCESSES = 8;
const MAX_LISTED_PROCESSES = 200;
const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 8_000;

export class WorkbenchProcessManager {
  constructor({ authorityExecutor, stateDir = null, runnerPath = null } = {}) {
    if (!authorityExecutor) throw new Error("WorkbenchProcessManager requires authorityExecutor");
    this.authorityExecutor = authorityExecutor;
    this.stateDir = path.resolve(stateDir ?? path.join(process.cwd(), ".workbench", "processes"));
    this.runnerPath = path.resolve(runnerPath ?? fileURLToPath(new URL("../scripts/workbench-process-runner.mjs", import.meta.url)));
  }

  async start({ command, cwd, env = {}, label = null }) {
    if (!Array.isArray(command) || !command.length || !command.every((value) => typeof value === "string")) {
      throw new Error("workbench process command must be a non-empty string array");
    }
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("workbench process env must be an object");
    const active = (await this.list()).processes.filter((row) => ["starting", "running", "orphaned"].includes(row.state));
    if (active.length >= MAX_PROCESSES) throw new Error(`workbench process limit reached (${MAX_PROCESSES})`);

    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
    assertDirectProcessAuthority(authority);
    await mkdir(this.stateDir, { recursive: true });

    const processRef = `proc_${randomUUID()}`;
    const processDir = path.join(this.stateDir, processRef);
    await mkdir(processDir, { recursive: false });
    const config = {
      version: 1,
      processRef,
      label,
      command: [...command],
      cwd: authority.effectiveCwd,
      trustedAncestor: authority.trustedAncestor,
      permissionProfile: authority.permissionProfile,
      env: Object.fromEntries(Object.entries(env).map(([key, value]) => [String(key), String(value)])),
      startedAt: new Date().toISOString(),
    };
    await writeFile(path.join(processDir, "config.json"), JSON.stringify(config, null, 2), { encoding: "utf8", flag: "wx" });

    const runner = spawn(process.execPath, [this.runnerPath, "--dir", processDir], {
      cwd: authority.effectiveCwd,
      env: process.env,
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    runner.unref();

    const status = await waitForStatus(processDir, (row) => ["running", "failed", "exited"].includes(row?.state), START_TIMEOUT_MS);
    if (!status) throw new Error(`durable process runner did not become ready within ${START_TIMEOUT_MS}ms: ${processRef}`);
    if (status.state !== "running") throw new Error(`workbench process start failed: state=${status.state}`);
    return this.#summary(status, { durable: true, reattachable: true });
  }

  async list() {
    await mkdir(this.stateDir, { recursive: true });
    const dirs = await readdir(this.stateDir, { withFileTypes: true });
    const rows = [];
    for (const entry of dirs) {
      if (!entry.isDirectory() || !entry.name.startsWith("proc_")) continue;
      const status = await this.#loadStatus(entry.name).catch(() => null);
      if (!status) continue;
      rows.push(await this.#refreshLiveness(status));
    }
    rows.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
    const processes = rows.slice(0, MAX_LISTED_PROCESSES).map((row) => this.#summary(row, { durable: true, reattachable: row.state !== "orphaned" }));
    return {
      maxProcesses: MAX_PROCESSES,
      running: processes.filter((row) => ["starting", "running"].includes(row.state)).length,
      orphaned: processes.filter((row) => row.state === "orphaned").length,
      durable: true,
      processes,
    };
  }

  async read({ processRef, afterSeq = 0, maxChars = 50000 }) {
    const ref = requireProcessRef(processRef);
    const status = await this.#refreshLiveness(await this.#loadStatus(ref));
    const eventsFile = path.join(this.stateDir, ref, "events.jsonl");
    let text = "";
    try { text = await readFile(eventsFile, "utf8"); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const events = [];
    let chars = 0;
    let truncated = false;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!Number.isInteger(event?.seq) || event.seq <= afterSeq) continue;
      const eventText = String(event.text ?? "");
      const remaining = maxChars - chars;
      if (remaining <= 0) { truncated = true; break; }
      const returned = eventText.slice(0, remaining);
      events.push({ ...event, text: returned });
      chars += returned.length;
      if (returned.length < eventText.length) { truncated = true; break; }
    }
    return {
      ...this.#summary(status, { durable: true, reattachable: status.state !== "orphaned" }),
      afterSeq,
      returnedChars: chars,
      truncated,
      droppedBytes: status.droppedBytes ?? 0,
      lastSeq: status.lastSeq ?? 0,
      events,
    };
  }

  async send({ processRef, text, appendNewline = false }) {
    const ref = requireProcessRef(processRef);
    const status = await this.#refreshLiveness(await this.#loadStatus(ref));
    if (status.state !== "running") throw new Error(`process is not accepting stdin: ${ref}; state=${status.state}`);
    if (!(await isPidAlive(status.runnerPid))) throw new Error(`durable process runner is unavailable for stdin: ${ref}`);
    const payload = appendNewline ? `${String(text ?? "")}\n` : String(text ?? "");
    const controlId = `ctl_${randomUUID()}`;
    await appendControl(this.stateDir, ref, { id: controlId, type: "stdin", text: payload });
    return {
      ...this.#summary(status, { durable: true, reattachable: true }),
      queued: true,
      controlId,
      writtenChars: payload.length,
    };
  }

  async stop({ processRef, force = false }) {
    const ref = requireProcessRef(processRef);
    let status = await this.#refreshLiveness(await this.#loadStatus(ref));
    if (["exited", "failed"].includes(status.state)) return { ...this.#summary(status, { durable: true, reattachable: false }), alreadyStopped: true };
    const controlId = `ctl_${randomUUID()}`;

    if (status.state === "orphaned" || !(await isPidAlive(status.runnerPid))) {
      if (force && process.platform === "win32" && status.pid) {
        await execFileAsync("taskkill.exe", ["/PID", String(status.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 256 * 1024,
        }).catch(() => {});
      } else if (status.pid) {
        try { process.kill(status.pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
      }
      return { ...this.#summary(status, { durable: true, reattachable: false }), stopRequested: true, force, orphanFallback: true };
    }

    await appendControl(this.stateDir, ref, { id: controlId, type: "stop", force: force === true });
    const settled = await waitForStatus(path.join(this.stateDir, ref), (row) => ["exited", "failed"].includes(row?.state), STOP_TIMEOUT_MS);
    status = settled ?? await this.#loadStatus(ref);
    return {
      ...this.#summary(status, { durable: true, reattachable: !["exited", "failed", "orphaned"].includes(status.state) }),
      stopRequested: true,
      force,
      controlId,
      stopAcknowledged: Boolean(settled),
    };
  }

  async close() {
    return { durableProcessesPreserved: true };
  }

  async #loadStatus(processRef) {
    const ref = requireProcessRef(processRef);
    const statusFile = path.join(this.stateDir, ref, "status.json");
    let parsed;
    try { parsed = JSON.parse(await readFile(statusFile, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error(`unknown workbench processRef: ${ref}`);
      throw new Error(`could not read process state for ${ref}: ${error.message}`);
    }
    if (parsed?.processRef !== ref) throw new Error(`invalid durable process state for ${ref}`);
    return parsed;
  }

  async #refreshLiveness(status) {
    if (!["starting", "running"].includes(status.state)) return status;
    const runnerAlive = await isPidAlive(status.runnerPid);
    if (runnerAlive) return status;
    const targetAlive = await isPidAlive(status.pid);
    if (!targetAlive) return { ...status, state: "exited", endedAt: status.endedAt ?? new Date().toISOString() };
    return { ...status, state: "orphaned" };
  }

  #summary(status, extra = {}) {
    return {
      processRef: status.processRef,
      label: status.label ?? null,
      state: status.state,
      pid: status.pid ?? null,
      runnerPid: status.runnerPid ?? null,
      exitCode: status.exitCode ?? null,
      signal: status.signal ?? null,
      command: Array.isArray(status.command) ? [...status.command] : [],
      cwd: status.cwd ?? null,
      trustedAncestor: status.trustedAncestor ?? null,
      permissionProfile: status.permissionProfile ?? null,
      startedAt: status.startedAt ?? null,
      endedAt: status.endedAt ?? null,
      lastSeq: status.lastSeq ?? 0,
      runnerHeartbeatAt: status.runnerHeartbeatAt ?? null,
      ...extra,
    };
  }
}

async function appendControl(stateDir, processRef, payload) {
  const controlFile = path.join(stateDir, processRef, "control.jsonl");
  await appendFile(controlFile, `${JSON.stringify(payload)}\n`, "utf8");
}

async function waitForStatus(processDir, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const statusFile = path.join(processDir, "status.json");
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(statusFile, "utf8"));
      if (predicate(last)) return last;
    } catch {}
    await sleep(100);
  }
  return predicate(last) ? last : null;
}

async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requireProcessRef(value) {
  if (typeof value !== "string" || !/^proc_[0-9a-f-]{36}$/i.test(value)) throw new Error(`invalid workbench processRef: ${String(value)}`);
  return value;
}

function assertDirectProcessAuthority(authority) {
  if (authority?.permissionProfile !== ":danger-full-access") {
    throw new Error(
      `persistent direct-host processes currently require Codex :danger-full-access authority; resolved ${String(authority?.permissionProfile)}. ` +
      "This fail-closed gate prevents the private process lane from bypassing a narrower Codex sandbox."
    );
  }
  if (!authority.trustedAncestor) throw new Error("persistent direct-host process requires an explicit trusted Codex root");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
