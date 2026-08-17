import assert from "node:assert/strict";
import path from "node:path";
import { CodexPublicContextExecutor } from "../src/public-context-executor.mjs";

const cwd = path.resolve(import.meta.dirname, "..");

function fakeClientFactory({ failSafeRequestOnce = false, failMcpCall = false } = {}) {
  const state = {
    running: false,
    starts: 0,
    closes: 0,
    requests: [],
    failedSafe: false,
  };
  const client = {
    get running() { return state.running; },
    initializedResult: null,
    async start() {
      state.starts += 1;
      state.running = true;
      client.initializedResult = { serverInfo: { name: "fake", version: "1" } };
      return client.initializedResult;
    },
    async close() {
      state.closes += 1;
      state.running = false;
    },
    async request(method, params) {
      state.requests.push({ method, params });
      if (failSafeRequestOnce && method === "thread/start" && !state.failedSafe) {
        state.failedSafe = true;
        throw new Error("ExceptionGroup: unhandled errors in a TaskGroup (1 sub-exception)");
      }
      if (method === "thread/start") return { thread: { id: `thread-${state.requests.length}`, cliVersion: "0.147.0" }, cwd: params.cwd };
      if (method === "mcpServer/tool/call" && failMcpCall) throw new Error("ExceptionGroup: mutation outcome unknown");
      return {};
    },
  };
  return { client, state };
}

{
  const fake = fakeClientFactory({ failSafeRequestOnce: true });
  const executor = new CodexPublicContextExecutor({
    codexBin: "fake-codex",
    defaultCwd: cwd,
    clientFactory: () => fake.client,
  });
  const context = await executor.projectContext({ cwd });
  assert.equal(context.cwd, cwd);
  assert.equal(fake.state.starts, 2, "safe request should restart the app-server client exactly once");
  assert.equal(fake.state.closes, 1, "safe request recovery should close the failed client once");
  assert.equal(fake.state.requests.filter((row) => row.method === "thread/start").length, 2);
  assert.equal(executor.generation, 2);
  await executor.close();
}

{
  const fake = fakeClientFactory({ failMcpCall: true });
  const executor = new CodexPublicContextExecutor({
    codexBin: "fake-codex",
    defaultCwd: cwd,
    clientFactory: () => fake.client,
  });
  await assert.rejects(
    executor.mcpToolCall({ server: "external", tool: "mutate", cwd, arguments: {} }),
    /ExceptionGroup: mutation outcome unknown/
  );
  assert.equal(fake.state.requests.filter((row) => row.method === "mcpServer\/tool\/call").length, 1, "MCP tool calls must never be auto-replayed");
  assert.equal(fake.state.starts, 1, "mutation failure must not trigger automatic restart/replay");
  await executor.close();
}

console.log("Public context safe-recovery contract passed");
