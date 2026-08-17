import pty from "node-pty";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { WorkbenchSecretBroker } from "../src/workbench-secret-broker.mjs";

const CONTROL_POLL_MS = 120;
const MAX_EVENT_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_EVENT_FILE_BYTES = 2 * 1024 * 1024;

const dir = readArg("--dir");
if (!dir) throw new Error("PTY runner requires --dir");
const sessionDir = path.resolve(dir);
const config = JSON.parse(await readFile(path.join(sessionDir, "config.json"), "utf8"));
const statusFile = path.join(sessionDir, "status.json");
const eventsFile = path.join(sessionDir, "events.jsonl");
const controlFile = path.join(sessionDir, "control.jsonl");
await mkdir(sessionDir, { recursive: true });
await writeFile(controlFile, "", { flag: "a" });

let seq = 0;
let controlOffset = 0;
let eventWrites = Promise.resolve();
let statusWrites = Promise.resolve();
let controlBusy = false;
let closing = false;
let controlTimer = null;
let heartbeatTimer = null;
let status = {
  version: 1,
  ptyRef: config.ptyRef,
  label: config.label ?? null,
  command: config.command,
  cwd: config.cwd,
  trustedAncestor: config.trustedAncestor ?? null,
  permissionProfile: config.permissionProfile ?? null,
  cols: config.cols ?? 120,
  rows: config.rows ?? 30,
  startedAt: config.startedAt ?? new Date().toISOString(),
  endedAt: null,
  state: "starting",
  pid: null,
  runnerPid: process.pid,
  exitCode: null,
  signal: null,
  lastSeq: 0,
  lastControlId: null,
  runnerHeartbeatAt: new Date().toISOString(),
  secretEnvInjected: [],
};
await persistStatus();

const secretBroker = new WorkbenchSecretBroker();
const resolvedSecrets = await secretBroker.resolveEnvMap(config.secretEnv ?? {});
status.secretEnvInjected = resolvedSecrets.injected;
await persistStatus();

const argv = Array.isArray(config.command) ? config.command : [];
if (!argv.length) throw new Error("PTY runner config has no command");
const terminal = pty.spawn(argv[0], argv.slice(1), {
  name: "xterm-256color",
  cols: status.cols,
  rows: status.rows,
  cwd: config.cwd,
  env: { ...process.env, ...(config.env ?? {}), ...resolvedSecrets.env },
  useConpty: process.platform === "win32",
});
for (const key of Object.keys(resolvedSecrets.env)) resolvedSecrets.env[key] = "";
status.pid = terminal.pid ?? null;
status.state = "running";
status.runnerHeartbeatAt = new Date().toISOString();
await pushEvent("system", `PTY started pid=${String(status.pid)} runnerPid=${process.pid}\n`);
await persistStatus();

terminal.onData((data) => void pushEvent("pty", data));
terminal.onExit(({ exitCode, signal }) => void finish(exitCode, signal));
controlTimer = setInterval(() => void pollControl(), CONTROL_POLL_MS);
controlTimer.unref?.();
heartbeatTimer = setInterval(() => void heartbeat(), 2000);
heartbeatTimer.unref?.();
process.on("SIGTERM", () => void requestStop(true, "runner-sigterm"));
process.on("SIGINT", () => void requestStop(true, "runner-sigint"));
process.on("uncaughtException", (error) => void fail(`PTY runner uncaught exception: ${error.stack ?? error.message}`));
process.on("unhandledRejection", (error) => void fail(`PTY runner unhandled rejection: ${String(error)}`));

async function pollControl() {
  if (controlBusy || closing) return;
  controlBusy = true;
  try {
    let data;
    try { data = await readFile(controlFile); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (data.length < controlOffset) controlOffset = 0;
    if (data.length === controlOffset) return;
    const chunk = data.subarray(controlOffset).toString("utf8");
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline < 0) return;
    const complete = chunk.slice(0, lastNewline + 1);
    controlOffset += Buffer.byteLength(complete, "utf8");
    for (const line of complete.split(/\r?\n/).filter(Boolean)) {
      let command; try { command = JSON.parse(line); } catch { await pushEvent("system", "Invalid PTY control line ignored\n"); continue; }
      await handleControl(command);
    }
  } finally { controlBusy = false; }
}

