import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const MAX_SESSIONS = 4;
const MAX_LISTED = 100;
const START_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 8000;

export class WorkbenchPtyManager {
  constructor({ authorityExecutor, stateDir = null, runnerPath = null } = {}) {
    if (!authorityExecutor) throw new Error("WorkbenchPtyManager requires authorityExecutor");
    this.authorityExecutor = authorityExecutor;
    this.stateDir = path.resolve(stateDir ?? path.join(os.homedir(), ".config", "codexzxm", "pty-v1"));
    this.runnerPath = path.resolve(runnerPath ?? fileURLToPath(new URL("../scripts/workbench-pty-runner.mjs", import.meta.url)));
  }

  async start({ command = null, cwd, env = {}, secretEnv = {}, cols = 120, rows = 30, label = null } = {}) {
    const argv = Array.isArray(command) && command.length ? command : defaultShellCommand();
    if (!argv.every((value) => typeof value === "string" && value.length)) throw new Error("PTY command must be a non-empty argv string array");
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("PTY env must be an object");
    if (!secretEnv || typeof secretEnv !== "object" || Array.isArray(secretEnv)) throw new Error("PTY secretEnv must be an object");
    const size = normalizeSize(cols, rows);
    const active = (await this.list()).sessions.filter((row) => ["starting", "running", "orphaned"].includes(row.state));
    if (active.length >= MAX_SESSIONS) throw new Error(`PTY session limit reached (${MAX_SESSIONS})`);

    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
    if (authority?.permissionProfile !== ":danger-full-access" || authority?.permissionCeiling !== ":danger-full-access" || !authority?.trustedAncestor) {
      throw new Error(`PTY requires explicit Codex :danger-full-access authority; resolved profile=${String(authority?.permissionProfile)} ceiling=${String(authority?.permissionCeiling)}`);
    }
    for (const [key, ref] of Object.entries(secretEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`invalid PTY secret environment name: ${key}`);
      if (typeof ref !== "string" || !ref.trim()) throw new Error(`PTY secretEnv ${key} must reference a secretRef`);
      if (Object.hasOwn(env, key)) throw new Error(`PTY env/secretEnv collision for ${key}`);
    }

    await mkdir(this.stateDir, { recursive: true });
    const ptyRef = `pty_${randomUUID()}`;
    const sessionDir = path.join(this.stateDir, ptyRef);
    await mkdir(sessionDir, { recursive: false });
    const config = {
      version: 1,
      ptyRef,
      label,
      command: argv,
      cwd: authority.effectiveCwd,
      trustedAncestor: authority.trustedAncestor,
      permissionProfile: authority.permissionProfile,
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [String(k), String(v)])),
      secretEnv: Object.fromEntries(Object.entries(secretEnv).map(([k, v]) => [String(k), String(v).trim()])),
      cols: size.cols,
      rows: size.rows,
      startedAt: new Date().toISOString(),
    };
    await (await import("node:fs/promises")).writeFile(path.join(sessionDir, "config.json"), JSON.stringify(config, null, 2), { encoding: "utf8", flag: "wx" });

    const runner = spawn(process.execPath, [this.runnerPath, "--dir", sessionDir], {
      cwd: authority.effectiveCwd,
      env: process.env,
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    runner.unref();
    const status = await waitForStatus(sessionDir, (row) => ["running", "failed", "exited"].includes(row?.state), START_TIMEOUT_MS);
    if (!status) throw new Error(`PTY runner did not become ready within ${START_TIMEOUT_MS}ms: ${ptyRef}`);
    if (status.state !== "running") throw new Error(`PTY start failed: state=${status.state}`);
    return summary(status, { durable: true, reattachable: true });
  }

  async list() {
    await mkdir(this.stateDir, { recursive: true });
    const entries = await readdir(this.stateDir, { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("pty_")) continue;
      const status = await loadStatus(this.stateDir, entry.name).catch(() => null);
      if (!status) continue;
      rows.push(await refreshLiveness(status));
    }
    rows.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
    const sessions = rows.slice(0, MAX_LISTED).map((row) => summary(row, { durable: true, reattachable: row.state !== "orphaned" }));
    return { maxSessions: MAX_SESSIONS, running: sessions.filter((row) => ["starting", "running"].includes(row.state)).length, orphaned: sessions.filter((row) => row.state === "orphaned").length, sessions };
  }

  async read({ ptyRef, afterSeq = 0, maxChars = 50000 } = {}) {
    const ref = requirePtyRef(ptyRef);
    const status = await refreshLiveness(await loadStatus(this.stateDir, ref));
    let text = "";
    try { text = await readFile(path.join(this.stateDir, ref, "events.jsonl"), "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const events = [];
    let chars = 0;
    let truncated = false;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (!Number.isInteger(event?.seq) || event.seq <= afterSeq) continue;
      const value = String(event.text ?? "");
      const remaining = maxChars - chars;
      if (remaining <= 0) { truncated = true; break; }
      const returned = value.slice(0, remaining);
      events.push({ ...event, text: returned });
      chars += returned.length;
      if (returned.length < value.length) { truncated = true; break; }
    }
    return { ...summary(status, { durable: true, reattachable: status.state !== "orphaned" }), afterSeq, returnedChars: chars, truncated, lastSeq: status.lastSeq ?? 0, events };
  }

  async send({ ptyRef, text, appendNewline = false } = {}) {
    const ref = requirePtyRef(ptyRef);
    const status = await refreshLiveness(await loadStatus(this.stateDir, ref));
    if (status.state !== "running") throw new Error(`PTY is not accepting input: ${ref}; state=${status.state}`);
    const payload = appendNewline ? `${String(text ?? "")}\r` : String(text ?? "");
    const controlId = `ctl_${randomUUID()}`;
    await appendControl(this.stateDir, ref, { id: controlId, type: "stdin", text: payload });
    return { ...summary(status), queued: true, controlId, writtenChars: payload.length };
  }

  async resize({ ptyRef, cols, rows } = {}) {
    const ref = requirePtyRef(ptyRef);
    const status = await refreshLiveness(await loadStatus(this.stateDir, ref));
    if (status.state !== "running") throw new Error(`PTY is not running: ${ref}; state=${status.state}`);
    const size = normalizeSize(cols, rows);
    const controlId = `ctl_${randomUUID()}`;
    await appendControl(this.stateDir, ref, { id: controlId, type: "resize", ...size });
    return { ...summary(status), queued: true, controlId, ...size };
  }

  async stop({ ptyRef, force = false } = {}) {
    const ref = requirePtyRef(ptyRef);
    let status = await refreshLiveness(await loadStatus(this.stateDir, ref));
    if (["exited", "failed"].includes(status.state)) return { ...summary(status), alreadyStopped: true };
    const controlId = `ctl_${randomUUID()}`;
    await appendControl(this.stateDir, ref, { id: controlId, type: "stop", force: force === true });
    const settled = await waitForStatus(path.join(this.stateDir, ref), (row) => ["exited", "failed"].includes(row?.state), STOP_TIMEOUT_MS);
    status = settled ?? await loadStatus(this.stateDir, ref);
    return { ...summary(status, { durable: true, reattachable: !["exited", "failed", "orphaned"].includes(status.state) }), stopRequested: true, force, controlId, stopAcknowledged: Boolean(settled) };
  }

  async close() { return { durablePtySessionsPreserved: true }; }
}

function defaultShellCommand() {
  if (process.platform === "win32") return [process.env.COMSPEC || "cmd.exe"];
  return [process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")];
}

function normalizeSize(cols, rows) {
  const c = Number.isInteger(cols) ? Math.max(20, Math.min(500, cols)) : 120;
  const r = Number.isInteger(rows) ? Math.max(5, Math.min(200, rows)) : 30;
  return { cols: c, rows: r };
}

async function appendControl(stateDir, ref, payload) {
  await appendFile(path.join(stateDir, ref, "control.jsonl"), `${JSON.stringify(payload)}\n`, "utf8");
}

async function loadStatus(stateDir, ref) {
  const parsed = JSON.parse(await readFile(path.join(stateDir, requirePtyRef(ref), "status.json"), "utf8"));
  if (parsed?.ptyRef !== ref) throw new Error(`invalid PTY state: ${ref}`);
  return parsed;
}

async function refreshLiveness(status) {
  if (!["starting", "running"].includes(status.state)) return status;
  if (await isPidAlive(status.runnerPid)) return status;
  if (!(await isPidAlive(status.pid))) return { ...status, state: "exited", endedAt: status.endedAt ?? new Date().toISOString() };
  return { ...status, state: "orphaned" };
}

function summary(status, extra = {}) {
  return {
    ptyRef: status.ptyRef,
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
    cols: status.cols ?? null,
    rows: status.rows ?? null,
    startedAt: status.startedAt ?? null,
    endedAt: status.endedAt ?? null,
    lastSeq: status.lastSeq ?? 0,
    runnerHeartbeatAt: status.runnerHeartbeatAt ?? null,
    secretEnvInjected: Array.isArray(status.secretEnvInjected) ? status.secretEnvInjected : [],
    ...extra,
  };
}

function requirePtyRef(value) {
  if (typeof value !== "string" || !/^pty_[0-9a-f-]{36}$/i.test(value)) throw new Error(`invalid ptyRef: ${String(value)}`);
  return value;
}

async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForStatus(processDir, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const file = path.join(processDir, "status.json");
  let last = null;
  while (Date.now() < deadline) {
    try { last = JSON.parse(await readFile(file, "utf8")); if (predicate(last)) return last; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate(last) ? last : null;
}
