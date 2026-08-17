import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { WorkbenchSecretBroker } from "../src/workbench-secret-broker.mjs";

const execFileAsync = promisify(execFile);
const MAX_EVENT_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_EVENT_FILE_BYTES = 2 * 1024 * 1024;
const CONTROL_POLL_MS = 150;

const dir = readArg("--dir");
if (!dir) throw new Error("workbench process runner requires --dir");
const processDir = path.resolve(dir);
const configFile = path.join(processDir, "config.json");
const statusFile = path.join(processDir, "status.json");
const eventsFile = path.join(processDir, "events.jsonl");
const controlFile = path.join(processDir, "control.jsonl");

await mkdir(processDir, { recursive: true });
const config = JSON.parse(await readFile(configFile, "utf8"));
if (!Array.isArray(config.command) || !config.command.length || !config.command.every((value) => typeof value === "string")) {
  throw new Error("invalid durable process command");
}
await writeFile(controlFile, "", { flag: "a" });

let status = {
  version: 1,
  processRef: config.processRef,
  label: config.label ?? null,
  command: config.command,
  cwd: config.cwd,
  trustedAncestor: config.trustedAncestor ?? null,
  permissionProfile: config.permissionProfile ?? null,
  startedAt: config.startedAt ?? new Date().toISOString(),
  endedAt: null,
  state: "starting",
  pid: null,
  runnerPid: process.pid,
  exitCode: null,
  signal: null,
  lastSeq: 0,
  droppedBytes: 0,
  lastControlId: null,
  runnerHeartbeatAt: new Date().toISOString(),
};
let seq = 0;
let controlOffset = 0;
let eventWrites = Promise.resolve();
let statusWrites = Promise.resolve();
let controlBusy = false;
let heartbeatBusy = false;
let closing = false;
let controlTimer = null;
let heartbeatTimer = null;

await persistStatus();

const secretBroker = new WorkbenchSecretBroker();
const resolvedSecrets = await secretBroker.resolveEnvMap(config.secretEnv ?? {});
status.secretEnvInjected = resolvedSecrets.injected;
await persistStatus();

const child = spawn(config.command[0], config.command.slice(1), {
  cwd: config.cwd,
  env: { ...process.env, ...(config.env ?? {}), ...resolvedSecrets.env },
  windowsHide: true,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});
for (const key of Object.keys(resolvedSecrets.env)) resolvedSecrets.env[key] = "";

child.stdout?.setEncoding("utf8");
child.stderr?.setEncoding("utf8");
child.stdout?.on("data", (chunk) => void pushEvent("stdout", chunk));
child.stderr?.on("data", (chunk) => void pushEvent("stderr", chunk));
child.on("error", (error) => void failRunner(`target process error: ${error.message}`));
child.on("exit", (code, signal) => void finishTarget(code, signal));

await new Promise((resolve, reject) => {
  const onSpawn = () => {
    cleanup();
    status.pid = child.pid ?? null;
    status.state = "running";
    status.runnerHeartbeatAt = new Date().toISOString();
    resolve();
  };
  const onError = (error) => {
    cleanup();
    reject(error);
  };
  const cleanup = () => {
    child.off("spawn", onSpawn);
    child.off("error", onError);
  };
  child.once("spawn", onSpawn);
  child.once("error", onError);
}).catch(async (error) => {
  status.state = "failed";
  status.endedAt = new Date().toISOString();
  await pushEvent("stderr", `process start failed: ${error.message}\n`);
  await persistStatus();
  process.exitCode = 1;
  throw error;
});

await pushEvent("system", `process started pid=${String(status.pid)} runnerPid=${process.pid}\n`);
await persistStatus();

controlTimer = setInterval(() => void pollControl(), CONTROL_POLL_MS);
controlTimer.unref?.();
heartbeatTimer = setInterval(() => void heartbeat(), 2_000);
heartbeatTimer.unref?.();

process.on("SIGTERM", () => void requestStop(true, "runner-sigterm"));
process.on("SIGINT", () => void requestStop(true, "runner-sigint"));
process.on("uncaughtException", (error) => void failRunner(`runner uncaught exception: ${error.stack ?? error.message}`));
process.on("unhandledRejection", (error) => void failRunner(`runner unhandled rejection: ${String(error)}`));

