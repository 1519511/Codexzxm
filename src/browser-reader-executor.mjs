import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_SNAPSHOT_CHARS = 80_000;
const MAX_SNAPSHOT_CHARS = 200_000;

export class BrowserReaderError extends Error {
  constructor(code, message, nextActions = []) {
    super(message);
    this.name = "BrowserReaderError";
    this.code = code;
    this.nextActions = nextActions;
  }
}

export class CodexBrowserReaderExecutor {
  #context;
  #defaultCwd;
  #sessionId = `codexless-browser-${randomUUID()}`;
  #turnSeq = 0;
  #browserClientUrl = null;
  #tabs = new Map();
  #providerToRef = new Map();
  #contextGeneration = 0;

  constructor({ context, defaultCwd }) {
    if (!context) throw new Error("CodexBrowserReaderExecutor requires public context executor");
    if (!defaultCwd) throw new Error("CodexBrowserReaderExecutor requires defaultCwd");
    this.#context = context;
    this.#defaultCwd = path.resolve(defaultCwd);
    this.#contextGeneration = this.#currentGeneration();
  }

  async recover({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const recovery = await this.#context.recover({ reason: "browser-recover" });
    this.#syncGeneration();
    const status = await this.status({ cwd: effectiveCwd });
    return {
      status: status.status,
      recovered: true,
      recovery,
      browserStatus: status,
      note: "Browser runtime context was restarted. All prior browser tabRef values are invalid; list tabs or open a new Workbench tab before the next action.",
    };
  }

  async status({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const dependency = await this.#dependencyStatus(effectiveCwd);
    if (dependency.status !== "ok") return dependency;
    try {
      const backends = await this.#listBackends(effectiveCwd);
      const chrome = backends.find((backend) => backend.family === "chrome");
      if (!chrome) {
        return {
          status: "unavailable",
          reason: "chrome_not_connected",
          chromeSkill: "ok",
          nodeRepl: "ok",
          connectedBrowsers: backends,
          nextActions: [
            "Open Chrome with the supported Codex Chrome extension/runtime enabled, then call codex.browser_status again.",
            "Browser Reader does not fall back to Computer Use.",
          ],
        };
      }
      return {
        status: "ok",
        chromeSkill: "ok",
        nodeRepl: "ok",
        chrome: sanitizeBackend(chrome),
        connectedBrowsers: backends.map(sanitizeBackend),
        authState: "site_specific_unknown",
        note: "Browser connectivity is healthy. Website login state is site-specific and is verified by reading the actual tab URL/page; Codexless does not infer authentication from extension connectivity alone.",
      };
    } catch (error) {
      return browserUnavailable(error);
    }
  }

  async listTabs({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    await this.#requireReady(effectiveCwd);
    const rawTabs = await this.#runJson(effectiveCwd, `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
const __cxTabs = await __cxBrowser.user.openTabs();
nodeRepl.write(JSON.stringify(__cxTabs.map((tab) => ({
  providerTabId: tab.providerTabId,
  title: tab.title ?? null,
  url: tab.url ?? null,
  lastOpened: tab.lastOpened ?? null,
}))));
`, "List current Chrome tabs");

    if (!Array.isArray(rawTabs)) {
      throw new BrowserReaderError("BROWSER_PROTOCOL_ERROR", "Chrome openTabs returned a non-array result");
    }

    const currentProviders = new Set();
    const tabs = [];
    for (const raw of rawTabs) {
      const providerTabId = typeof raw?.providerTabId === "string" ? raw.providerTabId : null;
      if (!providerTabId) continue;
      currentProviders.add(providerTabId);
      let tabRef = this.#providerToRef.get(providerTabId);
      if (!tabRef) {
        tabRef = `browser_tab_${randomUUID()}`;
        this.#providerToRef.set(providerTabId, tabRef);
      }
      const previous = this.#tabs.get(tabRef);
      const state = {
        ...previous,
        tabRef,
        providerTabId,
        agentTabId: null,
        createdByWorkbench: previous?.createdByWorkbench === true,
        contextGeneration: this.#contextGeneration,
        title: stringOrNull(raw.title),
        url: stringOrNull(raw.url),
        lastOpened: stringOrNull(raw.lastOpened),
        seenAt: Date.now(),
      };
      this.#tabs.set(tabRef, state);
      tabs.push(publicTab(state));
    }

    for (const [providerTabId, tabRef] of this.#providerToRef.entries()) {
      if (!currentProviders.has(providerTabId)) {
        this.#providerToRef.delete(providerTabId);
        this.#tabs.delete(tabRef);
      }
    }

    return {
      status: "ok",
      browser: "chrome",
      count: tabs.length,
      tabs,
      note: "tabRef values are opaque and valid only while this local runtime can still match the same open Chrome tab. Call codex.browser_tabs again after a backend restart or when a tab closes/moves unexpectedly.",
    };
  }

  async readTab({ tabRef, cwd = this.#defaultCwd, maxChars = DEFAULT_MAX_SNAPSHOT_CHARS }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserReaderError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > MAX_SNAPSHOT_CHARS) {
      throw new BrowserReaderError("BROWSER_MAX_CHARS_INVALID", `maxChars must be an integer between 1000 and ${MAX_SNAPSHOT_CHARS}`);
    }
    await this.#requireReady(effectiveCwd);
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserReaderError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current Chrome session."]
      );
    }

    let result;
    if (state.agentTabId) {
      const agentLiteral = JSON.stringify(state.agentTabId);
      result = await this.#runJson(effectiveCwd, `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
await __cxBrowser.nameSession("🧪 Codexless Workbench");
const __cxTabs = await __cxBrowser.tabs.list();
if (!__cxTabs.some((tab) => tab.id === ${agentLiteral})) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
const __cxTab = await __cxBrowser.tabs.get(${agentLiteral});
const __cxSnapshot = await __cxTab.playwright.domSnapshot();
await __cxTab.markHandoff();
nodeRepl.write(JSON.stringify({
  title: await __cxTab.title(),
  url: await __cxTab.url(),
  lastOpened: new Date().toISOString(),
  snapshot: __cxSnapshot,
}));
`, "Read Workbench-created Chrome tab DOM", { expectedGeneration: state.contextGeneration });
    } else {
      const providerLiteral = JSON.stringify(state.providerTabId);
      result = await this.#runJson(effectiveCwd, `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__cxInfo) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
const __cxTab = await __cxBrowser.user.claimTab(__cxInfo);
const __cxSnapshot = await __cxTab.playwright.domSnapshot();
const __cxPayload = {
  title: __cxInfo.title ?? null,
  url: __cxInfo.url ?? null,
  lastOpened: __cxInfo.lastOpened ?? null,
  snapshot: __cxSnapshot,
};
nodeRepl.write(JSON.stringify(__cxPayload));
`, "Read existing Chrome tab DOM", { expectedGeneration: state.contextGeneration });
    }

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    if (!snapshot && result?.snapshot !== "") {
      throw new BrowserReaderError("BROWSER_PROTOCOL_ERROR", "Chrome domSnapshot returned no text snapshot");
    }
    const truncated = snapshot.length > maxChars;
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: stringOrNull(result?.url) ?? state.url,
      lastOpened: stringOrNull(result?.lastOpened) ?? state.lastOpened,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, current);
    return {
      status: "ok",
      browser: "chrome",
      tab: publicTab(current),
      snapshot: truncated ? snapshot.slice(0, maxChars) : snapshot,
      snapshotChars: snapshot.length,
      returnedSnapshotChars: truncated ? maxChars : snapshot.length,
      snapshotTruncated: truncated,
      loadedContentOnly: true,
      authState: "site_specific_unknown",
      note: "Read-only snapshot of the currently loaded DOM. Codexless did not navigate, click, type, submit, or change page state. Lazy-loaded or virtualized content that is not currently present in the DOM may be absent.",
    };
  }

  async openTab({ url = null, cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    await this.#requireReady(effectiveCwd);
    const targetUrl = typeof url === "string" && url.trim() ? url.trim() : null;
    const result = await this.#runJson(effectiveCwd, `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
await __cxBrowser.nameSession("🧪 Codexless Workbench");
const __cxTab = await __cxBrowser.tabs.new();
if (${JSON.stringify(targetUrl)} !== null) {
  await __cxTab.goto(${JSON.stringify(targetUrl)});
  await __cxTab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 15000 }).catch(() => {});
}
await __cxTab.markHandoff();
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.id === __cxTab.id);
if (!__cxInfo?.providerTabId) throw new Error("CODEXLESS_BROWSER_PROVIDER_TAB_ID_MISSING");
nodeRepl.write(JSON.stringify({
  providerTabId: __cxInfo.providerTabId,
  title: __cxInfo.title ?? await __cxTab.title(),
  url: __cxInfo.url ?? await __cxTab.url(),
  lastOpened: __cxInfo.lastOpened ?? null,
}));
`, "Open Workbench Chrome tab");

    const providerTabId = typeof result?.providerTabId === "string" ? result.providerTabId : null;
    if (!providerTabId) throw new BrowserReaderError("BROWSER_PROTOCOL_ERROR", "Chrome tabs.new returned no provider tab id");
    const tabRef = `browser_tab_${randomUUID()}`;
    const state = {
      tabRef,
      providerTabId,
      agentTabId: null,
      createdByWorkbench: true,
      contextGeneration: this.#contextGeneration,
      title: stringOrNull(result?.title),
      url: stringOrNull(result?.url),
      lastOpened: stringOrNull(result?.lastOpened) ?? new Date().toISOString(),
      seenAt: Date.now(),
    };
    this.#providerToRef.set(providerTabId, tabRef);
    this.#tabs.set(tabRef, state);
    return { status: "ok", browser: "chrome", created: true, tab: publicTab(state) };
  }

  async navigateTab({ tabRef, url, cwd = this.#defaultCwd, timeoutMs = 15_000 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    const targetUrl = requireNonEmptyString(url, "url");
    const result = await this.#runTabAction(state, path.resolve(cwd), `
await __cxTab.goto(${JSON.stringify(targetUrl)});
await __cxTab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: ${normalizeBrowserTimeout(timeoutMs)} }).catch(() => {});
__cxActionResult = { navigated: true };
`, "Navigate Workbench Chrome tab");
    return this.#actionResponse(state, result, { navigated: true });
  }

  async reloadTab({ tabRef, cwd = this.#defaultCwd, timeoutMs = 15_000 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    const result = await this.#runTabAction(state, path.resolve(cwd), `
