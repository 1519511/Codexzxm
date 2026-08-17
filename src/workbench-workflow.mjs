import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const WORKFLOW_STEP_TYPES = Object.freeze([
  "fs_create", "fs_write", "fs_mkdir", "fs_move", "fs_copy", "fs_delete", "fs_metadata", "fs_copy_tree", "fs_archive_create", "fs_archive_extract", "fs_delete_tree_plan", "fs_delete_tree_commit",
  "process_start", "pty_start",
  "git_stage", "git_commit_staged", "git_fetch", "git_pull", "git_push",
  "browser_open", "browser_navigate", "browser_back", "browser_forward", "browser_dialog", "browser_click", "browser_fill", "browser_upload", "browser_download",
  "mcp_call", "pro_reason",
]);
const STEP_TYPE_SET = new Set(WORKFLOW_STEP_TYPES);

export class WorkbenchWorkflowEngine {
  constructor({ components, roots, stateDir = null, defaultCwd }) {
    if (!components || typeof components !== "object") throw new Error("WorkbenchWorkflowEngine requires components");
    if (!roots) throw new Error("WorkbenchWorkflowEngine requires permanent root registry");
    if (!defaultCwd) throw new Error("WorkbenchWorkflowEngine requires defaultCwd");
    this.components = components;
    this.roots = roots;
    this.defaultCwd = path.resolve(defaultCwd);
    this.stateDir = path.resolve(stateDir ?? path.join(os.homedir(), ".config", "codexzxm", "workflows-v1"));
  }