async function handleControl(command) {
  if (command?.type === "stdin") {
    if (status.state !== "running") await pushEvent("system", `PTY input refused; state=${status.state}\n`);
    else terminal.write(String(command.text ?? ""));
  } else if (command?.type === "resize") {
    if (status.state === "running") {
      const cols = Math.max(20, Math.min(500, Number(command.cols) || status.cols));
      const rows = Math.max(5, Math.min(200, Number(command.rows) || status.rows));
      terminal.resize(cols, rows);
      status.cols = cols; status.rows = rows;
      await pushEvent("system", `PTY resized cols=${cols} rows=${rows}\n`);
    }
  } else if (command?.type === "stop") {
    await requestStop(command.force === true, "control");
  }
  if (typeof command?.id === "string") { status.lastControlId = command.id; await persistStatus(); }
}

async function requestStop(force, source) {
  if (closing || !["running", "starting"].includes(status.state)) return;
  closing = true;
  await pushEvent("system", `PTY stop requested force=${String(force)} source=${source}\n`);
  try { terminal.kill(force && process.platform !== "win32" ? "SIGKILL" : undefined); } catch {}
  if (force && process.platform === "win32" && status.pid) {
    const { execFile } = await import("node:child_process");
    await new Promise((resolve) => execFile("taskkill.exe", ["/PID", String(status.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
  }
}

async function finish(exitCode, signal) {
  if (controlTimer) clearInterval(controlTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  status.state = "exited";
  status.exitCode = exitCode ?? null;
  status.signal = signal ?? null;
  status.endedAt = new Date().toISOString();
  status.runnerHeartbeatAt = new Date().toISOString();
  await pushEvent("system", `PTY exited code=${String(exitCode)} signal=${String(signal)}\n`);
  await persistStatus();
  setTimeout(() => process.exit(0), 25);
}

async function fail(message) {
  if (["exited", "failed"].includes(status.state)) return;
  if (controlTimer) clearInterval(controlTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  status.state = "failed";
  status.endedAt = new Date().toISOString();
  await pushEvent("system", `${message}\n`).catch(() => {});
  await persistStatus().catch(() => {});
  try { terminal.kill(); } catch {}
  setTimeout(() => process.exit(1), 25);
}

async function heartbeat() {
  if (["exited", "failed"].includes(status.state)) return;
  status.runnerHeartbeatAt = new Date().toISOString();
  await persistStatus();
}

function pushEvent(stream, raw) {
  const text = String(raw ?? "");
  if (!text) return eventWrites;
  eventWrites = eventWrites.then(async () => {
    const event = { seq: ++seq, at: new Date().toISOString(), stream, text };
    status.lastSeq = seq;
    await appendFile(eventsFile, `${JSON.stringify(event)}\n`, "utf8");
    await maybeCompactEvents();
  });
  return eventWrites;
}

async function maybeCompactEvents() {
  let info; try { info = await stat(eventsFile); } catch { return; }
  if (info.size <= MAX_EVENT_FILE_BYTES) return;
  const data = await readFile(eventsFile);
  let start = Math.max(0, data.length - KEEP_EVENT_FILE_BYTES);
  if (start > 0) { const newline = data.indexOf(0x0a, start); start = newline >= 0 ? newline + 1 : data.length; }
  const tmp = `${eventsFile}.tmp`;
  await writeFile(tmp, data.subarray(start));
  await rename(tmp, eventsFile);
}

function persistStatus() {
  const payload = { ...status };
  statusWrites = statusWrites.then(async () => {
    const tmp = `${statusFile}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, statusFile);
  });
  return statusWrites;
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}