await __cxTab.reload();
await __cxTab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: ${normalizeBrowserTimeout(timeoutMs)} }).catch(() => {});
__cxActionResult = { reloaded: true };
`, "Reload Workbench Chrome tab");
    return this.#actionResponse(state, result, { reloaded: true });
  }

  async clickTab({ tabRef, locator, index = null, cwd = this.#defaultCwd, timeoutMs = 10_000 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    const locatorCode = browserLocatorCode(locator, index, "__cxLocator", "__cxCount");
    const result = await this.#runTabAction(state, path.resolve(cwd), `
${locatorCode}
await __cxLocator.click({ timeoutMs: ${normalizeBrowserTimeout(timeoutMs)} });
await __cxTab.playwright.waitForTimeout(100);
__cxActionResult = { matchedCount: __cxCount, clicked: true };
`, "Click Workbench Chrome element");
    return this.#actionResponse(state, result, result?.actionResult ?? { clicked: true });
  }

  async fillTab({ tabRef, locator, value, index = null, cwd = this.#defaultCwd, timeoutMs = 10_000 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    const text = typeof value === "string" ? value : String(value ?? "");
    const locatorCode = browserLocatorCode(locator, index, "__cxLocator", "__cxCount");
    const result = await this.#runTabAction(state, path.resolve(cwd), `