  validateDefinition({ rootAlias, basePath = ".", steps }) {
    if (typeof rootAlias !== "string" || !rootAlias.trim()) throw workflowError("WORKFLOW_ROOT_REQUIRED", "rootAlias is required and must reference a permanent root");
    if (typeof basePath !== "string" || !basePath.trim()) throw workflowError("WORKFLOW_BASE_PATH_INVALID", "basePath must be a non-empty relative path");
    if (!Array.isArray(steps) || !steps.length || steps.length > 50) throw workflowError("WORKFLOW_STEPS_INVALID", "workflow requires 1-50 steps");
    const ids = new Set();
    const normalized = steps.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw workflowError("WORKFLOW_STEP_INVALID", `step ${index + 1} must be an object`);
      const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `step_${index + 1}`;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw workflowError("WORKFLOW_STEP_ID_INVALID", `invalid step id: ${id}`);
      if (ids.has(id)) throw workflowError("WORKFLOW_STEP_ID_DUPLICATE", `duplicate step id: ${id}`);
      ids.add(id);
      const type = typeof raw.type === "string" ? raw.type.trim() : "";
      if (!STEP_TYPE_SET.has(type)) throw workflowError("WORKFLOW_STEP_TYPE_INVALID", `unsupported workflow step type: ${type}`);
      const args = raw.args && typeof raw.args === "object" && !Array.isArray(raw.args) ? structuredClone(raw.args) : {};
      return { id, type, args, status: "pending", result: null, error: null, startedAt: null, completedAt: null };
    });
    return { rootAlias: rootAlias.trim(), basePath: basePath.trim(), steps: normalized };
  }

  async prepare({ title = "workflow", rootAlias, basePath = ".", steps } = {}) {
    const validated = this.validateDefinition({ rootAlias, basePath, steps });
    const resolved = await this.roots.resolve({ alias: validated.rootAlias, path: validated.basePath });
    const now = new Date().toISOString();
    const state = {
      version: 1,
      workflowRef: `workflow_${randomUUID()}`,
      title: String(title ?? "workflow").slice(0, 500),
      rootAlias: validated.rootAlias,
      basePath: validated.basePath,
      preparedCwd: resolved.cwd,
      status: "prepared",
      currentIndex: 0,
      steps: validated.steps,
      createdAt: now,
      updatedAt: now,
      canceledAt: null,
      completedAt: null,
    };
    await this.#write(state);
    return publicWorkflow(state);
  }

  async run({ workflowRef, maxSteps = 10 } = {}) {
    const state = await this.#read(workflowRef);
    if (["completed", "canceled", "failed"].includes(state.status)) return publicWorkflow(state);
    const limit = Number.isInteger(maxSteps) ? Math.max(1, Math.min(50, maxSteps)) : 10;
    let executed = 0;
    while (state.currentIndex < state.steps.length && executed < limit) {
      const step = state.steps[state.currentIndex];
      if (step.status === "completed") { state.currentIndex += 1; continue; }
      if (step.status === "waiting") {
        const resumed = await this.#resumeWaitingStep(state, step);
        await this.#write(state);
        if (!resumed) return publicWorkflow(state);
        state.currentIndex += 1;
        executed += 1;
        continue;
      }
      const resolvedRoot = await this.roots.resolve({ alias: state.rootAlias, path: state.basePath });
      const args = resolveTemplates(structuredClone(step.args ?? {}), state.steps);
      if (args.cwd === undefined) args.cwd = resolvedRoot.cwd;
      step.startedAt = new Date().toISOString();
      step.status = "running";
      state.status = "running";
      state.updatedAt = new Date().toISOString();
      await this.#write(state);
      try {
        const result = await this.#dispatch(step.type, args);
        if (step.type === "pro_reason" && result?.status === "in_progress") {
          step.status = "waiting";
          step.result = sanitizeResult(result);
          state.status = "waiting";
          state.updatedAt = new Date().toISOString();
          await this.#write(state);
          return publicWorkflow(state);
        }
        step.status = "completed";
        step.result = sanitizeResult(result);
        step.completedAt = new Date().toISOString();
        step.error = null;
        state.currentIndex += 1;
        executed += 1;
        state.updatedAt = new Date().toISOString();
        await this.#write(state);
      } catch (error) {
        step.status = "failed";
        step.error = { code: typeof error?.code === "string" ? error.code : null, message: error instanceof Error ? error.message : String(error) };
        state.status = "failed";
        state.updatedAt = new Date().toISOString();
        await this.#write(state);
        return publicWorkflow(state);
      }
    }
    if (state.currentIndex >= state.steps.length) {
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      state.updatedAt = state.completedAt;
      await this.#write(state);
    } else if (state.status !== "waiting") {
      state.status = "running";
      state.updatedAt = new Date().toISOString();
      await this.#write(state);
    }
    return publicWorkflow(state);
  }

  async status({ workflowRef } = {}) {
    return publicWorkflow(await this.#read(workflowRef));
  }

  async cancel({ workflowRef } = {}) {
    const state = await this.#read(workflowRef);
    if (["completed", "failed", "canceled"].includes(state.status)) return publicWorkflow(state);
    state.status = "canceled";
    state.canceledAt = new Date().toISOString();
    state.updatedAt = state.canceledAt;
    await this.#write(state);
    return publicWorkflow(state);
  }

  async #resumeWaitingStep(state, step) {
    if (step.type !== "pro_reason" || !step.result?.bridgeRef) throw workflowError("WORKFLOW_WAIT_STATE_INVALID", `step '${step.id}' is waiting without a resumable Pro Bridge task`);
    const status = await this.components.proBridge.status({ bridgeRef: step.result.bridgeRef, cwd: state.preparedCwd });
    step.result = sanitizeResult(status);
    if (status.status !== "completed") {
      state.status = "waiting";
      state.updatedAt = new Date().toISOString();
      return false;
    }
    step.status = "completed";
    step.completedAt = new Date().toISOString();
    step.error = null;
    state.status = "running";
    state.updatedAt = new Date().toISOString();
    return true;
  }

  async #dispatch(type, args) {
    const c = this.components;
    switch (type) {
      case "fs_create": return c.fsGit.fsCreate(args);
      case "fs_write": return c.fsGit.fsWrite(args);
      case "fs_mkdir": return c.fsGit.fsMkdir(args);
      case "fs_move": return c.fsGit.fsMove(args);
      case "fs_copy": return c.fsGit.fsCopy(args);
      case "fs_delete": return c.fsGit.fsDelete(args);
      case "fs_metadata": return c.fsGit.fsMetadata(args);
      case "fs_copy_tree": return c.fsGit.fsCopyTree(args);
      case "fs_archive_create": return c.fsGit.fsArchiveCreate(args);
      case "fs_archive_extract": return c.fsGit.fsArchiveExtract(args);
      case "fs_delete_tree_plan": return c.fsGit.fsDeleteTreePlan(args);
      case "fs_delete_tree_commit": return c.fsGit.fsDeleteTreeCommit(args);
      case "process_start": return c.processes.start(args);
      case "pty_start": return c.pty.start(args);
      case "git_stage": return c.fsGit.gitStage(args);
      case "git_commit_staged": return c.fsGit.gitCommitStaged(args);
      case "git_fetch": return c.fsGit.gitFetch(args);
      case "git_pull": return c.fsGit.gitPull(args);
      case "git_push": return c.fsGit.gitPush(args);
      case "browser_open": return requireComponent(c.browser, type).openTab(args);
      case "browser_navigate": return requireComponent(c.browser, type).navigateTab(args);
      case "browser_back": return requireComponent(c.browser, type).backTab(args);
      case "browser_forward": return requireComponent(c.browser, type).forwardTab(args);
      case "browser_dialog": return requireComponent(c.browser, type).dialogTab(args);
      case "browser_click": return requireComponent(c.browser, type).clickTab(args);
      case "browser_fill": return requireComponent(c.browser, type).fillTab(args);
      case "browser_upload": return requireComponent(c.browser, type).uploadTab(args);
      case "browser_download": return requireComponent(c.browser, type).downloadTab(args);
      case "mcp_call": return requireComponent(c.mcpHub, type).call(args);
      case "pro_reason": return requireComponent(c.proBridge, type).start(args);
      default: throw workflowError("WORKFLOW_STEP_TYPE_INVALID", `unsupported workflow step type: ${type}`);
    }
  }

  async #read(workflowRef) {
    const ref = requireWorkflowRef(workflowRef);
    try { return JSON.parse(await readFile(path.join(this.stateDir, `${ref}.json`), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") throw workflowError("WORKFLOW_NOT_FOUND", `unknown workflow: ${ref}`); throw error; }
  }

  async #write(state) {
    await mkdir(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, `${state.workflowRef}.json`);
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  }
}

