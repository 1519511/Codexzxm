import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KNOWN_THINKING = new Set(["极速", "中", "高", "极高", "Pro"]);

export class WorkbenchProBridge {
  constructor({ browser, stateDir = null, defaultCwd }) {
    if (!browser) throw new Error("WorkbenchProBridge requires browser executor");
    if (!defaultCwd) throw new Error("WorkbenchProBridge requires defaultCwd");
    this.browser = browser;
    this.defaultCwd = path.resolve(defaultCwd);
    this.stateDir = path.resolve(stateDir ?? path.join(os.homedir(), ".config", "codexzxm", "pro-bridge-v1"));
  }

  async start({ prompt, thinking = "Pro", files = [], cwd = this.defaultCwd, title = null } = {}) {
    const task = typeof prompt === "string" ? prompt.trim() : "";
    if (!task || task.length > 180000) throw bridgeError("PRO_BRIDGE_PROMPT_INVALID", "prompt must contain 1-180000 characters");
    if (!KNOWN_THINKING.has(thinking)) throw bridgeError("PRO_BRIDGE_THINKING_INVALID", `thinking must be one of: ${[...KNOWN_THINKING].join(", ")}`);
    if (!Array.isArray(files) || files.length > 20) throw bridgeError("PRO_BRIDGE_FILES_INVALID", "files must be an array with at most 20 paths");
    const effectiveCwd = path.resolve(cwd);
    const bridgeRef = `probridge_${randomUUID()}`;
    const marker = `[CODEXZXM PRO BRIDGE ${bridgeRef}]`;

    const opened = await this.browser.openTab({ url: "https://chatgpt.com/", cwd: effectiveCwd });
    const tabRef = opened?.tab?.tabRef;
    if (!tabRef) throw bridgeError("PRO_BRIDGE_TAB_OPEN_FAILED", "ChatGPT Web bridge did not receive a tabRef");
    let snapshot = (await this.browser.readTab({ tabRef, cwd: effectiveCwd, maxChars: 120000 })).snapshot;
    if (!/textbox "(?:与 ChatGPT 聊天|Message ChatGPT)"/.test(snapshot)) {
      throw bridgeError("PRO_BRIDGE_NOT_AUTHENTICATED", "ChatGPT Web composer was not visible in the dedicated Chrome tab; ensure the requested Chrome profile is signed in");
    }

    const selectedThinking = await this.#selectThinking({ tabRef, cwd: effectiveCwd, snapshot, thinking });
    if (files.length) await this.#uploadFiles({ tabRef, cwd: effectiveCwd, files, snapshot: (await this.browser.readTab({ tabRef, cwd: effectiveCwd, maxChars: 120000 })).snapshot });

    const baseline = await this.browser.queryTab({ tabRef, locator: { kind: "css", value: '[data-message-author-role="assistant"]' }, cwd: effectiveCwd, maxChars: 200000 });
    const baselineAssistantCount = baseline?.action?.matchedCount ?? 0;
    snapshot = (await this.browser.readTab({ tabRef, cwd: effectiveCwd, maxChars: 120000 })).snapshot;
    const composerLabel = snapshot.includes('textbox "与 ChatGPT 聊天"') ? "与 ChatGPT 聊天" : "Message ChatGPT";
    await this.browser.fillTab({ tabRef, locator: { kind: "label", value: composerLabel, exact: true }, value: `${marker}\n${title ? `${title}\n\n` : ""}${task}`, cwd: effectiveCwd, timeoutMs: 15000 });

    const afterFill = (await this.browser.readTab({ tabRef, cwd: effectiveCwd, maxChars: 120000 })).snapshot;
    const sendName = afterFill.includes('button "发送提示"') ? "发送提示" : afterFill.includes('button "Send prompt"') ? "Send prompt" : afterFill.includes('button "Send"') ? "Send" : null;
    if (!sendName) throw bridgeError("PRO_BRIDGE_SEND_BUTTON_NOT_FOUND", "ChatGPT Web send button was not visible after filling the dedicated composer");
    await this.browser.clickTab({ tabRef, locator: { kind: "role", role: "button", name: sendName, exact: true }, cwd: effectiveCwd, timeoutMs: 15000 });
    await this.browser.waitTab({ tabRef, kind: "timeout", cwd: effectiveCwd, timeoutMs: 500 });
    const current = await this.browser.readTab({ tabRef, cwd: effectiveCwd, maxChars: 120000 });

    const state = {
      version: 1,
      bridgeRef,
      mode: "reasoning",
      requestedThinking: thinking,
      visibleThinking: selectedThinking,
      marker,
      tabRef,
      conversationUrl: current?.tab?.url ?? "https://chatgpt.com/",
      baselineAssistantCount,
      cwd: effectiveCwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "in_progress",
      title: title === null ? null : String(title).slice(0, 500),
      fileCount: files.length,
    };
    await this.#writeState(state);
    return publicState(state);
  }

