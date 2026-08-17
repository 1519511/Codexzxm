import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1;

export class WorkbenchSecretBroker {
  constructor({ stateDir = null } = {}) {
    this.stateDir = path.resolve(stateDir ?? path.join(os.homedir(), ".config", "codexzxm", "secrets-v1"));
    this.indexFile = path.join(this.stateDir, "index.json");
    this.windowsReadHelper = fileURLToPath(new URL("../scripts/codexzxm-secret-read.ps1", import.meta.url));
  }

  async list({ query = "" } = {}) {
    const index = await this.#readIndex();
    const needle = String(query ?? "").trim().toLowerCase();
    const rows = index.secrets
      .filter((entry) => !needle || `${entry.alias} ${entry.description ?? ""} ${entry.provider}`.toLowerCase().includes(needle))
      .map(publicMetadata)
      .sort((a, b) => a.alias.localeCompare(b.alias));
    return { count: rows.length, secrets: rows, plaintextExposed: false };
  }

  async metadata({ alias } = {}) {
    const entry = await this.#require(alias);
    return { ...publicMetadata(entry), plaintextExposed: false };
  }

  async resolveEnvMap(mapping = {}) {
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw secretError("SECRET_MAPPING_INVALID", "secret environment mapping must be an object of ENV_NAME -> secretRef");
    const env = {};
    const injected = [];
    for (const [rawName, rawRef] of Object.entries(mapping)) {
      const envName = requireEnvName(rawName);
      const alias = requireAlias(rawRef);
      env[envName] = await this.#resolvePlaintext(alias);
      injected.push({ env: envName, secretRef: alias });
    }
    return { env, injected };
  }

  async #resolvePlaintext(alias) {
    const entry = await this.#require(alias);
    if (entry.provider === "windows-dpapi-file") {
      if (process.platform !== "win32") throw secretError("SECRET_PROVIDER_PLATFORM_MISMATCH", `secret '${alias}' uses Windows DPAPI but host is ${process.platform}`);
      await access(this.windowsReadHelper);
      const file = path.resolve(entry.locator?.file ?? "");
      await access(file);
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", this.windowsReadHelper,
        "-SecretFile", file,
      ], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
      const value = String(stdout ?? "").replace(/[\r\n]+$/g, "");
      if (!value) throw secretError("SECRET_DECODE_EMPTY", `DPAPI secret '${alias}' decoded to an empty value`);
      return value;
    }
    if (entry.provider === "macos-keychain") {
      if (process.platform !== "darwin") throw secretError("SECRET_PROVIDER_PLATFORM_MISMATCH", `secret '${alias}' uses macOS Keychain but host is ${process.platform}`);
      const service = String(entry.locator?.service ?? "");
      const account = String(entry.locator?.account ?? process.env.USER ?? "");
      if (!service || !account) throw secretError("SECRET_LOCATOR_INVALID", `Keychain secret '${alias}' has incomplete locator metadata`);
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
      const value = String(stdout ?? "").replace(/[\r\n]+$/g, "");
      if (!value) throw secretError("SECRET_DECODE_EMPTY", `Keychain secret '${alias}' decoded to an empty value`);
      return value;
    }
    throw secretError("SECRET_PROVIDER_UNSUPPORTED", `unsupported secret provider for '${alias}': ${entry.provider}`);
  }

  async #require(alias) {
    const name = requireAlias(alias);
    const index = await this.#readIndex();
    const entry = index.secrets.find((row) => row?.alias === name);
    if (!entry) throw secretError("SECRET_NOT_FOUND", `unknown secretRef: ${name}`);
    return entry;
  }

  async #readIndex() {
    await mkdir(this.stateDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, "utf8"));
      if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.secrets)) throw new Error("unsupported secrets index schema");
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: STATE_VERSION, secrets: [] };
      throw secretError("SECRET_INDEX_CORRUPT", `could not load secret metadata index: ${error.message}`);
    }
  }
}

function publicMetadata(entry) {
  return {
    secretRef: entry.alias,
    alias: entry.alias,
    provider: entry.provider,
    description: entry.description ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
    permanent: true,
  };
}

function requireAlias(value) {
  const alias = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias)) throw secretError("SECRET_REF_INVALID", "secretRef must be 1-64 characters using letters, numbers, dot, underscore, or hyphen");
  return alias;
}

function requireEnvName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw secretError("SECRET_ENV_NAME_INVALID", `invalid environment variable name: ${name}`);
  return name;
}

function secretError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
