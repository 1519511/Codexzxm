import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const EXECUTION_MANIFEST_PROTOCOL = "codexzxm-pro-execution-manifest-v1";

export class WorkbenchExecutionManifest {
  constructor({ roots, workflow, stateDir = null }) {
    if (!roots) throw new Error("WorkbenchExecutionManifest requires root registry");
    if (!workflow) throw new Error("WorkbenchExecutionManifest requires workflow engine");
    this.roots = roots;
    this.workflow = workflow;
    this.stateDir = path.resolve(stateDir ?? path.join(os.homedir(), ".config", "codexzxm", "execution-manifests-v1"));
  }

  async prepare({ title = "execution", rootAlias, basePath = ".", steps, assumptions = [], verification = [], rollback = null, source = "manual" } = {}) {
    const normalized = this.workflow.validateDefinition({ rootAlias, basePath, steps });
    const now = new Date().toISOString();
    const state = {
      version: 1,
      protocol: EXECUTION_MANIFEST_PROTOCOL,
      manifestRef: `manifest_${randomUUID()}`,
      title: String(title ?? "execution").slice(0, 500),
      rootAlias: normalized.rootAlias,
      basePath: normalized.basePath,
      steps: normalized.steps.map(({ id, type, args }) => ({ id, type, args })),
      assumptions: normalizeStrings(assumptions, 100, 10000),
      verification: normalizeStrings(verification, 100, 10000),
      rollback: rollback && typeof rollback === "object" && !Array.isArray(rollback) ? structuredClone(rollback) : null,
      source: String(source ?? "manual").slice(0, 100),
      status: "draft",
      workflowRef: null,
      validation: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#write(state);
    return publicManifest(state);
  }

  async validate({ manifestRef } = {}) {
    const state = await this.#read(manifestRef);
    const root = await this.roots.status({ alias: state.rootAlias });
    const resolved = root.authorityStatus === "ready" ? await this.roots.resolve({ alias: state.rootAlias, path: state.basePath }) : null;
    let definitionOk = true;
    let definitionError = null;
    try { this.workflow.validateDefinition({ rootAlias: state.rootAlias, basePath: state.basePath, steps: state.steps }); }
    catch (error) { definitionOk = false; definitionError = error instanceof Error ? error.message : String(error); }
    const ready = root.authorityStatus === "ready" && Boolean(resolved) && definitionOk;
    state.validation = {
      ready,
      rootAuthorityStatus: root.authorityStatus,
      rootPath: root.rootPath ?? null,
      resolvedCwd: resolved?.cwd ?? null,
      definitionOk,
      definitionError,
      validatedAt: new Date().toISOString(),
    };
    state.status = ready ? (state.workflowRef ? "ready" : "validated") : "invalid";
    state.updatedAt = new Date().toISOString();
    await this.#write(state);
    return publicManifest(state);
  }

  async run({ manifestRef, maxSteps = 10 } = {}) {
    let state = await this.#read(manifestRef);
    if (!state.validation?.ready) {
      await this.validate({ manifestRef });
      state = await this.#read(manifestRef);
    }
    if (!state.validation?.ready) return publicManifest(state);
    if (!state.workflowRef) {
      const workflow = await this.workflow.prepare({ title: state.title, rootAlias: state.rootAlias, basePath: state.basePath, steps: state.steps });
      state.workflowRef = workflow.workflowRef;
      state.status = "ready";
      state.updatedAt = new Date().toISOString();
      await this.#write(state);
    }
    const workflowStatus = await this.workflow.run({ workflowRef: state.workflowRef, maxSteps });
    state.status = mapWorkflowStatus(workflowStatus.status);
    state.updatedAt = new Date().toISOString();
    if (workflowStatus.status === "completed") state.completedAt = workflowStatus.completedAt ?? state.updatedAt;
    state.lastWorkflowStatus = workflowStatus;
    await this.#write(state);
    return publicManifest(state);
  }

  async status({ manifestRef } = {}) {
    const state = await this.#read(manifestRef);
    if (state.workflowRef) {
      try {
        const workflowStatus = await this.workflow.status({ workflowRef: state.workflowRef });
        state.lastWorkflowStatus = workflowStatus;
        state.status = mapWorkflowStatus(workflowStatus.status);
      } catch {}
    }
    return publicManifest(state);
  }

  async #read(manifestRef) {
    const ref = requireManifestRef(manifestRef);
    try { return JSON.parse(await readFile(path.join(this.stateDir, `${ref}.json`), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") throw manifestError("MANIFEST_NOT_FOUND", `unknown execution manifest: ${ref}`); throw error; }
  }

  async #write(state) {
    await mkdir(this.stateDir, { recursive: true });
    const file = path.join(this.stateDir, `${state.manifestRef}.json`);
    const tmp = `${file}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  }
}

function publicManifest(state) {
  return {
    protocol: state.protocol,
    manifestRef: state.manifestRef,
    title: state.title,
    rootAlias: state.rootAlias,
    basePath: state.basePath,
    stepCount: state.steps.length,
    steps: structuredClone(state.steps),
    assumptions: structuredClone(state.assumptions),
    verification: structuredClone(state.verification),
    rollback: structuredClone(state.rollback),
    source: state.source,
    status: state.status,
    workflowRef: state.workflowRef,
    validation: structuredClone(state.validation),
    workflow: state.lastWorkflowStatus ? structuredClone(state.lastWorkflowStatus) : null,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt ?? null,
    temporaryPermissionLease: false,
    apiRouteUsed: false,
  };
}

function mapWorkflowStatus(status) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (status === "waiting") return "waiting";
  return "running";
}

function normalizeStrings(values, maxItems, maxChars) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, maxItems).map((value) => String(value).slice(0, maxChars));
}

function requireManifestRef(value) {
  if (typeof value !== "string" || !/^manifest_[0-9a-f-]{36}$/i.test(value)) throw manifestError("MANIFEST_REF_INVALID", `invalid manifestRef: ${String(value)}`);
  return value;
}

function manifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
