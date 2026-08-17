import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveCodexExecutable } from "./codex-bin.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage"]);

export class WorkbenchFsGit {
  constructor({ authorityExecutor }) {
    if (!authorityExecutor) throw new Error("WorkbenchFsGit requires authorityExecutor");
    this.authorityExecutor = authorityExecutor;
  }

  async fsList({ path: requestedPath = ".", cwd }) {
    const { authority, root, target } = await this.#existing({ requestedPath, cwd, access: "readOnly", kind: "directory" });
    const rows = [];
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const lexical = path.join(target, entry.name);
      const info = await lstat(lexical);
      rows.push({
        name: entry.name,
        path: lexical,
        type: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size: info.size,
        mtime: info.mtime.toISOString(),
      });
    }
    rows.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return this.#meta(authority, root, { path: target, entries: rows });
  }

  async fsTree({ path: requestedPath = ".", cwd, maxDepth = 3, maxEntries = 1000 }) {
    const { authority, root, target } = await this.#existing({ requestedPath, cwd, access: "readOnly", kind: "directory" });
    const entries = [];
    let truncated = false;
    const walk = async (dir, depth) => {
      if (depth > maxDepth || entries.length >= maxEntries) return;
      const children = await readdir(dir, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of children) {
        if (entries.length >= maxEntries) { truncated = true; break; }
        const lexical = path.join(dir, entry.name);
        const info = await lstat(lexical);
        const type = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
        entries.push({ path: lexical, relativePath: path.relative(target, lexical), depth, type, size: info.size });
        if (type === "directory" && depth < maxDepth) {
          const canonical = await realpath(lexical);
          assertWithin(root, canonical);
          await walk(canonical, depth + 1);
        }
      }
    };
    await walk(target, 1);
    return this.#meta(authority, root, { path: target, maxDepth, maxEntries, truncated, entries });
  }

  async fsRead({ path: requestedPath, cwd, startLine = 1, endLine = null, maxChars = 200000 }) {
    const { authority, root, target } = await this.#existing({ requestedPath, cwd, access: "readOnly", kind: "file" });
    const buffer = await readFile(target);
    const fullText = buffer.toString("utf8");
    const lines = fullText.split(/\r?\n/);
    const from = Math.max(1, startLine);
    const to = endLine === null ? lines.length : Math.min(lines.length, Math.max(from, endLine));
    const selected = lines.slice(from - 1, to).join("\n");
    const text = selected.slice(0, maxChars);
    return this.#meta(authority, root, {
      path: target,
      startLine: from,
      endLine: to,
      lineCount: lines.length,
      chars: selected.length,
      returnedChars: text.length,
      truncated: text.length < selected.length,
      sha256: sha256(buffer),
      text,
    });
  }

  async fsCreate({ path: requestedPath, content, cwd }) {
    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
    assertWritableAuthority(authority);
    const root = await canonicalRoot(authority);
    const target = await creatableTarget({ requestedPath, cwd: authority.effectiveCwd, root });
    await assertMissing(target);
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    const written = await readFile(target);
    return this.#meta(authority, root, { status: "created", path: target, bytes: written.length, sha256: sha256(written) });
  }

  async fsWrite({ path: requestedPath, content, expectedSha256, cwd }) {
    const { authority, root, target } = await this.#existing({ requestedPath, cwd, access: "inherit", kind: "file" });
    assertWritableAuthority(authority);
    const before = await readFile(target);
    const beforeSha256 = sha256(before);
    if (beforeSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(`workbench write refused: expectedSha256 does not match current file ${target}`);
    }
    const next = Buffer.from(content, "utf8");
    await writeFile(target, next);
    const verified = await readFile(target);
    if (!verified.equals(next)) throw new Error("workbench write verification failed");
    return this.#meta(authority, root, {
      status: "written",
      path: target,
      beforeSha256,
      afterSha256: sha256(verified),
      beforeBytes: before.length,
      afterBytes: verified.length,
    });
  }

  async fsMkdir({ path: requestedPath, cwd }) {
    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
    assertWritableAuthority(authority);
    const root = await canonicalRoot(authority);
    const target = await creatableTarget({ requestedPath, cwd: authority.effectiveCwd, root });
    await assertMissing(target);
    await mkdir(target);
    return this.#meta(authority, root, { status: "created", path: target, type: "directory" });
  }

  async fsMove({ source, destination, expectedSha256 = null, cwd }) {
    const { authority, root, target: sourcePath } = await this.#existing({ requestedPath: source, cwd, access: "inherit", kind: "any" });
    assertWritableAuthority(authority);
    const destinationPath = await creatableTarget({ requestedPath: destination, cwd: authority.effectiveCwd, root });
    await assertMissing(destinationPath);
    const sourceInfo = await stat(sourcePath);
    if (sourceInfo.isFile() && expectedSha256) {
      const current = sha256(await readFile(sourcePath));
      if (current.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error("workbench move refused: expectedSha256 mismatch");
    }
    await rename(sourcePath, destinationPath);
    return this.#meta(authority, root, { status: "moved", source: sourcePath, destination: destinationPath });
  }

  async fsCopy({ source, destination, expectedSha256 = null, cwd }) {
    const { authority, root, target: sourcePath } = await this.#existing({ requestedPath: source, cwd, access: "inherit", kind: "file" });
    assertWritableAuthority(authority);
    const destinationPath = await creatableTarget({ requestedPath: destination, cwd: authority.effectiveCwd, root });
    await assertMissing(destinationPath);
    const sourceBytes = await readFile(sourcePath);
    const sourceSha256 = sha256(sourceBytes);
    if (expectedSha256 && sourceSha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error("workbench copy refused: expectedSha256 mismatch");
    await copyFile(sourcePath, destinationPath);
    const copied = await readFile(destinationPath);
    if (sha256(copied) !== sourceSha256) throw new Error("workbench copy verification failed");
    return this.#meta(authority, root, { status: "copied", source: sourcePath, destination: destinationPath, bytes: copied.length, sha256: sourceSha256 });
  }

  async fsDelete({ path: requestedPath, expectedSha256 = null, cwd }) {
    const { authority, root, target } = await this.#existing({ requestedPath, cwd, access: "inherit", kind: "any" });
    assertWritableAuthority(authority);
    if (samePath(root, target)) throw new Error("workbench delete refused: cannot delete authority root");
    const info = await stat(target);
    if (info.isFile()) {
      if (!expectedSha256) throw new Error("workbench delete requires expectedSha256 for files");
      const current = sha256(await readFile(target));
      if (current.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error("workbench delete refused: expectedSha256 mismatch");
      await unlink(target);
      return this.#meta(authority, root, { status: "deleted", path: target, type: "file", sha256: current });
    }
    if (info.isDirectory()) {
      await rmdir(target);
      return this.#meta(authority, root, { status: "deleted", path: target, type: "directory" });
    }
    throw new Error("workbench delete supports regular files and empty directories only");
  }

  async projectSearch({ query, cwd, path: requestedPath = ".", regex = false, caseSensitive = false, maxMatches = 200, maxFiles = 3000, maxFileBytes = 2000000, excludeDirs = [] }) {
    const { authority, root, target } = await this.#existing({ requestedPath, cwd, access: "readOnly", kind: "directory" });
    if (regex) {
      return this.#projectSearchRegex({ authority, root, target, query, caseSensitive, maxMatches, maxFileBytes, excludeDirs });
    }
    const excluded = new Set([...DEFAULT_EXCLUDED_DIRS, ...excludeDirs]);
    const matcher = buildLiteralMatcher(query, caseSensitive);
    const matches = [];
    let scannedFiles = 0;
    let truncated = false;

    const walk = async (dir) => {
      if (matches.length >= maxMatches || scannedFiles >= maxFiles) { truncated = true; return; }
      const children = await readdir(dir, { withFileTypes: true });
      for (const entry of children) {
        if (matches.length >= maxMatches || scannedFiles >= maxFiles) { truncated = true; return; }
        if (entry.isSymbolicLink()) continue;
        const lexical = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excluded.has(entry.name)) continue;
          const canonical = await realpath(lexical);
          assertWithin(root, canonical);
          await walk(canonical);
          continue;
        }
        if (!entry.isFile()) continue;
        scannedFiles += 1;
        if (matcher(entry.name)) {
          matches.push({ kind: "filename", path: lexical, relativePath: path.relative(target, lexical) });
          if (matches.length >= maxMatches) { truncated = true; return; }
        }
        const info = await stat(lexical);
        if (info.size > maxFileBytes) continue;
        const buffer = await readFile(lexical);
        if (buffer.includes(0)) continue;
        const text = buffer.toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (matcher(lines[i])) {
            matches.push({ kind: "content", path: lexical, relativePath: path.relative(target, lexical), line: i + 1, text: lines[i].slice(0, 1000) });
            if (matches.length >= maxMatches) { truncated = true; return; }
          }
        }
      }
    };

    await walk(target);
    return this.#meta(authority, root, { query, regex: false, engine: "literal", caseSensitive, path: target, scannedFiles, maxFiles, maxMatches, truncated, matches });
  }

  async #projectSearchRegex({ authority, root, target, query, caseSensitive, maxMatches, maxFileBytes, excludeDirs }) {
    const excluded = [...new Set([...DEFAULT_EXCLUDED_DIRS, ...excludeDirs])];
    const args = ["--json", "--line-number", "--color", "never", "--max-filesize", String(maxFileBytes)];
    args.push(caseSensitive ? "--case-sensitive" : "--ignore-case");
    for (const dir of excluded) args.push("--glob", `!${dir}/**`);
    args.push("--", query, ".");
    let stdout = "";
    let stderr = "";
    const rg = await resolveRipgrepExecutable();
    try {
      const result = await execFileAsync(rg, args, { cwd: target, encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: 8 * 1024 * 1024 });
      stdout = result.stdout ?? "";
      stderr = result.stderr ?? "";
    } catch (error) {
      const exitCode = Number.isInteger(error?.code) ? error.code : null;
      if (exitCode === 1) { stdout = error?.stdout ?? ""; stderr = error?.stderr ?? ""; }
      else if (/timed out/i.test(error?.message ?? "") || error?.killed === true) throw new Error("workbench regex search timed out after 8000ms");
      else throw new Error(`workbench regex search failed: ${error?.stderr ?? error?.message ?? String(error)}`);
    }
    const matches = [];
    for (const line of String(stdout).split(/\r?\n/).filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== "match") continue;
      const rel = event?.data?.path?.text;
      if (typeof rel !== "string") continue;
      const absolute = path.resolve(target, rel);
      assertWithin(root, absolute);
      const lineNumber = event?.data?.line_number ?? null;
      const lineText = event?.data?.lines?.text ?? "";
      matches.push({ kind: "content", path: absolute, relativePath: path.relative(target, absolute), line: lineNumber, text: String(lineText).replace(/\r?\n$/, "").slice(0, 1000) });
      if (matches.length >= maxMatches) break;
    }
    return this.#meta(authority, root, { query, regex: true, engine: "ripgrep", caseSensitive, path: target, maxMatches, truncated: matches.length >= maxMatches, stderr: String(stderr).slice(0, 2000), matches });
  }

  async gitStatus({ cwd }) {
    return this.#git(["status", "--short", "--branch"], cwd, "readOnly");
  }

  async gitDiff({ cwd, staged = false, path: requestedPath = null }) {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (requestedPath) args.push("--", requestedPath);
    return this.#git(args, cwd, "readOnly");
  }

  async gitLog({ cwd, count = 20 }) {
    return this.#git(["log", `-${count}`, "--date=iso-strict", "--pretty=format:%h%x09%ad%x09%an%x09%s"], cwd, "readOnly");
  }

  async gitStage({ cwd, paths }) {
    return this.#git(["add", "--", ...paths], cwd, "inherit");
  }

  async gitCommitStaged({ cwd, message }) {
    return this.#git(["commit", "-m", message], cwd, "inherit");
  }

  async gitBranches({ cwd, all = false }) {
    const args = ["branch"];
    if (all) args.push("--all");
    args.push("--format=%(HEAD)%09%(refname:short)%09%(upstream:short)");
    return this.#git(args, cwd, "readOnly");
  }

  async gitSwitch({ cwd, branch, create = false, startPoint = null }) {
    const target = requireGitRef(branch, "branch");
    const args = ["switch"];
    if (create) args.push("-c", target); else args.push(target);
    if (create && startPoint) args.push(requireGitRef(startPoint, "startPoint"));
    return this.#git(args, cwd, "inherit");
  }

  async gitStashPush({ cwd, message = null, includeUntracked = false }) {
    const args = ["stash", "push"];
    if (includeUntracked) args.push("--include-untracked");
    if (message) args.push("-m", String(message));
    return this.#git(args, cwd, "inherit");
  }

  async gitStashList({ cwd, count = 20 }) {
    return this.#git(["stash", "list", `--max-count=${Math.max(1, Math.min(100, count))}`], cwd, "readOnly");
  }

  async gitStashPop({ cwd, stashRef = "stash@{0}" }) {
    return this.#git(["stash", "pop", requireGitRef(stashRef, "stashRef")], cwd, "inherit");
  }

  async gitFetch({ cwd, remote = "origin", prune = true }) {
    const args = ["fetch", requireGitRef(remote, "remote")];
    if (prune) args.push("--prune");
    return this.#git(args, cwd, "inherit");
  }

  async gitPull({ cwd, remote = "origin", branch = null, rebase = false, ffOnly = true }) {
    const args = ["pull"];
    if (rebase) args.push("--rebase"); else if (ffOnly) args.push("--ff-only");
    args.push(requireGitRef(remote, "remote"));
    if (branch) args.push(requireGitRef(branch, "branch"));
    return this.#git(args, cwd, "inherit");
  }

  async gitPush({ cwd, remote = "origin", branch = null, setUpstream = false, forceWithLease = false }) {
    const args = ["push"];
    if (setUpstream) args.push("--set-upstream");
    if (forceWithLease) args.push("--force-with-lease");
    args.push(requireGitRef(remote, "remote"));
    if (branch) args.push(requireGitRef(branch, "branch"));
    return this.#git(args, cwd, "inherit");
  }

  async #git(args, cwd, access) {
    const result = await this.authorityExecutor.exec({ command: ["git", ...args], cwd, access, timeoutMs: 30000 });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      cwd: result.effectiveCwd,
      permissionProfile: result.permissionProfile,
      trustedAncestor: result.trustedAncestor,
    };
  }

  async #existing({ requestedPath, cwd, access, kind }) {
    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access });
    const root = await canonicalRoot(authority);
    const lexical = path.resolve(authority.effectiveCwd, requestedPath);
    const linkInfo = await lstat(lexical);
    if (linkInfo.isSymbolicLink()) throw new Error(`workbench refused symbolic link/junction target: ${lexical}`);
    const target = await realpath(lexical);
    assertWithin(root, target);
    const info = await stat(target);
    if (kind === "file" && !info.isFile()) throw new Error(`target is not a regular file: ${target}`);
    if (kind === "directory" && !info.isDirectory()) throw new Error(`target is not a directory: ${target}`);
    if (kind === "any" && !info.isFile() && !info.isDirectory()) throw new Error(`target is not a regular file or directory: ${target}`);
    return { authority, root, target, info };
  }

  #meta(authority, root, payload) {
    return { ...payload, cwd: authority.effectiveCwd, trustedAncestor: root, permissionProfile: authority.permissionProfile };
  }
}

