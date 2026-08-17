import { randomUUID } from "node:crypto";
import path from "node:path";

const TERMINAL_DENY = [
  /(?:^|[\\/])cmd(?:\.exe)?$/i,
  /powershell/i,
  /(?:^|[\\/])pwsh(?:\.exe)?$/i,
  /windowsterminal/i,
  /windows terminal/i,
  /command prompt/i,
  /命令提示符/i,
  /terminal(?:\.app)?/i,
  /iterm/i,
  /warp/i,
  /alacritty/i,
  /终端/i,
];

const PROTECTED_APP_DENY = [
  /OpenAI\.Codex/i,
  /ChatGPT/i,
  /codex(?:\.exe| cli| extension|$)/i,
  /1password/i,
  /bitwarden/i,
  /keepass/i,
  /password manager/i,
  /密码管理/i,
  /Keychain Access/i,
  /钥匙串访问/i,
  /SecHealthUI/i,
  /WindowsSecurity/i,
  /Windows Security/i,
  /Windows 安全/i,
  /Defender/i,
  /SecurityHealth/i,
  /LockApp/i,
  /LogonUI/i,
  /CredentialUIBroker/i,
];

const WINDOWS_KEY_DENY = /(?:^|\+)(?:meta|windows?|win|cmd|command|super|os)(?:\+|$)/i;
const MAX_TEXT_CHARS = 200_000;

export class WorkbenchComputerUse {
  constructor({ context, defaultCwd }) {
    if (!context) throw new Error("WorkbenchComputerUse requires a Codex public context executor");
    if (!defaultCwd) throw new Error("WorkbenchComputerUse requires defaultCwd");
    this.context = context;
    this.defaultCwd = path.resolve(defaultCwd);
    this.windows = new Map();
    this.windowKeyToRef = new Map();
    this.observations = new Map();
    this.latestObservationByWindow = new Map();
  }

