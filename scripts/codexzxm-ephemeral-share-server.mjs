import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [manifestPath, statePath] = process.argv.slice(2);
if (!manifestPath || !statePath) {
  throw new Error("usage: node codexzxm-ephemeral-share-server.mjs <manifest.json> <state.json>");
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const routes = new Map();
for (const item of manifest.files ?? []) {
  const absolutePath = path.resolve(item.path);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error(`not a regular file: ${absolutePath}`);
  const token = crypto.randomBytes(24).toString("hex");
  const safeName = path.basename(absolutePath).replace(/[^\p{L}\p{N}._-]/gu, "_");
  const route = `/asset/${token}/${encodeURIComponent(safeName)}`;
  routes.set(route, {
    absolutePath,
    stat,
    contentType: item.contentType || "application/octet-stream",
    safeName,
  });
}

function writeState(port) {
  const data = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    assets: [...routes.entries()].map(([route, value]) => ({
      route,
      path: value.absolutePath,
      size: value.stat.size,
      contentType: value.contentType,
    })),
  };
  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(temp, statePath);
}

const server = http.createServer((request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const asset = routes.get(url.pathname);
    if (!asset || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end("not found");
      return;
    }

    const total = asset.stat.size;
    let start = 0;
    let end = total - 1;
    let statusCode = 200;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${total}` });
        response.end();
        return;
      }
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        start = Math.max(0, total - suffixLength);
        end = total - 1;
      }
      if (start > end || start >= total) {
        response.writeHead(416, { "Content-Range": `bytes */${total}` });
        response.end();
        return;
      }
      end = Math.min(end, total - 1);
      statusCode = 206;
    }

    const headers = {
      "Content-Type": asset.contentType,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.safeName)}`,
    };
    if (statusCode === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;

    response.writeHead(statusCode, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(asset.absolutePath, { start, end }).pipe(response);
  } catch {
    response.writeHead(500, { "Cache-Control": "no-store" });
    response.end("error");
  }
});

server.listen(0, "127.0.0.1", () => writeState(server.address().port));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