async function canonicalRoot(authority) {
  const candidate = authority?.trustedAncestor ?? authority?.effectiveCwd;
  if (!candidate) throw new Error("workbench requires a trusted Codex authority root");
  return realpath(candidate);
}

async function creatableTarget({ requestedPath, cwd, root }) {
  const resolved = path.resolve(cwd, requestedPath);
  const parent = await realpath(path.dirname(resolved));
  assertWithin(root, parent);
  const target = path.join(parent, path.basename(resolved));
  assertWithin(root, target);
  return target;
}

async function assertMissing(target) {
  try {
    await lstat(target);
    throw new Error(`target already exists: ${target}`);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`workbench refused path outside trusted root: ${target}`);
  }
}

async function resolveRipgrepExecutable() {
  const explicit = process.env.CODEXZXM_RG?.trim() || process.env.CODEXLESS_RG?.trim();
  if (explicit && await executableExists(explicit)) return path.resolve(explicit);
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const name = process.platform === "win32" ? "rg.exe" : "rg";
  try {
    const result = await execFileAsync(locator, [name], { encoding: "utf8", windowsHide: true, timeout: 3_000, maxBuffer: 64 * 1024 });
    const candidate = String(result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (candidate && await executableExists(candidate)) return path.resolve(candidate);
  } catch {}

  try {
    const codex = await resolveCodexExecutable({ acceptedVersions: null });
    const nearby = await findRipgrepNearCodex(codex.path);
    if (nearby) return nearby;
  } catch {}

  throw new Error("workbench regex search requires ripgrep (rg); Codexzxm could not find it on PATH or beside the local Codex executable. Set CODEXZXM_RG explicitly if needed.");
}

async function findRipgrepNearCodex(codexPath) {
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const codexDir = path.dirname(codexPath);
  const roots = [...new Set([codexDir, path.dirname(codexDir), path.dirname(path.dirname(codexDir))])];
  for (const root of roots) {
    const direct = path.join(root, binary);
    if (await executableExists(direct)) return path.resolve(direct);
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 256)) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, binary);
      if (await executableExists(candidate)) return path.resolve(candidate);
      const codexPathCandidate = path.join(root, entry.name, "codex-path", binary);
      if (await executableExists(codexPathCandidate)) return path.resolve(codexPathCandidate);
    }
  }
  return null;
}

async function executableExists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

function requireGitRef(value, label) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("-") || /[\r\n\0]/.test(value)) throw new Error(`invalid git ${label}: ${String(value)}`);
  return value.trim();
}

function assertWritableAuthority(authority) {
  if (!authority?.permissionProfile || authority.permissionProfile === ":read-only") {
    throw new Error("workbench write refused: resolved Codex authority is read-only");
  }
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildLiteralMatcher(query, caseSensitive) {
  const needle = caseSensitive ? query : query.toLowerCase();
  return (text) => (caseSensitive ? text : text.toLowerCase()).includes(needle);
}
