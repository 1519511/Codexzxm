export const DEFAULT_PRIVATE_MCP_ALLOWED_SERVERS = Object.freeze([
  "drawio-file-utils",
  "drawio-live",
  "node_repl",
  "openaiDeveloperDocs",
  "powerpoint-live",
  "powerpoint_live",
]);

export function resolvePrivateMcpPolicy({ allowlist = null, allowCodexApps = false } = {}) {
  const values = Array.isArray(allowlist)
    ? allowlist
    : typeof allowlist === "string" && allowlist.trim()
      ? allowlist.split(",")
      : DEFAULT_PRIVATE_MCP_ALLOWED_SERVERS;
  const allowedServers = new Set(values.map((value) => String(value).trim()).filter(Boolean));
  if (!allowCodexApps) allowedServers.delete("codex_apps");
  return { allowedServers, allowCodexApps: allowCodexApps === true };
}

export class WorkbenchMcpHub {
  constructor({ context, allowedServers = DEFAULT_PRIVATE_MCP_ALLOWED_SERVERS, allowCodexApps = false } = {}) {
    if (!context) throw new Error("WorkbenchMcpHub requires a Codex public context executor");
    this.context = context;
    const policy = resolvePrivateMcpPolicy({ allowlist: allowedServers, allowCodexApps });
    this.allowedServers = policy.allowedServers;
    this.allowCodexApps = policy.allowCodexApps;
  }

  async listServers({ query = "", limit = 100 } = {}) {
    const snapshot = await this.#snapshot();
    const needle = String(query ?? "").trim().toLowerCase();
    const rows = snapshot
      .filter((server) => !needle || `${server?.name ?? ""} ${server?.error ?? ""}`.toLowerCase().includes(needle))
      .slice(0, clamp(limit, 1, 500, 100))
      .map((server) => ({
        name: server?.name ?? null,
        error: server?.error ?? null,
        toolCount: toolValues(server).length,
        callable: this.#serverCallable(server?.name),
        requiresCodexAppsOptIn: server?.name === "codex_apps" && !this.allowCodexApps,
      }));
    return {
      count: rows.length,
      totalServers: snapshot.length,
      allowCodexApps: this.allowCodexApps,
      allowedServers: [...this.allowedServers].sort(),
      servers: rows,
    };
  }

  async listTools({ server, query = "", offset = 0, limit = 50, includeSchemas = false } = {}) {
    const row = await this.#requireServer(server);
    const needle = String(query ?? "").trim().toLowerCase();
    const all = toolValues(row).filter((tool) => {
      if (!needle) return true;
      return `${tool?.name ?? ""} ${tool?.title ?? ""} ${tool?.description ?? ""}`.toLowerCase().includes(needle);
    });
    const start = clamp(offset, 0, Math.max(0, all.length), 0);
    const page = all.slice(start, start + clamp(limit, 1, 200, 50));
    const callableServer = this.#serverCallable(row.name);
    return {
      server: row.name,
      serverError: row.error ?? null,
      callable: callableServer,
      totalMatches: all.length,
      offset: start,
      count: page.length,
      nextOffset: start + page.length < all.length ? start + page.length : null,
      tools: page.map((tool) => summarizeTool(tool, { includeSchema: includeSchemas === true, callableServer })),
    };
  }

  async describeTool({ server, tool } = {}) {
    const row = await this.#requireServer(server);
    const descriptor = requireTool(row, tool);
    return {
      server: row.name,
      callable: this.#toolCallable(row.name, descriptor.name),
      requiresSideEffectConfirmation: toolMayHaveSideEffects(descriptor),
      tool: structuredClone(descriptor),
    };
  }