${locatorCode}
await __cxLocator.fill(${JSON.stringify(text)}, { timeoutMs: ${normalizeBrowserTimeout(timeoutMs)} });
__cxActionResult = { matchedCount: __cxCount, filled: true };
`, "Fill Workbench Chrome field");
    return this.#actionResponse(state, result, result?.actionResult ?? { filled: true });
  }

  async pressTab({ tabRef, locator, key, index = null, cwd = this.#defaultCwd, timeoutMs = 10_000 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    const keyValue = requireNonEmptyString(key, "key");
    const locatorCode = browserLocatorCode(locator, index, "__cxLocator", "__cxCount");
    const result = await this.#runTabAction(state, path.resolve(cwd), `
${locatorCode}
await __cxLocator.press(${JSON.stringify(keyValue)}, { timeoutMs: ${normalizeBrowserTimeout(timeoutMs)} });
__cxActionResult = { matchedCount: __cxCount, pressed: true };
`, "Press key in Workbench Chrome element");
    return this.#actionResponse(state, result, result?.actionResult ?? { pressed: true });
  }

  async selectTab({ tabRef, locator, option, index = null, cwd = this.#defaultCwd, timeoutMs = 10_000 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    const locatorCode = browserLocatorCode(locator, index, "__cxLocator", "__cxCount");
    const result = await this.#runTabAction(state, path.resolve(cwd), `