  async status({ bridgeRef, cwd = null } = {}) {
    const state = await this.#readState(bridgeRef);
    const effectiveCwd = path.resolve(cwd ?? state.cwd ?? this.defaultCwd);
    const tabRef = await this.#recoverTabRef(state, effectiveCwd);
    const assistants = await this.browser.queryTab({ tabRef, locator: { kind: "css", value: '[data-message-author-role="assistant"]' }, cwd: effectiveCwd, maxChars: 300000 });
    const texts = Array.isArray(assistants?.action?.texts) ? assistants.action.texts : [];
    const stopZh = await this.browser.queryTab({ tabRef, locator: { kind: "role", role: "button", name: "停止回答", exact: true }, cwd: effectiveCwd, maxChars: 5000 });
    const stopEn = stopZh?.action?.matchedCount ? { action: { matchedCount: 0 } } : await this.browser.queryTab({ tabRef, locator: { kind: "role", role: "button", name: "Stop generating", exact: true }, cwd: effectiveCwd, maxChars: 5000 });
    const active = (stopZh?.action?.matchedCount ?? 0) > 0 || (stopEn?.action?.matchedCount ?? 0) > 0;
    const newTexts = texts.slice(state.baselineAssistantCount).map((value) => String(value).trim()).filter(Boolean);
    const current = await this.browser.readTab({ tabRef, cwd: effectiveCwd, maxChars: 60000 });
    state.tabRef = tabRef;
    state.conversationUrl = current?.tab?.url ?? state.conversationUrl;
    state.updatedAt = new Date().toISOString();

    if (newTexts.length && !active) {
      state.status = "completed";
      state.answer = newTexts.at(-1);
      state.completedAt = new Date().toISOString();
    } else {
      state.status = "in_progress";
      delete state.answer;
    }
    await this.#writeState(state);
    return publicState(state);
  }

  async close({ bridgeRef } = {}) {
    const state = await this.#readState(bridgeRef);
    if (state.tabRef) {
      try { await this.browser.closeCreatedTab({ tabRef: state.tabRef, cwd: state.cwd ?? this.defaultCwd }); } catch {}
    }
    state.status = state.status === "completed" ? "completed" : "closed";
    state.closedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    await this.#writeState(state);
    return publicState(state);
  }