  async call({
    server,
    tool,
    arguments: args = {},
    cwd,
    timeoutMs = 60_000,
    confirmedSideEffects = false,
  } = {}) {
    const row = await this.#requireServer(server);
    const descriptor = requireTool(row, tool);
    this.#assertToolCallable(row.name, descriptor.name);
    const maySideEffect = toolMayHaveSideEffects(descriptor);
    if (maySideEffect && confirmedSideEffects !== true) {
      const error = new Error(
        `MCP_SIDE_EFFECT_CONFIRMATION_REQUIRED: ${row.name}.${descriptor.name} is not declared read-only. ` +
        "Retry with confirmedSideEffects=true only when the user's current request authorizes this mutation/external side effect."
      );
      error.code = "MCP_SIDE_EFFECT_CONFIRMATION_REQUIRED";
      throw error;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("MCP tool arguments must be a JSON object");
    const result = await this.context.mcpToolCall({
      server: row.name,
      tool: descriptor.name,
      cwd,
      arguments: structuredClone(args),
      timeoutMs: clamp(timeoutMs, 1_000, 120_000, 60_000),
    });
    return {
      server: row.name,
      tool: descriptor.name,
      declaredReadOnly: descriptor?.annotations?.readOnlyHint === true,
      declaredDestructive: descriptor?.annotations?.destructiveHint === true,
      resultIsError: result.isError === true,
      text: result.text,
      data: result.data,
      meta: result.meta,
      contentItems: result.contentItems,
    };
  }

  async #snapshot() {
    const result = await this.context.mcpServerStatusList({ limit: 500 });
    return Array.isArray(result?.data) ? result.data : [];
  }

  async #requireServer(serverName) {
    const name = requireName(serverName, "server");
    const rows = await this.#snapshot();
    const row = rows.find((server) => server?.name === name);
    if (!row) throw new Error(`unknown MCP server: ${name}`);
    return row;
  }

  #serverCallable(name) {
    if (name === "codex_apps") return this.allowCodexApps && (this.allowedServers.has("*") || this.allowedServers.has(name));
    return this.allowedServers.has("*") || this.allowedServers.has(name);
  }

  #toolCallable(server, tool) {
    if (!this.#serverCallable(server)) return false;
    if (server === "codex_apps" && String(tool).startsWith("codexless_mcp.")) return false;
    return true;
  }

  #assertToolCallable(server, tool) {
    if (server === "codex_apps" && !this.allowCodexApps) {
      throw new Error(
        "MCP_SERVER_NOT_ALLOWED: codex_apps is metadata-visible but call-disabled by default. " +
        "Enable CODEXLESS_PRIVATE_MCP_ALLOW_CODEX_APPS=1 locally only when external app calls are intentionally desired."
      );
    }
    if (!this.#serverCallable(server)) {
      throw new Error(`MCP_SERVER_NOT_ALLOWED: ${server} is not in the private MCP allowlist`);
    }
    if (server === "codex_apps" && String(tool).startsWith("codexless_mcp.")) {
      throw new Error("MCP_RECURSIVE_CALL_REFUSED: Codexless refuses routing codex_apps back into codexless_mcp.*");
    }
  }
}

function summarizeTool(tool, { includeSchema, callableServer }) {
  const payload = {
    name: tool?.name ?? null,
    title: tool?.title ?? null,
    description: typeof tool?.description === "string" ? tool.description.slice(0, 1200) : null,
    annotations: tool?.annotations ? structuredClone(tool.annotations) : null,
    callable: callableServer,
    requiresSideEffectConfirmation: toolMayHaveSideEffects(tool),
  };
  if (includeSchema) payload.inputSchema = tool?.inputSchema ? structuredClone(tool.inputSchema) : null;
  return payload;
}

function toolValues(server) {
  return server?.tools && typeof server.tools === "object" ? Object.values(server.tools).filter(Boolean) : [];
}

function requireTool(server, toolName) {
  const name = requireName(toolName, "tool");
  const matches = toolValues(server).filter((tool) => tool?.name === name);
  if (matches.length !== 1) throw new Error(`unknown MCP tool on ${server?.name}: ${name}`);
  return matches[0];
}

function requireName(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function toolMayHaveSideEffects(tool) {
  const annotations = tool?.annotations;
  if (annotations?.readOnlyHint === true && annotations?.destructiveHint !== true) return false;
  return true;
}

function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