${locatorCode}
await __cxLocator.selectOption(${JSON.stringify(option)}, { timeoutMs: ${normalizeBrowserTimeout(timeoutMs)} });
__cxActionResult = { matchedCount: __cxCount, selected: true };
`, "Select Workbench Chrome option");
    return this.#actionResponse(state, result, result?.actionResult ?? { selected: true });
  }

  async waitTab({ tabRef, kind, state: waitState = null, url = null, locator = null, index = null, cwd = this.#defaultCwd, timeoutMs = 10_000 } = {}) {
    const tabState = await this.#actionState(tabRef, cwd);
    const timeout = normalizeBrowserTimeout(timeoutMs);
    let body;
    if (kind === "loadState") {
      const loadState = ["load", "domcontentloaded", "networkidle"].includes(waitState) ? waitState : "domcontentloaded";
      body = `await __cxTab.playwright.waitForLoadState({ state: ${JSON.stringify(loadState)}, timeoutMs: ${timeout} });\n__cxActionResult = { waited: true, kind: "loadState", state: ${JSON.stringify(loadState)} };`;
    } else if (kind === "url") {
      const targetUrl = requireNonEmptyString(url, "url");
      body = `await __cxTab.playwright.waitForURL(${JSON.stringify(targetUrl)}, { timeoutMs: ${timeout}, waitUntil: "domcontentloaded" });\n__cxActionResult = { waited: true, kind: "url" };`;
    } else if (kind === "locator") {
      const locatorCode = browserLocatorCode(locator, index, "__cxLocator", "__cxCount");
      const locatorState = ["attached", "detached", "visible", "hidden"].includes(waitState) ? waitState : "visible";
      body = `${locatorCode}\nawait __cxLocator.waitFor({ state: ${JSON.stringify(locatorState)}, timeoutMs: ${timeout} });\n__cxActionResult = { waited: true, kind: "locator", state: ${JSON.stringify(locatorState)}, matchedCount: __cxCount };`;
    } else if (kind === "timeout") {
      body = `await __cxTab.playwright.waitForTimeout(${timeout});\n__cxActionResult = { waited: true, kind: "timeout" };`;
    } else {
      throw new BrowserReaderError("BROWSER_WAIT_KIND_INVALID", "wait kind must be loadState, url, locator, or timeout");
    }
    const result = await this.#runTabAction(tabState, path.resolve(cwd), body, "Wait in Workbench Chrome tab");
    return this.#actionResponse(tabState, result, result?.actionResult ?? { waited: true });
  }

  async screenshotTab({ tabRef, cwd = this.#defaultCwd, fullPage = false, maxBytes = 5_000_000 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    if (!Number.isInteger(maxBytes) || maxBytes < 100_000 || maxBytes > 10_000_000) {
      throw new BrowserReaderError("BROWSER_SCREENSHOT_MAX_BYTES_INVALID", "maxBytes must be between 100000 and 10000000");
    }
    const result = await this.#runTabAction(state, path.resolve(cwd), `