  async #selectThinking({ tabRef, cwd, snapshot, thinking }) {
    const current = extractThinkingButton(snapshot);
    if (current === thinking) return thinking;
    if (!current) throw bridgeError("PRO_BRIDGE_THINKING_BUTTON_NOT_FOUND", "could not identify the current visible ChatGPT thinking-level button");
    await this.browser.clickTab({ tabRef, locator: { kind: "role", role: "button", name: current, exact: true }, cwd, timeoutMs: 10000 });
    let menu = (await this.browser.readTab({ tabRef, cwd, maxChars: 100000 })).snapshot;
    if (!snapshotContainsExactLabel(menu, thinking)) {
      const advanced = menu.includes('"显示高级选项"') ? "显示高级选项" : menu.includes('"高级"') ? "高级" : null;
      if (advanced) {
        await this.#clickNoSideEffectFallback(tabRef, cwd, [
          { kind: "role", role: "menuitem", name: advanced, exact: true },
          { kind: "text", value: advanced, exact: true },
        ]);
        menu = (await this.browser.readTab({ tabRef, cwd, maxChars: 100000 })).snapshot;
      }
    }
    if (!snapshotContainsExactLabel(menu, thinking)) throw bridgeError("PRO_BRIDGE_THINKING_NOT_VISIBLE", `requested thinking level '${thinking}' is not visibly available in ChatGPT Web`);
    await this.#clickNoSideEffectFallback(tabRef, cwd, [
      { kind: "role", role: "menuitemradio", name: thinking, exact: true },
      { kind: "text", value: thinking, exact: true },
    ]);
    const verified = (await this.browser.readTab({ tabRef, cwd, maxChars: 100000 })).snapshot;
    const selected = extractThinkingButton(verified);
    if (selected !== thinking) throw bridgeError("PRO_BRIDGE_THINKING_VERIFY_FAILED", `ChatGPT Web did not visibly confirm thinking level '${thinking}' after selection`);
    return selected;
  }

  async #uploadFiles({ tabRef, cwd, files, snapshot }) {
    const inputQuery = await this.browser.queryTab({ tabRef, locator: { kind: "css", value: 'input[type="file"]' }, cwd, maxChars: 5000 });
    if ((inputQuery?.action?.matchedCount ?? 0) === 0) {
      const addName = snapshot.includes('button "添加文件等"') ? "添加文件等" : snapshot.includes('button "Add files"') ? "Add files" : null;
      if (!addName) throw bridgeError("PRO_BRIDGE_UPLOAD_CONTROL_NOT_FOUND", "ChatGPT Web file upload control was not visible");
      await this.browser.clickTab({ tabRef, locator: { kind: "role", role: "button", name: addName, exact: true }, cwd, timeoutMs: 10000 });
    }
    await this.browser.uploadTab({ tabRef, locator: { kind: "css", value: 'input[type="file"]' }, paths: files, cwd, timeoutMs: 20000 });
  }

  async #clickNoSideEffectFallback(tabRef, cwd, locators) {
    let lastError = null;
    for (const locator of locators) {
      try { return await this.browser.clickTab({ tabRef, locator, cwd, timeoutMs: 10000 }); }
      catch (error) {
        lastError = error;
        if (/timed out|runtime restarted|uncertain/i.test(error?.message ?? "")) throw error;
      }
    }
    throw lastError ?? bridgeError("PRO_BRIDGE_CLICK_FAILED", "could not click visible ChatGPT Web control");
  }

  async #recoverTabRef(state, cwd) {
    if (state.tabRef) {
      try { await this.browser.readTab({ tabRef: state.tabRef, cwd, maxChars: 10000 }); return state.tabRef; } catch {}
    }
    const listed = await this.browser.listTabs({ cwd });
    const candidates = listed.tabs.filter((tab) => tab.url === state.conversationUrl || (state.conversationUrl === "https://chatgpt.com/" && tab.url === "https://chatgpt.com/"));
    if (!candidates.length) throw bridgeError("PRO_BRIDGE_TAB_LOST", "the dedicated ChatGPT Web bridge tab is no longer open; the reasoning task cannot be polled safely");
    state.tabRef = candidates[0].tabRef;
    return state.tabRef;
  }

  async #readState(bridgeRef) {
    const ref = requireBridgeRef(bridgeRef);
    try { return JSON.parse(await readFile(path.join(this.stateDir, `${ref}.json`), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") throw bridgeError("PRO_BRIDGE_NOT_FOUND", `unknown pro bridge task: ${ref}`); throw error; }
  }

  async #writeState(state) {
    await mkdir(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, `${state.bridgeRef}.json`);
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  }
}

function publicState(state) {
  return {
    bridgeRef: state.bridgeRef,
    status: state.status,
    mode: state.mode,
    requestedThinking: state.requestedThinking,
    visibleThinking: state.visibleThinking,
    conversationUrl: state.conversationUrl,
    answer: state.answer ?? null,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt ?? null,
    fileCount: state.fileCount ?? 0,
    apiBillingUsed: false,
    codexModelTurnUsed: false,
    route: "chatgpt_web_subscription",
  };
}

function extractThinkingButton(snapshot) {
  const matches = [...String(snapshot ?? "").matchAll(/- button "(极速|中|高|极高|Pro)"/g)].map((match) => match[1]);
  return matches.length ? matches.at(-1) : null;
}

function snapshotContainsExactLabel(snapshot, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:menuitemradio|menuitem|button|radio) "${escaped}"|text: ${escaped}(?:\\n|$)`).test(String(snapshot ?? ""));
}

function requireBridgeRef(value) {
  if (typeof value !== "string" || !/^probridge_[0-9a-f-]{36}$/i.test(value)) throw bridgeError("PRO_BRIDGE_REF_INVALID", `invalid bridgeRef: ${String(value)}`);
  return value;
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
