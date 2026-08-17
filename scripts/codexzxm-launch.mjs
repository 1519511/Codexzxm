process.env.CODEXZXM_PRIVATE_WORKBENCH ??= "1";
process.env.CODEXZXM_PRIVATE_MCP_ALLOWLIST ??= "*";
process.env.CODEXZXM_PRIVATE_MCP_ALLOW_CODEX_APPS ??= "1";
process.env.CODEXZXM_AGENT_METERED_CONSENT ??= "off";
await import("./launch.mjs");