async function pollControl() {
  if (controlBusy || closing) return;
  controlBusy = true;
  try {
    let data;
    try { data = await readFile(controlFile); }
    catch (error) {
      if (error?.code === "ENOENT") { controlBusy = false; return; }
      throw error;
    }
    if (data.length < controlOffset) controlOffset = 0;
    if (data.length === controlOffset) return;
    const chunk = data.subarray(controlOffset).toString("utf8");
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline < 0) return;
    const complete = chunk.slice(0, lastNewline + 1);
    controlOffset += Buffer.byteLength(complete, "utf8");
    for (const line of complete.split(/\r?\n/).filter(Boolean)) {
      let command;
      try { command = JSON.parse(line); }
      catch {
        await pushEvent("stderr", `invalid control line ignored: ${line.slice(0, 500)}\n`);
        continue;
      }
      await handleControl(command);
    }
  } finally {
    controlBusy = false;
  }
}

async function handleControl(command) {
  const id = typeof command?.id === "string" ? command.id : null;
  if (command?.type === "stdin") {
    if (status.state !== "running" || !child.stdin?.writable) {
      await pushEvent("stderr", `stdin control refused; process state=${status.state}\n`);
    } else {
      const text = String(command.text ?? "");
      await new Promise((resolve, reject) => child.stdin.write(text, (error) => error ? reject(error) : resolve()));
      await pushEvent("stdin", text);
    }
  } else if (command?.type === "stop") {
    await requestStop(command.force === true, "control");
  } else {
    await pushEvent("stderr", `unknown control type: ${String(command?.type)}\n`);
  }
  if (id) {
    status.lastControlId = id;
    await persistStatus();
  }
}

async function requestStop(force, source) {
  if (closing || !["running", "starting"].includes(status.state)) return;
  closing = true;
  await pushEvent("system", `stop requested force=${String(force)} source=${source}\n`);
  if (force && process.platform === "win32" && child.pid) {
    await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    }).catch(() => {});
  } else {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}

async function finishTarget(code, signal) {
  if (controlTimer) clearInterval(controlTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  status.state = "exited";
  status.exitCode = code;
  status.signal = signal;
  status.endedAt = new Date().toISOString();
  status.runnerHeartbeatAt = new Date().toISOString();
  await pushEvent("system", `process exited code=${String(code)} signal=${String(signal)}\n`);
  await persistStatus();
  await eventWrites.catch(() => {});
  await statusWrites.catch(() => {});
  setTimeout(() => process.exit(0), 25);
}

async function failRunner(message) {
  if (status.state === "exited" || status.state === "failed") return;
  if (controlTimer) clearInterval(controlTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  status.state = "failed";
  status.endedAt = new Date().toISOString();
  status.runnerHeartbeatAt = new Date().toISOString();
  await pushEvent("stderr", `${message}\n`).catch(() => {});
  await persistStatus().catch(() => {});
  try {
    if (child.exitCode === null) child.kill("SIGKILL");
  } catch {}
  setTimeout(() => process.exit(1), 25);
}

async function heartbeat() {
  if (heartbeatBusy || ["exited", "failed"].includes(status.state)) return;
  heartbeatBusy = true;
  try {
    status.runnerHeartbeatAt = new Date().toISOString();
    await persistStatus();
  } finally {
    heartbeatBusy = false;
  }
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
  let info;
  try { info = await stat(eventsFile); }
  catch { return; }
  if (info.size <= MAX_EVENT_FILE_BYTES) return;
  const data = await readFile(eventsFile);
  let start = Math.max(0, data.length - KEEP_EVENT_FILE_BYTES);
  if (start > 0) {
    const newline = data.indexOf(0x0a, start);
    start = newline >= 0 ? newline + 1 : data.length;
  }
  const kept = data.subarray(start);
  status.droppedBytes += start;
  const tmp = `${eventsFile}.tmp`;
  await writeFile(tmp, kept);
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
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}
