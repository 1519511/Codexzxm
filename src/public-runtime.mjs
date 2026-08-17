import os from "node:os";
import path from "node:path";
import { createAgentPreviewState } from "./agent-tools.mjs";
import { CodexAgentExecutor } from "./codex-agent-executor.mjs";
import { CodexAuthorityExecutor } from "./codex-authority-executor.mjs";
import { acceptedCodexVersionsFromEnv } from "./codex-version-policy.mjs";
import { CodexBrowserReaderExecutor } from "./browser-reader-executor.mjs";
import { resolveCodexExecutable } from "./codex-bin.mjs";
import { readCodexQuotaSnapshot } from "./codex-quota-snapshot.mjs";
import { createPreviewTelemetryClient } from "./codex-preview-account-preflight.mjs";
import { readJsonFile } from "./json-file.mjs";
import { CodexPublicContextExecutor } from "./public-context-executor.mjs";
import { createPublicServerFactory } from "./public-server-factory.mjs";
import { createPrivateWorkbench } from "./workbench-tools.mjs";
import {
  PRIVATE_WORKBENCH_SURFACE_VERSION,
  PRIVATE_WORKBENCH_TOOL_NAMES,
  PUBLIC_SERVER_VERSION,
  PUBLIC_SURFACE_VERSION,
  PUBLIC_TOOL_NAMES,
} from "./surface-contracts.mjs";

function envString(env, name, fallback = null) {
  const value = env?.[name];
  return typeof value === "string" && value.length ? value : fallback;
}

function productEnvString(env, suffix, fallback = null) {
  return envString(env, `CODEXZXM_${suffix}`, envString(env, `CODEXLESS_${suffix}`, fallback));
}

export async function createPublicRuntime({ env = process.env } = {}) {
  const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
  const allowNonWindowsProbe = productEnvString(env, "ALLOW_NONWINDOWS_PROBE", "0") === "1";
  if (!supportedPlatform && !allowNonWindowsProbe) {
    throw new Error("Codexzxm currently supports Windows and Apple Silicon macOS only");
  }

  const probeVersion = !supportedPlatform && allowNonWindowsProbe
    ? productEnvString(env, "PROBE_CODEX_VERSION", null)
    : null;
  const configuredAcceptedCodexVersions = acceptedCodexVersionsFromEnv({ env });
  const acceptedCodexVersions = probeVersion
    ? [...new Set([...configuredAcceptedCodexVersions, probeVersion])]
    : configuredAcceptedCodexVersions;
  const codexResolution = await resolveCodexExecutable({ env, acceptedVersions: acceptedCodexVersions });
  const codexBin = codexResolution.path;

  const defaultCwd = productEnvString(env, "DEFAULT_CWD", process.cwd());
  const privateWorkbenchEnabled = productEnvString(env, "PRIVATE_WORKBENCH", "1") === "1";
  const privateMcpAllowedServers = productEnvString(env, "PRIVATE_MCP_ALLOWLIST", "*");
  const privateMcpAllowCodexApps = productEnvString(env, "PRIVATE_MCP_ALLOW_CODEX_APPS", "1") === "1";
  const privateWorkspaceStateDir = productEnvString(
    env,
    "WORKSPACE_STATE_DIR",
    path.join(os.homedir(), ".config", "codexzxm", "workbench-v5")
  );
  const privateProcessStateDir = productEnvString(
    env,
    "PROCESS_STATE_DIR",
    path.join(os.homedir(), ".config", "codexzxm", "processes-v1")
  );
  const profileOverride = productEnvString(env, "PROFILE", null);
  const configOverridesFile = productEnvString(env, "CONFIG_OVERRIDES_FILE", null);
  const configOverrides = configOverridesFile
    ? (await readJsonFile(configOverridesFile, "CODEXZXM_CONFIG_OVERRIDES_FILE"))?.overrides
    : [];
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("CODEXZXM_CONFIG_OVERRIDES_FILE must contain { overrides: [\"key=value\", ...] }");
  }

  const meteredConsentMode = productEnvString(env, "AGENT_METERED_CONSENT", "off");
  if (!["off", "always"].includes(meteredConsentMode)) {
    throw new Error("CODEXZXM_AGENT_METERED_CONSENT must be off or always");
  }
  const agentTaskStateFile = productEnvString(
    env,
    "AGENT_TASK_STATE_FILE",
    path.join(os.homedir(), ".config", "codexzxm", "agent-task-cards.json")
  );

  let publicContext = null;
  let agentExecutor = null;
  let privateWorkbench = null;
  let closed = false;

  try {
    const authorityExecutor = new CodexAuthorityExecutor({
      codexBin,
      defaultCwd,
      profileOverride,
      configOverrides,
      maxTimeoutMs: 0,
      watchdogGraceMs: 5_000,
      outputBytesCap: 32_768,
      acceptedCodexVersions,
    });
    const authorityValidation = await authorityExecutor.validate();

    publicContext = new CodexPublicContextExecutor({ codexBin, defaultCwd, configOverrides });
    await publicContext.start();

    const resourceSnapshotProvider = async () => {
      const telemetry = createPreviewTelemetryClient({
        codexBin,
        defaultCwd,
        configOverrides,
        stderrHandler: () => {},
      });
      try {
        await telemetry.start();
        return await readCodexQuotaSnapshot({ client: telemetry });
      } finally {
        await telemetry.close().catch(() => {});
      }
    };

    agentExecutor = new CodexAgentExecutor({
      codexBin,
      defaultCwd,
      configOverrides,
      requestTimeoutMs: 30_000,
      resourceSnapshotProvider,
    });
    await agentExecutor.open();

    const agentPreviewState = createAgentPreviewState({
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      taskStateFile: agentTaskStateFile,
    });

    const browserReader = new CodexBrowserReaderExecutor({ context: publicContext, defaultCwd, authorityExecutor });
    privateWorkbench = privateWorkbenchEnabled
      ? createPrivateWorkbench({
          authorityExecutor,
          browserReader,
          publicContext,
          defaultCwd,
          workspaceStateDir: privateWorkspaceStateDir,
          processStateDir: privateProcessStateDir,
          mcpAllowedServers: privateMcpAllowedServers,
          mcpAllowCodexApps: privateMcpAllowCodexApps,
        })
      : null;
    const createServer = createPublicServerFactory({
      executor: authorityExecutor,
      authorityExecutor,
      publicContext,
      browserReader,
      agentExecutor,
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      agentPreviewState,
      privateWorkbench,
      maxConcurrent: 1,
    });

    async function close() {
      if (closed) return;
      closed = true;
      try {
        await privateWorkbench?.close();
      } finally {
        try {
          await agentExecutor?.close();
        } finally {
          await publicContext?.close();
        }
      }
    }

    return {
      createServer,
      close,
      version: PUBLIC_SERVER_VERSION,
      surfaceVersion: privateWorkbenchEnabled ? PRIVATE_WORKBENCH_SURFACE_VERSION : PUBLIC_SURFACE_VERSION,
      toolNames: privateWorkbenchEnabled ? Object.freeze([...PUBLIC_TOOL_NAMES, ...PRIVATE_WORKBENCH_TOOL_NAMES]) : PUBLIC_TOOL_NAMES,
      defaultCwd,
      meteredConsentMode,
      privateWorkbenchEnabled,
      authorityValidation,
    };
  } catch (error) {
    try {
      await privateWorkbench?.close();
    } finally {
      try {
        await agentExecutor?.close();
      } finally {
        await publicContext?.close();
      }
    }
    throw error;
  }
}
