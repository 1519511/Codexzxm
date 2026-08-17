import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;

export class WorkbenchRootRegistry {
  constructor({ authorityExecutor, stateDir, defaultCwd }) {
    if (!authorityExecutor) throw new Error("WorkbenchRootRegistry requires authorityExecutor");
    if (!stateDir) throw new Error("WorkbenchRootRegistry requires stateDir");
    if (!defaultCwd) throw new Error("WorkbenchRootRegistry requires defaultCwd");
    this.authorityExecutor = authorityExecutor;
    this.stateDir = path.resolve(stateDir);
    this.stateFile = path.join(this.stateDir, "roots.json");
    this.defaultCwd = path.resolve(defaultCwd);
    this.loaded = false;
    this.roots = new Map();
  }

  async register({ alias, cwd = this.defaultCwd, description = null } = {}) {
    const name = requireAlias(alias);
    await this.#ensureLoaded();
    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
    if (authority?.permissionCeiling !== ":danger-full-access" || authority?.permissionProfile !== ":danger-full-access") {
      throw rootError("ROOT_FULL_AUTHORITY_REQUIRED", `permanent root registration requires Codex :danger-full-access authority; resolved profile=${String(authority?.permissionProfile)} ceiling=${String(authority?.permissionCeiling)}`);
    }
    if (!authority.trustedAncestor) throw rootError("ROOT_TRUST_REQUIRED", "permanent root registration requires an explicit Codex trusted ancestor");
    const rootPath = await realpath(authority.effectiveCwd);
    const trustedAncestor = await realpath(authority.trustedAncestor);
    assertWithin(trustedAncestor, rootPath);
    const now = new Date().toISOString();
    const previous = this.roots.get(name);
    const record = {
      rootRef: previous?.rootRef ?? `root_${randomUUID()}`,
      alias: name,
      rootPath,
      trustedAncestor,
      permissionProfile: authority.permissionProfile,
      permissionCeiling: authority.permissionCeiling,
      authoritySource: authority.authoritySource ?? null,
      description: description === null ? previous?.description ?? null : String(description).slice(0, 2000),
      registeredAt: previous?.registeredAt ?? now,
      updatedAt: now,
      permanent: true,
    };
    this.roots.set(name, record);
    await this.#persist();
    return { ...record, replaced: Boolean(previous) };
  }

  async list({ query = "", refreshAuthority = false } = {}) {
    await this.#ensureLoaded();
    const needle = String(query ?? "").trim().toLowerCase();
    const rows = [];
    for (const record of this.roots.values()) {
      if (needle && !`${record.alias} ${record.rootPath} ${record.description ?? ""}`.toLowerCase().includes(needle)) continue;
      rows.push(refreshAuthority ? await this.#refresh(record) : { ...record, authorityStatus: "stored" });
    }
    rows.sort((a, b) => a.alias.localeCompare(b.alias));
    return { count: rows.length, permanent: true, roots: rows };
  }

  async status({ alias } = {}) {
    await this.#ensureLoaded();
    const record = this.#require(alias);
    return this.#refresh(record);
  }

  async resolve({ alias, path: relativePath = "." } = {}) {
    await this.#ensureLoaded();
    const record = this.#require(alias);
    const refreshed = await this.#refresh(record);
    if (refreshed.authorityStatus !== "ready") {
      throw rootError("ROOT_AUTHORITY_DRIFT", `registered root '${record.alias}' no longer resolves to permanent :danger-full-access authority`);
    }
    const relative = typeof relativePath === "string" && relativePath.trim() ? relativePath.trim() : ".";
    const resolved = path.resolve(record.rootPath, relative);
    assertWithin(record.rootPath, resolved);
    return {
      rootRef: record.rootRef,
      alias: record.alias,
      rootPath: record.rootPath,
      cwd: resolved,
      relativePath: path.relative(record.rootPath, resolved) || ".",
      permissionProfile: refreshed.permissionProfile,
      permissionCeiling: refreshed.permissionCeiling,
      permanent: true,
    };
  }

  async remove({ alias } = {}) {
    await this.#ensureLoaded();
    const name = requireAlias(alias);
    const previous = this.roots.get(name);
    if (!previous) return { removed: false, alias: name };
    this.roots.delete(name);
    await this.#persist();
    return { removed: true, alias: name, rootRef: previous.rootRef, rootPath: previous.rootPath };
  }

  async #refresh(record) {
    try {
      const authority = await this.authorityExecutor.resolveAuthority({ cwd: record.rootPath, access: "inherit" });
      const effective = await realpath(authority.effectiveCwd);
      const trusted = authority.trustedAncestor ? await realpath(authority.trustedAncestor) : null;
      const ready = samePath(effective, record.rootPath) && trusted && isWithin(trusted, effective) && authority.permissionProfile === ":danger-full-access" && authority.permissionCeiling === ":danger-full-access";
      return {
        ...record,
        authorityStatus: ready ? "ready" : "drifted",
        currentTrustedAncestor: trusted,
        permissionProfile: authority.permissionProfile,
        permissionCeiling: authority.permissionCeiling,
        authoritySource: authority.authoritySource ?? record.authoritySource,
      };
    } catch (error) {
      return { ...record, authorityStatus: "unavailable", authorityError: error instanceof Error ? error.message : String(error) };
    }
  }

  #require(alias) {
    const name = requireAlias(alias);
    const record = this.roots.get(name);
    if (!record) throw rootError("ROOT_NOT_FOUND", `unknown permanent root alias: ${name}`);
    return record;
  }

  async #ensureLoaded() {
    if (this.loaded) return;
    await mkdir(this.stateDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.roots)) throw new Error("unsupported roots state schema");
      for (const record of parsed.roots) {
        if (!record || typeof record.alias !== "string" || typeof record.rootPath !== "string") continue;
        this.roots.set(record.alias, record);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw rootError("ROOT_STATE_CORRUPT", `could not load permanent root registry: ${error.message}`);
    }
    this.loaded = true;
  }

  async #persist() {
    await mkdir(this.stateDir, { recursive: true });
    const payload = { version: STATE_VERSION, roots: [...this.roots.values()] };
    const tmp = `${this.stateFile}.tmp-${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.stateFile);
  }
}

function requireAlias(value) {
  const alias = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) throw rootError("ROOT_ALIAS_INVALID", "root alias must be 1-64 characters using letters, numbers, dot, underscore, or hyphen");
  return alias;
}

function assertWithin(root, target) {
  if (!isWithin(root, target)) throw rootError("ROOT_PATH_ESCAPE", `path escapes registered root: ${target}`);
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function rootError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
