const WINDOWS_ACCEPTED_CODEX_VERSIONS = Object.freeze(["0.147.0", "0.147.0-alpha.6.6"]);
const MAC_ACCEPTED_CODEX_VERSIONS = Object.freeze(["0.148.0-alpha.9"]);

export function acceptedCodexVersionsFor({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32") return WINDOWS_ACCEPTED_CODEX_VERSIONS;
  if (platform === "darwin" && arch === "arm64") return MAC_ACCEPTED_CODEX_VERSIONS;
  return Object.freeze([]);
}

export const ACCEPTED_CODEX_VERSIONS = acceptedCodexVersionsFor();

export function acceptedCodexVersionsFromEnv({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const base = [...acceptedCodexVersionsFor({ platform, arch })];
  const raw = env?.CODEXZXM_EXTRA_CODEX_VERSIONS ?? env?.CODEXLESS_EXTRA_CODEX_VERSIONS ?? "";
  const extra = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
  return Object.freeze([...new Set([...base, ...extra])]);
}

export function isCodexVersionAccepted(version, { acceptedVersions = ACCEPTED_CODEX_VERSIONS, platform = process.platform, arch = process.arch } = {}) {
  if (typeof version !== "string" || !version) return false;
  const accepted = new Set(Array.isArray(acceptedVersions) ? acceptedVersions : []);
  if (accepted.has(version)) return true;

  // Windows patch releases within an already accepted stable minor line are treated as
  // protocol-compatible. Pre-releases and cross-minor upgrades remain exact-match only.
  if (platform === "win32") {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return false;
    const [, major, minor] = match;
    for (const candidate of accepted) {
      const acceptedMatch = String(candidate).match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (acceptedMatch && acceptedMatch[1] === major && acceptedMatch[2] === minor) return true;
    }
  }

  // macOS null-profile compatibility is intentionally exact because its projection
  // contract is version-specific in the authority resolver.
  if (platform === "darwin" && arch === "arm64") return false;
  return false;
}