function requireComponent(component, type) {
  if (!component) throw workflowError("WORKFLOW_COMPONENT_UNAVAILABLE", `workflow component unavailable for step type '${type}'`);
  return component;
}

function resolveTemplates(value, steps) {
  if (typeof value === "string") {
    return value.replace(/\$\{steps\.([A-Za-z0-9._-]+)\.([^}]+)\}/g, (_match, stepId, fieldPath) => {
      const step = steps.find((row) => row.id === stepId);
      if (!step || step.status !== "completed") throw workflowError("WORKFLOW_TEMPLATE_UNRESOLVED", `step reference is not completed: ${stepId}`);
      const resolved = fieldPath.split(".").reduce((current, key) => current?.[key], step.result);
      if (resolved === undefined || resolved === null) throw workflowError("WORKFLOW_TEMPLATE_UNRESOLVED", `step result field is missing: ${stepId}.${fieldPath}`);
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, steps));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, steps)]));
  return value;
}

function sanitizeResult(value) {
  if (value === undefined) return null;
  return structuredClone(value);
}

function publicWorkflow(state) {
  return {
    workflowRef: state.workflowRef,
    title: state.title,
    rootAlias: state.rootAlias,
    basePath: state.basePath,
    status: state.status,
    currentIndex: state.currentIndex,
    stepCount: state.steps.length,
    steps: state.steps.map((step) => ({ id: step.id, type: step.type, status: step.status, result: step.result, error: step.error, startedAt: step.startedAt, completedAt: step.completedAt })),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    canceledAt: state.canceledAt,
  };
}

function requireWorkflowRef(value) {
  if (typeof value !== "string" || !/^workflow_[0-9a-f-]{36}$/i.test(value)) throw workflowError("WORKFLOW_REF_INVALID", `invalid workflowRef: ${String(value)}`);
  return value;
}

function workflowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
