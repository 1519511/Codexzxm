import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createPublicServerFactory } from "../src/public-server-factory.mjs";
import { createPrivateWorkbench } from "../src/workbench-tools.mjs";
import { EXPERIMENTAL_PRO_BRIDGE_TOOL_NAMES, PRIVATE_WORKBENCH_TOOL_NAMES, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");

const authorityExecutor = {
  async exec() { throw new Error("surface test must not execute commands"); },
  async resolveAuthority() { throw new Error("surface test must not resolve authority"); },
};

async function listNames(privateEnabled, experimentalProBridge = false) {
  const privateWorkbench = privateEnabled ? createPrivateWorkbench({ authorityExecutor, browserReader: {}, publicContext: {}, defaultCwd: process.cwd(), workspaceStateDir: ".workbench/surface-v5-state", experimentalProBridge }) : null;
  const createServer = createPublicServerFactory({
    executor: authorityExecutor,
    authorityExecutor,
    publicContext: {},
    browserReader: {},
    agentExecutor: {},
    privateWorkbench,
    maxConcurrent: 1,
  });
  const server = createServer();
  const client = new Client({ name: `surface-unit-${privateEnabled ? "private" : "public"}`, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    return tools.tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await privateWorkbench?.close().catch(() => {});
  }
}

const publicNames = await listNames(false);
assert.equal(publicNames.length, PUBLIC_TOOL_NAMES.length);
assert.deepEqual([...publicNames].sort(), [...PUBLIC_TOOL_NAMES].sort());
assert.equal(publicNames.some((name) => name.startsWith("workbench.")), false);

const privateNames = await listNames(true);
const expectedPrivate = [...PUBLIC_TOOL_NAMES, ...PRIVATE_WORKBENCH_TOOL_NAMES];
assert.equal(privateNames.length, 121);
assert.equal(PRIVATE_WORKBENCH_TOOL_NAMES.length, 100);
assert.equal(privateNames.length, expectedPrivate.length);
assert.deepEqual([...privateNames].sort(), [...expectedPrivate].sort());
assert.equal(privateNames.filter((name) => name.startsWith("workbench.")).length, PRIVATE_WORKBENCH_TOOL_NAMES.length);
for (const name of EXPERIMENTAL_PRO_BRIDGE_TOOL_NAMES) assert.equal(privateNames.includes(name), false, `${name} must be disabled by default`);

const experimentalNames = await listNames(true, true);
const expectedExperimental = [...expectedPrivate, ...EXPERIMENTAL_PRO_BRIDGE_TOOL_NAMES];
assert.equal(experimentalNames.length, 124);
assert.deepEqual([...experimentalNames].sort(), [...expectedExperimental].sort());
for (const name of EXPERIMENTAL_PRO_BRIDGE_TOOL_NAMES) assert.equal(experimentalNames.includes(name), true, `${name} must be available only in experimental mode`);

console.log(`Surface unit contract passed: public=${publicNames.length}, stable=${privateNames.length}, experimental=${experimentalNames.length}`);