const __cxBytes = await __cxTab.screenshot({ fullPage: ${fullPage === true} });
if (__cxBytes.byteLength > ${maxBytes}) throw new Error("CODEXLESS_BROWSER_SCREENSHOT_TOO_LARGE:" + __cxBytes.byteLength);
__cxActionResult = { mimeType: "image/png", byteLength: __cxBytes.byteLength, base64: Buffer.from(__cxBytes).toString("base64") };
`, "Screenshot Workbench Chrome tab");
    const shot = result?.actionResult;
    if (!shot || typeof shot.base64 !== "string") throw new BrowserReaderError("BROWSER_PROTOCOL_ERROR", "Chrome screenshot returned no image payload");
    return this.#actionResponse(state, result, shot);
  }

  async logsTab({ tabRef, cwd = this.#defaultCwd, levels = [], filter = null, limit = 100 } = {}) {
    const state = await this.#actionState(tabRef, cwd);
    const safeLevels = Array.isArray(levels) ? levels.filter((value) => ["debug", "info", "log", "warn", "error", "warning"].includes(value)) : [];
    const safeLimit = Number.isInteger(limit) ? Math.min(500, Math.max(1, limit)) : 100;
    const result = await this.#runTabAction(state, path.resolve(cwd), `
const __cxLogOptions = { limit: ${safeLimit} };
if (${safeLevels.length} > 0) __cxLogOptions.levels = ${JSON.stringify(safeLevels)};
if (${JSON.stringify(typeof filter === "string" && filter ? filter : null)} !== null) __cxLogOptions.filter = ${JSON.stringify(typeof filter === "string" && filter ? filter : null)};
const __cxLogs = await __cxTab.dev.logs(__cxLogOptions);
__cxActionResult = { logs: __cxLogs };
`, "Read Workbench Chrome console logs");
    return this.#actionResponse(state, result, result?.actionResult ?? { logs: [] });
  }

  async closeCreatedTab({ tabRef, cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const state = await this.#actionState(tabRef, cwd);
    if (state.createdByWorkbench !== true || !state.providerTabId) {
      throw new BrowserReaderError(
        "BROWSER_CLOSE_USER_TAB_REFUSED",
        "Workbench V2 only closes tabs it created itself; existing user Chrome tabs are never closed by this tool"
      );
    }
    const providerLiteral = JSON.stringify(state.providerTabId);
    await this.#runJson(effectiveCwd, `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
await __cxBrowser.nameSession("🧪 Codexless Workbench");
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
let __cxClosed = false;
if (__cxInfo) {
  const __cxAgentTabs = await __cxBrowser.tabs.list();
  if (__cxAgentTabs.some((tab) => tab.id === __cxInfo.id)) {
    const __cxTab = await __cxBrowser.tabs.get(__cxInfo.id);
    await __cxTab.close();
  } else {
    const __cxTab = await __cxBrowser.user.claimTab(__cxInfo);
    await __cxTab.close();
  }
  __cxClosed = true;
}
nodeRepl.write(JSON.stringify({ closed: __cxClosed }));
`, "Close Workbench-created Chrome tab", { expectedGeneration: state.contextGeneration });
    this.#providerToRef.delete(state.providerTabId);
    this.#tabs.delete(tabRef);
    return { status: "ok", browser: "chrome", tabRef, closed: true };
  }

  async #actionState(tabRef, cwd) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserReaderError("BROWSER_TAB_REF_REQUIRED", "tabRef is required");
    }
    await this.#requireReady(effectiveCwd);
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserReaderError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs for an existing user tab or workbench.browser_open for a new Workbench tab."]
      );
    }
    return state;
  }

  async #runTabAction(state, cwd, actionBody, title) {
    let body;
    if (state.agentTabId) {
      const agentLiteral = JSON.stringify(state.agentTabId);
      body = `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
await __cxBrowser.nameSession("🧪 Codexless Workbench");
const __cxTabs = await __cxBrowser.tabs.list();
if (!__cxTabs.some((tab) => tab.id === ${agentLiteral})) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
const __cxTab = await __cxBrowser.tabs.get(${agentLiteral});
let __cxActionResult = null;
${actionBody}
await __cxTab.markHandoff();
nodeRepl.write(JSON.stringify({ actionResult: __cxActionResult, title: await __cxTab.title(), url: await __cxTab.url() }));
`;
    } else {
      const providerLiteral = JSON.stringify(state.providerTabId);
      body = `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
