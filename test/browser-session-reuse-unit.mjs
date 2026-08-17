import assert from "node:assert/strict";
import path from "node:path";
import { CodexBrowserReaderExecutor } from "../src/browser-reader-executor.mjs";

const cwd = path.resolve(import.meta.dirname, "..");
let mode = "list";
const calls = [];
const context = {
  generation: 1,
  async browserPrerequisites() {
    return { status: "ok", chromeSkillPath: path.join(cwd, "fake", "skills", "control-chrome", "SKILL.md") };
  },
  async nodeReplCall({ arguments: args }) {
    const title = args?.title ?? "";
    const code = args?.code ?? "";
    calls.push({ title, code });
    if (title === "Check connected browser backends") {
      return { isError: false, text: JSON.stringify([{ name: "Chrome", family: "chrome", type: "extension" }]) };
    }
    if (title === "List current Chrome tabs") {
      assert.match(code, /__cxSessionTabs/);
      assert.match(code, /agentTabId/);
      return { isError: false, text: JSON.stringify([{ providerTabId: "provider-1", agentTabId: "agent-1", title: "Existing", url: "https://example.com/", lastOpened: null }]) };
    }
    if (title === "Read Workbench-created Chrome tab DOM") {
      assert.match(code, /tabs\.get\("agent-1"\)/);
      assert.doesNotMatch(code, /claimTab/);
      return { isError: false, text: `ERROR noisy page log before protocol output\n__CODEXZXM_JSON__${JSON.stringify({ title: "Existing", url: "https://example.com/", lastOpened: null, snapshot: "SESSION_REUSE_OK" })}\ntrailing diagnostic` };
    }
    if (title === "Open Workbench Chrome tab") {
      mode = "opened";
      return { isError: false, text: JSON.stringify({ providerTabId: "provider-new", agentTabId: "agent-new", title: "New", url: "https://example.org/", lastOpened: null }) };
    }
    if (title === "Read Workbench-created Chrome tab DOM" && mode === "opened") {
      return { isError: false, text: JSON.stringify({ title: "New", url: "https://example.org/", lastOpened: null, snapshot: "OPEN_REUSE_OK" }) };
    }
    throw new Error(`Unexpected browser unit call: ${title}`);
  },
};

const browser = new CodexBrowserReaderExecutor({ context, defaultCwd: cwd });
const listed = await browser.listTabs({ cwd });
assert.equal(listed.count, 1);
const read = await browser.readTab({ tabRef: listed.tabs[0].tabRef, cwd });
assert.equal(read.snapshot, "SESSION_REUSE_OK");

const opened = await browser.openTab({ url: "https://example.org/", cwd });
assert.equal(opened.created, true);
// Inspect the internal behavior through the generated code: after open, follow-up action must use tabs.get(agent-new), never claimTab.
context.nodeReplCall = async ({ arguments: args }) => {
  const title = args?.title ?? "";
  const code = args?.code ?? "";
  if (title === "Check connected browser backends") return { isError: false, text: JSON.stringify([{ name: "Chrome", family: "chrome", type: "extension" }]) };
  if (title === "Read Workbench-created Chrome tab DOM") {
    assert.match(code, /tabs\.get\("agent-new"\)/);
    assert.doesNotMatch(code, /claimTab/);
    return { isError: false, text: JSON.stringify({ title: "New", url: "https://example.org/", lastOpened: null, snapshot: "OPEN_REUSE_OK" }) };
  }
  throw new Error(`Unexpected follow-up browser unit call: ${title}`);
};
const openedRead = await browser.readTab({ tabRef: opened.tab.tabRef, cwd });
assert.equal(openedRead.snapshot, "OPEN_REUSE_OK");

let ownerAttempts = 0;
const ownerSession = "codexless-browser-owner-123";
const ownerContext = {
  generation: 1,
  async browserPrerequisites() {
    return { status: "ok", chromeSkillPath: path.join(cwd, "fake", "skills", "control-chrome", "SKILL.md") };
  },
  async nodeReplCall({ arguments: args, meta }) {
    const title = args?.title ?? "";
    const code = args?.code ?? "";
    const sessionId = meta?.["x-codex-turn-metadata"]?.session_id ?? null;
    if (title === "Check connected browser backends") {
      return { isError: false, text: JSON.stringify([{ name: "Chrome", family: "chrome", type: "extension" }]) };
    }
    if (title === "List current Chrome tabs") {
      return { isError: false, text: JSON.stringify([{ providerTabId: "provider-owned", agentTabId: null, title: "Owned", url: "https://owned.example/", lastOpened: null }]) };
    }
    if (title === "Read existing Chrome tab DOM") {
      ownerAttempts += 1;
      assert.match(code, /__cxAlreadyOwned/);
      if (sessionId !== ownerSession) {
        return { isError: true, text: `Tab 123 is already part of browser session ${ownerSession}` };
      }
      return { isError: false, text: `__CODEXZXM_JSON__${JSON.stringify({ agentTabId: "agent-owned", title: "Owned", url: "https://owned.example/", lastOpened: null, snapshot: "OWNER_SESSION_RECOVERED" })}` };
    }
    throw new Error(`Unexpected owner-session browser unit call: ${title}`);
  },
};
const ownerBrowser = new CodexBrowserReaderExecutor({ context: ownerContext, defaultCwd: cwd });
const ownerListed = await ownerBrowser.listTabs({ cwd });
const ownerRead = await ownerBrowser.readTab({ tabRef: ownerListed.tabs[0].tabRef, cwd });
assert.equal(ownerRead.snapshot, "OWNER_SESSION_RECOVERED");
assert.equal(ownerAttempts, 2, "owner session recovery must retry exactly once using the backend-returned session id");

console.log("Browser session reuse contract passed");
