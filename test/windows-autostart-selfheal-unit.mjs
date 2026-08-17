import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const enablePath = path.join(projectRoot, "scripts", "enable-codexzxm-autostart.ps1");
const supervisorPath = path.join(projectRoot, "scripts", "codexzxm-tunnel-supervisor.ps1");

const enable = await readFile(enablePath, "utf8");
const supervisor = await readFile(supervisorPath, "utf8");

assert.match(enable, /ExpandEnvironmentStrings\("%LOCALAPPDATA%\\Codexzxm\\scripts\\codexzxm-tunnel-supervisor\.ps1"\)/);
assert.doesNotMatch(enable, /\$escapedSupervisor/);
assert.match(enable, /heartbeat\.json/);
assert.match(enable, /Hidden supervisor watchdog did not produce a live heartbeat/);
assert.match(enable, /Hidden supervisor watchdog verified\./);
assert.match(enable, /Get-CimInstance Win32_Process/);

assert.match(supervisor, /\$HeartbeatFile = Join-Path \$SupervisorStateDir 'heartbeat\.json'/);
assert.match(supervisor, /function Write-SupervisorHeartbeat/);
assert.match(supervisor, /pid = \$PID/);
assert.match(supervisor, /runtimeRunning = \[bool\]\$RuntimeStatus\.Running/);
assert.match(supervisor, /runtimeReady = \[bool\]\$RuntimeStatus\.Ready/);
assert.match(supervisor, /Write-SupervisorHeartbeat \$config \$iterationStatus/);

console.log("Windows autostart Unicode/self-heal contract passed");