await __cxBrowser.nameSession("🧪 Codexless Workbench");
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__cxInfo) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
const __cxTab = await __cxBrowser.user.claimTab(__cxInfo);
let __cxActionResult = null;
${actionBody}
const __cxPayload = { actionResult: __cxActionResult, title: await __cxTab.title(), url: await __cxTab.url() };
nodeRepl.write(JSON.stringify(__cxPayload));
`;
    }
    return this.#runJson(cwd, body, title, { expectedGeneration: state.contextGeneration });
  }

  #actionResponse(state, result, action) {
    state.title = stringOrNull(result?.title) ?? state.title;
    state.url = stringOrNull(result?.url) ?? state.url;
    state.lastOpened = new Date().toISOString();
    state.seenAt = Date.now();
    this.#tabs.set(state.tabRef, state);
    return { status: "ok", browser: "chrome", tab: publicTab(state), action };
  }

  #currentGeneration() {
    return Number.isInteger(this.#context?.generation) ? this.#context.generation : 0;
  }

  #syncGeneration() {
    const current = this.#currentGeneration();
    if (current === this.#contextGeneration) return false;
    this.#tabs.clear();
    this.#providerToRef.clear();
    this.#browserClientUrl = null;
    this.#sessionId = `codexless-browser-${randomUUID()}`;
    this.#turnSeq = 0;
    this.#contextGeneration = current;
    return true;
  }

  async #dependencyStatus(cwd) {
    try {
      const dependency = await this.#context.browserPrerequisites({ cwd });
      this.#syncGeneration();
      if (dependency.status !== "ok") {
        if (dependency.reason === "chrome_skill_unavailable") {
          return {
            status: "unavailable",
            reason: "chrome_skill_unavailable",
            chromeSkill: "missing",
            nodeRepl: "unknown",
            nextActions: [
              "Install/enable the current Codex Chrome Skill/plugin, then retry codex.browser_status.",
              "Browser Reader does not fall back to Computer Use.",
            ],
          };
        }
        return {
          status: "unavailable",
          reason: "node_repl_unavailable",
          chromeSkill: "ok",
          nodeRepl: "unavailable",
          nodeReplError: dependency.nodeReplError ?? null,
          nextActions: [
            "Restore the Codex node_repl MCP capability, then retry codex.browser_status.",
            "Browser Reader does not replace this path with generic Computer Use.",
          ],
        };
      }
      this.#browserClientUrl = this.#browserClientUrl ?? deriveBrowserClientUrl(dependency.chromeSkillPath);
      return { status: "ok", skillPathResolved: true, browserClientResolved: true };
    } catch (error) {
      this.#syncGeneration();
      return browserUnavailable(new BrowserReaderError(
        "BROWSER_DEPENDENCY_DISCOVERY_FAILED",
        `Could not read Codex Browser prerequisites: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  async #requireReady(cwd) {
    const dependency = await this.#dependencyStatus(cwd);
    if (dependency.status !== "ok") {
      throw new BrowserReaderError(
        dependency.reason ?? "BROWSER_UNAVAILABLE",
        `Browser dependencies are unavailable: ${dependency.reason ?? "unknown"}`,
        dependency.nextActions ?? ["Call codex.browser_status for current diagnostics."]
      );
    }
    const backends = await this.#listBackends(cwd);
    if (!backends.some((backend) => backend.family === "chrome")) {
      throw new BrowserReaderError(
        "BROWSER_CHROME_NOT_CONNECTED",
        "The Codex Browser runtime is available but no connected Chrome extension/backend is visible",
        [
          "Open Chrome with the supported Codex Chrome extension/runtime enabled, then retry.",
          "Call codex.browser_status to distinguish Browser setup from site login state.",
        ]
      );
    }
  }

  async #listBackends(cwd) {
    const result = await this.#runJson(cwd, `
