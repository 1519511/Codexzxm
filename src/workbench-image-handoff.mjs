import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export class WorkbenchImageHandoff {
  constructor({ authorityExecutor }) {
    if (!authorityExecutor) throw new Error("WorkbenchImageHandoff requires authorityExecutor");
    this.authorityExecutor = authorityExecutor;
  }

  async prepare({
    cwd,
    goal,
    sourceTextPaths = [],
    sourceImagePaths = [],
    exactText = [],
    styleNotes = [],
    mustKeep = [],
    mustAvoid = [],
    canvas = null,
    outputBasename = null,
    maxCharsPerText = 20000,
    maxTotalTextChars = 100000,
    maxImageBytes = 5000000,
    maxTotalImageBytes = 20000000,
  }) {
    const authority = await this.authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
    const root = await canonicalRoot(authority);
    const textSources = [];
    const imageSources = [];
    const contentItems = [];
    let totalTextChars = 0;
    let totalImageBytes = 0;

    for (const requestedPath of sourceTextPaths) {
      const target = await resolveFileWithin({ requestedPath, authority, root });
      const info = await stat(target);
      const buffer = await readFile(target);
      const binary = buffer.includes(0);
      if (binary) {
        textSources.push({
          requestedPath,
          path: target,
          bytes: info.size,
          sha256: sha256(buffer),
          skipped: true,
          reason: "binary_or_non_utf8_source; derive text with another Codexzxm tool first",
        });
        continue;
      }
      const fullText = buffer.toString("utf8");
      const remaining = Math.max(0, maxTotalTextChars - totalTextChars);
      const returned = fullText.slice(0, Math.min(maxCharsPerText, remaining));
      totalTextChars += returned.length;
      textSources.push({
        requestedPath,
        path: target,
        bytes: info.size,
        chars: fullText.length,
        returnedChars: returned.length,
        truncated: returned.length < fullText.length,
        sha256: sha256(buffer),
        text: returned,
      });
      if (totalTextChars >= maxTotalTextChars) break;
    }

    for (const requestedPath of sourceImagePaths) {
      const target = await resolveFileWithin({ requestedPath, authority, root });
      const ext = path.extname(target).toLowerCase();
      const mimeType = IMAGE_MIME.get(ext);
      if (!mimeType) throw new Error(`unsupported image type for ChatGPT handoff: ${ext || "<none>"}; use PNG, JPG/JPEG, or WebP`);
      const info = await stat(target);
      if (info.size > maxImageBytes) throw new Error(`image exceeds maxImageBytes (${maxImageBytes}): ${target}`);
      if (totalImageBytes + info.size > maxTotalImageBytes) throw new Error(`image handoff exceeds maxTotalImageBytes (${maxTotalImageBytes})`);
      const buffer = await readFile(target);
      totalImageBytes += buffer.length;
      const id = `image_${imageSources.length + 1}`;
      imageSources.push({ id, requestedPath, path: target, bytes: buffer.length, sha256: sha256(buffer), mimeType });
      contentItems.push({ type: "image", data: buffer.toString("base64"), mimeType });
    }

    const handoff = {
      protocol: "codexzxm-chatgpt-image-handoff-v1",
      generator: "chatgpt_builtin_image_generation",
      goal,
      canvas,
      outputBasename,
      exactText,
      styleNotes,
      mustKeep,
      mustAvoid,
      sourceText: textSources,
      sourceImages: imageSources,
      routing: {
        prepareWith: "workbench.image_handoff_prepare",
        generateWith: "ChatGPT built-in image generation in the current conversation",
        apiBillingRequired: false,
        codexModelTurnRequired: false,
        note: "Codexzxm prepares local evidence and reference images only. It does not invoke the ChatGPT image generator or an OpenAI image API on its own.",
      },
    };

    return {
      ...handoff,
      contentItems,
      cwd: authority.effectiveCwd,
      trustedAncestor: root,
      permissionProfile: authority.permissionProfile,
    };
  }
}

async function canonicalRoot(authority) {
  const candidate = authority?.trustedAncestor ?? authority?.effectiveCwd;
  if (!candidate) throw new Error("image handoff requires a trusted Codex authority root");
  return realpath(candidate);
}

async function resolveFileWithin({ requestedPath, authority, root }) {
  const lexical = path.resolve(authority.effectiveCwd, requestedPath);
  const linkInfo = await lstat(lexical);
  if (linkInfo.isSymbolicLink()) throw new Error(`image handoff refused symbolic link/junction target: ${lexical}`);
  const target = await realpath(lexical);
  assertWithin(root, target);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`image handoff source is not a regular file: ${target}`);
  return target;
}

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`image handoff refused path outside trusted root: ${target}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