  async listApps({ cwd = this.defaultCwd, query = "", limit = 100 } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const payload = await this.#runJson(effectiveCwd, `
const __wbApps = await globalThis.__codexlessSky.list_apps();
nodeRepl.write(JSON.stringify(__wbApps.map((app) => ({
  id: app.id,
  displayName: app.displayName ?? null,
  isRunning: app.isRunning ?? null,
  lastUsedDate: app.lastUsedDate ?? null,
  useCount: app.useCount ?? null,
  windows: (app.windows ?? []).map((window) => ({ id: window.id, app: window.app, title: window.title ?? null })),
}))));
`, "List Windows apps");
    const needle = String(query ?? "").trim().toLowerCase();
    const rows = Array.isArray(payload) ? payload : [];
    const apps = rows
      .filter((app) => !needle || `${app?.id ?? ""} ${app?.displayName ?? ""}`.toLowerCase().includes(needle))
      .slice(0, clamp(limit, 1, 500, 100))
      .map((app) => ({
        id: app.id,
        displayName: app.displayName,
        isRunning: app.isRunning,
        lastUsedDate: app.lastUsedDate,
        useCount: app.useCount,
        blocked: isBlockedTarget({ app: app.id, title: app.displayName }),
        windows: (app.windows ?? []).map((window) => this.#rememberWindow(window)),
      }));
    return { count: apps.length, apps };
  }

  async listWindows({ cwd = this.defaultCwd, query = "", limit = 100 } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const payload = await this.#runJson(effectiveCwd, `
const __wbWindows = await globalThis.__codexlessSky.list_windows();
nodeRepl.write(JSON.stringify(__wbWindows.map((window) => ({ id: window.id, app: window.app, title: window.title ?? null }))));
`, "List Windows windows");
    const needle = String(query ?? "").trim().toLowerCase();
    const rows = Array.isArray(payload) ? payload : [];
    const windows = rows
      .filter((window) => !needle || `${window?.app ?? ""} ${window?.title ?? ""}`.toLowerCase().includes(needle))
      .slice(0, clamp(limit, 1, 500, 100))
      .map((window) => this.#rememberWindow(window));
    return { count: windows.length, windows };
  }

  async launchApp({ app, cwd = this.defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const appId = requireString(app, "app");
    assertAllowedTarget({ app: appId, title: null });
    await this.#runJson(effectiveCwd, `
await globalThis.__codexlessSky.launch_app({ app: ${JSON.stringify(appId)} });
nodeRepl.write(JSON.stringify({ launched: true }));
`, "Launch Windows app");
    return { status: "ok", app: appId, launched: true };
  }

  async activateWindow({ windowRef, cwd = this.defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const state = this.#requireWindow(windowRef);
    assertAllowedTarget(state);
    const payload = await this.#runJson(effectiveCwd, windowPrelude(state) + `
await globalThis.__codexlessSky.activate_window({ window: __wbWindow });
nodeRepl.write(JSON.stringify({ activated: true, window: __wbWindow }));
`, "Activate Windows window");
    this.#refreshWindow(windowRef, payload?.window ?? state);
    return { status: "ok", activated: true, window: this.#publicWindow(this.windows.get(windowRef)) };
  }

  async observe({ windowRef, cwd = this.defaultCwd, includeScreenshot = true, includeText = true } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const state = this.#requireWindow(windowRef);
    assertAllowedTarget(state);
    const call = await this.#runState(effectiveCwd, state, { includeScreenshot, includeText }, "Observe Windows window");
    return this.#storeObservation(windowRef, call);
  }

  async click({ observationRef, elementIndex = null, screenshotId = null, x = null, y = null, mouseButton = "left", clickCount = 1, cwd = this.defaultCwd } = {}) {
    const observation = this.#consumeObservation(observationRef);
    const effectiveCwd = path.resolve(cwd);
    const button = ["left", "right", "middle", "l", "r", "m"].includes(mouseButton) ? mouseButton : "left";
    const count = clamp(clickCount, 1, 3, 1);
    let action;
    if (elementIndex !== null && elementIndex !== undefined) {
      requireAccessibility(observation);
      const index = requireNonNegativeInt(elementIndex, "elementIndex");
      action = `await globalThis.__codexlessSky.click({ window: __wbWindow, element_index: ${index}, mouse_button: ${JSON.stringify(button)}, click_count: ${count} });`;
    } else {
      requireScreenshot(observation);
      const sid = requireScreenshotId(observation, screenshotId);
      const px = requireFiniteNumber(x, "x");
      const py = requireFiniteNumber(y, "y");
      action = `await globalThis.__codexlessSky.click({ window: __wbWindow, screenshotId: ${JSON.stringify(sid)}, x: ${px}, y: ${py}, mouse_button: ${JSON.stringify(button)}, click_count: ${count} });`;
    }
    return this.#actAndRefresh({ observation, cwd: effectiveCwd, action, title: "Click Windows UI" });
  }

  async setValue({ observationRef, elementIndex, value, cwd = this.defaultCwd } = {}) {
    const observation = this.#consumeObservation(observationRef);
    requireAccessibility(observation);
    const effectiveCwd = path.resolve(cwd);
    const index = requireNonNegativeInt(elementIndex, "elementIndex");
    const text = boundedText(value);
    const action = `await globalThis.__codexlessSky.set_value({ window: __wbWindow, element_index: ${index}, value: ${JSON.stringify(text)} });`;
    return this.#actAndRefresh({ observation, cwd: effectiveCwd, action, title: "Set Windows UI value" });
  }

  async typeText({ observationRef, text, cwd = this.defaultCwd } = {}) {
    const observation = this.#consumeObservation(observationRef);
    if (!observation.focusedElement) throw computerError("COMPUTER_FOCUS_REQUIRED", "type_text requires an observation with a focused element; reobserve with includeText=true after focusing the intended editable surface");
    const effectiveCwd = path.resolve(cwd);
    const value = boundedText(text);
    const action = `await globalThis.__codexlessSky.type_text({ window: __wbWindow, text: ${JSON.stringify(value)} });`;
    return this.#actAndRefresh({ observation, cwd: effectiveCwd, action, title: "Type into Windows UI" });
  }

  async pressKey({ observationRef, key, cwd = this.defaultCwd } = {}) {
    const observation = this.#consumeObservation(observationRef);
    const effectiveCwd = path.resolve(cwd);
    const chord = requireString(key, "key");
    if (WINDOWS_KEY_DENY.test(chord)) throw computerError("COMPUTER_WINDOWS_KEY_REFUSED", "Windows/Meta/Cmd/Super key shortcuts are forbidden by the Computer Use safety contract");
    const action = `await globalThis.__codexlessSky.press_key({ window: __wbWindow, key: ${JSON.stringify(chord)} });`;
    return this.#actAndRefresh({ observation, cwd: effectiveCwd, action, title: "Press Windows key chord" });
  }

  async scroll({ observationRef, screenshotId, x, y, scrollX = 0, scrollY, cwd = this.defaultCwd } = {}) {
    const observation = this.#consumeObservation(observationRef);
    requireScreenshot(observation);
    const effectiveCwd = path.resolve(cwd);
    const sid = requireScreenshotId(observation, screenshotId);
    const px = requireFiniteNumber(x, "x");
    const py = requireFiniteNumber(y, "y");
    const sx = requireFiniteNumber(scrollX, "scrollX");
    const sy = requireFiniteNumber(scrollY, "scrollY");
    const action = `await globalThis.__codexlessSky.scroll({ window: __wbWindow, screenshotId: ${JSON.stringify(sid)}, x: ${px}, y: ${py}, scrollX: ${sx}, scrollY: ${sy} });`;
    return this.#actAndRefresh({ observation, cwd: effectiveCwd, action, title: "Scroll Windows UI" });
  }

  async drag({ observationRef, screenshotId, fromX, fromY, toX, toY, cwd = this.defaultCwd } = {}) {
    const observation = this.#consumeObservation(observationRef);
    requireScreenshot(observation);
    const effectiveCwd = path.resolve(cwd);
    const sid = requireScreenshotId(observation, screenshotId);
    const action = `await globalThis.__codexlessSky.drag({ window: __wbWindow, screenshotId: ${JSON.stringify(sid)}, from_x: ${requireFiniteNumber(fromX, "fromX")}, from_y: ${requireFiniteNumber(fromY, "fromY")}, to_x: ${requireFiniteNumber(toX, "toX")}, to_y: ${requireFiniteNumber(toY, "toY")} });`;
    return this.#actAndRefresh({ observation, cwd: effectiveCwd, action, title: "Drag Windows UI" });
  }

  async secondaryAction({ observationRef, elementIndex, action: actionName, cwd = this.defaultCwd } = {}) {
    const observation = this.#consumeObservation(observationRef);
    requireAccessibility(observation);
    const effectiveCwd = path.resolve(cwd);
    const index = requireNonNegativeInt(elementIndex, "elementIndex");
    const name = requireString(actionName, "action");
    const action = `await globalThis.__codexlessSky.perform_secondary_action({ window: __wbWindow, element_index: ${index}, action: ${JSON.stringify(name)} });`;
    return this.#actAndRefresh({ observation, cwd: effectiveCwd, action, title: "Perform Windows secondary action" });
  }

  #rememberWindow(raw) {
    if (!raw || !Number.isInteger(raw.id) || typeof raw.app !== "string") return null;
    const key = `${raw.app}\u0000${raw.id}`;
    let windowRef = this.windowKeyToRef.get(key);
    if (!windowRef) {
      windowRef = `computer_window_${randomUUID()}`;
      this.windowKeyToRef.set(key, windowRef);
    }
    const state = { windowRef, id: raw.id, app: raw.app, title: typeof raw.title === "string" ? raw.title : null };
    this.windows.set(windowRef, state);
    return this.#publicWindow(state);
  }

  #refreshWindow(windowRef, raw) {
    const previous = this.windows.get(windowRef);
    if (!previous) return;
    const next = {
      ...previous,
      id: Number.isInteger(raw?.id) ? raw.id : previous.id,
      app: typeof raw?.app === "string" ? raw.app : previous.app,
      title: typeof raw?.title === "string" ? raw.title : previous.title,
    };
    assertAllowedTarget(next);
    this.windows.set(windowRef, next);
  }

  #publicWindow(state) {
    return { windowRef: state.windowRef, app: state.app, id: state.id, title: state.title, blocked: isBlockedTarget(state) };
  }

  #requireWindow(windowRef) {
    const ref = requireString(windowRef, "windowRef");
    const state = this.windows.get(ref);
    if (!state) throw computerError("COMPUTER_WINDOW_REF_UNKNOWN", `unknown or stale windowRef: ${ref}; call workbench.computer_apps or workbench.computer_windows again`);
    return state;
  }

  #consumeObservation(observationRef) {
    const ref = requireString(observationRef, "observationRef");
    const observation = this.observations.get(ref);
    if (!observation || observation.consumed) throw computerError("COMPUTER_OBSERVATION_STALE", `unknown, consumed, or stale observationRef: ${ref}; observe the window again before acting`);
    const latest = this.latestObservationByWindow.get(observation.windowRef);
    if (latest !== ref) throw computerError("COMPUTER_OBSERVATION_STALE", "a newer observation exists for this window; use the newest observationRef");
    observation.consumed = true;
    this.latestObservationByWindow.delete(observation.windowRef);
    return observation;
  }

  async #actAndRefresh({ observation, cwd, action, title }) {
    const state = this.#requireWindow(observation.windowRef);
    assertAllowedTarget(state);
    try {
      const result = await this.#runState(cwd, state, { includeScreenshot: true, includeText: true }, title, action);
      return this.#storeObservation(observation.windowRef, result, { actionApplied: true });
    } catch (error) {
      if (error?.code === "COMPUTER_BACKEND_ERROR" && /window is not a usable app window/i.test(error.message ?? "")) {
        const listed = await this.listWindows({ cwd, limit: 500 });
        const stillOpen = listed.windows.some((window) => window.id === state.id && window.app === state.app);
        if (!stillOpen) {
          this.windows.delete(observation.windowRef);
          this.latestObservationByWindow.delete(observation.windowRef);
          return {
            status: "ok",
            actionApplied: true,
            windowClosed: true,
            observationRef: null,
            window: this.#publicWindow(state),
            accessibility: null,
            screenshots: [],
            contentItems: [],
          };
        }
      }
      throw error;
    }
  }

  async #runState(cwd, state, options, title, action = null) {
    const includeScreenshot = options.includeScreenshot !== false;
    const includeText = options.includeText === true;
    const code = windowPrelude(state) + `
${action ? `${action}\n` : ""}
const __wbState = await globalThis.__codexlessSky.get_window_state({ window: __wbWindow, include_screenshot: ${includeScreenshot}, include_text: ${includeText} });
nodeRepl.write(JSON.stringify({
  window: __wbState.window,
  accessibility: __wbState.accessibility,
  screenshots: (__wbState.screenshots ?? []).map((shot) => ({ id: shot.id, width: shot.width ?? null, height: shot.height ?? null, originX: shot.originX ?? null, originY: shot.originY ?? null, zIndex: shot.zIndex ?? null })),
}));
`;
    const raw = await this.#callJs(cwd, code, title);
    const data = parseJsonTail(raw.text);
    if (!data?.window) throw computerError("COMPUTER_PROTOCOL_ERROR", "Computer Use state call returned no window state JSON");
    return { data, contentItems: raw.contentItems };
  }

  #storeObservation(windowRef, call, extra = {}) {
    const data = call.data;
    this.#refreshWindow(windowRef, data.window);
    const previous = this.latestObservationByWindow.get(windowRef);
    if (previous && this.observations.has(previous)) this.observations.get(previous).consumed = true;
    const observationRef = `computer_obs_${randomUUID()}`;
    const screenshots = Array.isArray(data.screenshots) ? data.screenshots : [];
    const accessibility = data.accessibility && typeof data.accessibility === "object" ? data.accessibility : null;
    const observation = {
      observationRef,
      windowRef,
      window: this.windows.get(windowRef),
      screenshots,
      screenshotIds: screenshots.map((shot) => shot.id).filter((value) => typeof value === "string"),
      accessibility,
      focusedElement: typeof accessibility?.focused_element === "string" ? accessibility.focused_element : null,
      consumed: false,
      createdAt: Date.now(),
    };
    this.observations.set(observationRef, observation);
    this.latestObservationByWindow.set(windowRef, observationRef);
    return {
      status: "ok",
      ...extra,
      observationRef,
      window: this.#publicWindow(observation.window),
      accessibility,
      screenshots,
      contentItems: call.contentItems,
    };
  }

  async #runJson(cwd, body, title) {
    const raw = await this.#callJs(cwd, body, title);
    return parseJsonTail(raw.text);
  }

  async #callJs(cwd, body, title) {
    const code = `
if (!globalThis.__codexlessSky) {
  const { sky } = await import("@oai/sky");
  globalThis.__codexlessSky = sky;
}
{
${body}
}
`;
    const result = await this.context.mcpToolCall({
      server: "node_repl",
      tool: "js",
      cwd,
      arguments: { code, title },
      timeoutMs: 60_000,
    });
    if (result.isError) throw computerError("COMPUTER_BACKEND_ERROR", result.text ?? "Computer Use node_repl call failed");
    return result;
  }
}

function windowPrelude(state) {
  return `
const __wbWindow = await globalThis.__codexlessSky.get_window({ id: ${state.id}, app: ${JSON.stringify(state.app)} });
`;
}

function parseJsonTail(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) throw computerError("COMPUTER_EMPTY_RESPONSE", "Computer Use returned no text result");
  try { return JSON.parse(value); } catch {}
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  throw computerError("COMPUTER_PROTOCOL_ERROR", `Computer Use returned no parseable JSON result: ${value.slice(0, 1000)}`);
}

function isBlockedTarget({ app, title }) {
  const text = `${app ?? ""}\n${title ?? ""}`;
  return [...TERMINAL_DENY, ...PROTECTED_APP_DENY].some((pattern) => pattern.test(text));
}

function assertAllowedTarget(state) {
  if (isBlockedTarget(state)) {
    throw computerError("COMPUTER_TARGET_REFUSED", `Computer Use safety contract refuses target app/window: ${state?.app ?? "unknown"} / ${state?.title ?? ""}`);
  }
}

function requireAccessibility(observation) {
  if (!observation.accessibility) throw computerError("COMPUTER_ACCESSIBILITY_REQUIRED", "this action requires a fresh accessibility observation; call workbench.computer_state with includeText=true");
}

function requireScreenshot(observation) {
  if (!observation.screenshotIds.length) throw computerError("COMPUTER_SCREENSHOT_REQUIRED", "this action requires a fresh screenshot observation; call workbench.computer_state with includeScreenshot=true");
}

function requireScreenshotId(observation, screenshotId) {
  const id = requireString(screenshotId, "screenshotId");
  if (!observation.screenshotIds.includes(id)) throw computerError("COMPUTER_SCREENSHOT_STALE", "screenshotId did not come from the supplied fresh observationRef");
  return id;
}

function requireNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) throw computerError("COMPUTER_ARGUMENT_INVALID", `${name} must be a non-negative integer`);
  return value;
}

function requireFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw computerError("COMPUTER_ARGUMENT_INVALID", `${name} must be a finite number`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw computerError("COMPUTER_ARGUMENT_INVALID", `${name} must be a non-empty string`);
  return value.trim();
}

function boundedText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length > MAX_TEXT_CHARS) throw computerError("COMPUTER_TEXT_TOO_LARGE", `text exceeds ${MAX_TEXT_CHARS} characters`);
  return text;
}

function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function computerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