const __cxBackends = await globalThis.__codexlessBrowserAgent.browsers.list();
nodeRepl.write(JSON.stringify(__cxBackends.map((backend) => ({
  name: backend.name ?? null,
  family: backend.family ?? null,
  type: backend.type ?? null,
}))));
`, "Check connected browser backends");
    return Array.isArray(result) ? result.map(sanitizeBackend) : [];
  }

  async #runJson(cwd, body, title, { expectedGeneration = null } = {}) {
    const clientUrl = await this.#resolveBrowserClientUrl(cwd);
    const bootstrap = `
if (globalThis.__codexlessBrowserAgent?.browsers == null) {
  const { setupBrowserRuntime } = await import(${JSON.stringify(clientUrl)});
  globalThis.__codexlessBrowserAgent = await setupBrowserRuntime();
}
`;
    let response;
    try {
      response = await this.#context.nodeReplCall({
        cwd,
        arguments: { code: `${bootstrap}\n{\n${body}\n}`, title },
        meta: this.#nextTurnMeta(),
        expectedGeneration,
      });
      this.#syncGeneration();
    } catch (error) {
      const generationChanged = this.#syncGeneration();
      const message = error instanceof Error ? error.message : String(error);
      if (/PUBLIC_CONTEXT_GENERATION_STALE/i.test(message) || generationChanged) {
        throw new BrowserReaderError(
          "BROWSER_RUNTIME_RESTARTED",
          "The local Codex context runtime restarted before this Browser request could safely use its prior tab state",
          ["Call codex.browser_tabs again and use a fresh tabRef from the current runtime generation."]
        );
      }
      throw classifyBrowserError(error);
    }
    if (response?.isError) {
      throw classifyBrowserError(new Error(response?.text ?? "node_repl browser call failed"));
    }
    const text = typeof response?.text === "string" ? response.text.trim() : "";
    if (!text) {
      throw new BrowserReaderError(
        "BROWSER_EMPTY_RESPONSE",
        "Browser runtime returned no text result",
        ["Call codex.browser_status and retry after confirming Chrome/node_repl health."]
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { return JSON.parse(lines[index]); }
        catch {}
      }
      throw new BrowserReaderError(
        "BROWSER_PROTOCOL_ERROR",
        `Browser runtime returned no parseable JSON result: ${text.slice(0, 1000)}`,
        ["Use codex.browser_status to confirm the current Browser plugin/runtime contract."]
      );
    }
  }

  async #resolveBrowserClientUrl(cwd) {
    if (this.#browserClientUrl) return this.#browserClientUrl;
    const dependency = await this.#dependencyStatus(cwd);
    if (dependency.status !== "ok" || !this.#browserClientUrl) {
      throw new BrowserReaderError(
        dependency.reason ?? "BROWSER_CLIENT_UNAVAILABLE",
        "Could not resolve the current Codex Chrome browser-client runtime",
        dependency.nextActions ?? []
      );
    }
    return this.#browserClientUrl;
  }

  #nextTurnMeta() {
    this.#turnSeq += 1;
    return {
      "x-codex-turn-metadata": {
        session_id: this.#sessionId,
        turn_id: `${this.#sessionId}-${this.#turnSeq}`,
      },
    };
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserReaderError("BROWSER_ARGUMENT_INVALID", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBrowserTimeout(value) {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new BrowserReaderError("BROWSER_TIMEOUT_INVALID", "timeoutMs must be an integer between 100 and 60000");
  }
  return value;
}

function browserLocatorCode(locator, index, variableName, countName) {
  if (!locator || typeof locator !== "object") {
    throw new BrowserReaderError("BROWSER_LOCATOR_INVALID", "locator must be an object");
  }
  const kind = locator.kind;
  const exact = locator.exact === true;
  let expression;
  if (kind === "role") {
    const role = requireNonEmptyString(locator.role, "locator.role");
    const options = {};
    if (typeof locator.name === "string" && locator.name.length) options.name = locator.name;
    if (Object.hasOwn(options, "name")) options.exact = exact;
    expression = `__cxTab.playwright.getByRole(${JSON.stringify(role)}, ${JSON.stringify(options)})`;
  } else if (kind === "text") {
    expression = `__cxTab.playwright.getByText(${JSON.stringify(requireNonEmptyString(locator.value, "locator.value"))}, { exact: ${exact} })`;
  } else if (kind === "label") {
    expression = `__cxTab.playwright.getByLabel(${JSON.stringify(requireNonEmptyString(locator.value, "locator.value"))}, { exact: ${exact} })`;
  } else if (kind === "placeholder") {
    expression = `__cxTab.playwright.getByPlaceholder(${JSON.stringify(requireNonEmptyString(locator.value, "locator.value"))}, { exact: ${exact} })`;
  } else if (kind === "testId") {
    expression = `__cxTab.playwright.getByTestId(${JSON.stringify(requireNonEmptyString(locator.value, "locator.value"))})`;
  } else if (kind === "css") {
    expression = `__cxTab.playwright.locator(${JSON.stringify(requireNonEmptyString(locator.value, "locator.value"))})`;
  } else {
    throw new BrowserReaderError("BROWSER_LOCATOR_KIND_INVALID", "locator.kind must be role, text, label, placeholder, testId, or css");
  }

  const resolvedIndex = index === null || index === undefined ? null : index;
  if (resolvedIndex !== null && (!Number.isInteger(resolvedIndex) || resolvedIndex < 0 || resolvedIndex > 10_000)) {
    throw new BrowserReaderError("BROWSER_LOCATOR_INDEX_INVALID", "index must be null or a non-negative integer");
  }
  return `
let ${variableName} = ${expression};
const ${countName} = await ${variableName}.count();
if (${resolvedIndex === null ? "true" : "false"}) {
  if (${countName} !== 1) throw new Error("CODEXLESS_BROWSER_LOCATOR_COUNT:" + ${countName});
} else {
  if (${resolvedIndex ?? 0} >= ${countName}) throw new Error("CODEXLESS_BROWSER_LOCATOR_INDEX:" + ${countName});
  ${variableName} = ${variableName}.nth(${resolvedIndex ?? 0});
}
`;
}

function deriveBrowserClientUrl(skillPath) {
  const skillDir = path.dirname(path.resolve(skillPath));
  const versionRoot = path.resolve(skillDir, "..", "..");
  const browserClientPath = path.join(versionRoot, "scripts", "browser-client.mjs");
  return pathToFileURL(browserClientPath).href;
}

function sanitizeBackend(backend) {
  return {
    name: stringOrNull(backend?.name),
    family: stringOrNull(backend?.family),
    type: stringOrNull(backend?.type),
  };
}

function publicTab(state) {
  return {
    tabRef: state.tabRef,
    title: state.title,
    url: state.url,
    lastOpened: state.lastOpened,
  };
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function browserUnavailable(error) {
  const classified = classifyBrowserError(error);
  return {
    status: "unavailable",
    reason: classified.code ?? "browser_unavailable",
    error: classified.message,
    nextActions: classified.nextActions ?? ["Retry codex.browser_status after restoring the Browser runtime."],
  };
}

function classifyBrowserError(error) {
  if (error instanceof BrowserReaderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/CODEXLESS_BROWSER_TAB_STALE/i.test(message)) {
    return new BrowserReaderError(
      "BROWSER_TAB_REF_STALE",
      "The selected Chrome tab is no longer present in the connected browser session",
      ["Call codex.browser_tabs again and use a fresh tabRef."]
    );
  }
  if (/Missing required Codex turn metadata/i.test(message)) {
    return new BrowserReaderError(
      "BROWSER_TURN_METADATA_REJECTED",
      "The Codex Browser runtime rejected the Browser Reader turn metadata",
      ["Refresh Codexless/Browser runtime and retry from codex.browser_status."]
    );
  }
  if (/timed out|kernel reset|node_repl.*unavailable|app-server exited|closed before pending/i.test(message)) {
    return new BrowserReaderError(
      "BROWSER_RUNTIME_RECOVERY_REQUIRED",
      message,
      [
        "Call workbench.browser_recover to restart the Browser/node_repl context.",
        "After recovery, obtain fresh tabRef values before retrying. Mutation actions are never replayed automatically because their outcome may be uncertain.",
      ]
    );
  }
  return new BrowserReaderError(
    "BROWSER_BACKEND_ERROR",
    message,
    ["Call codex.browser_status to inspect the current Chrome Skill/node_repl/backend state before retrying."]
  );
}
