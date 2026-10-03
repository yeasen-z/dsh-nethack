import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./runtime-paths.mjs";

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".json": "application/json" };

/** Serve public diagnostics and compiled modules only, never checkout secrets. */
export async function startRuntimeServer(port = 4173) {
  const server = http.createServer(async (request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
    catch { response.writeHead(400); response.end(); return; }
    if (pathname === "/") {
      response.writeHead(302, { location: "/apps/web/public/runtime-adapter-smoke.html" });
      response.end(); return;
    }
    if ((pathname === "/api/healthz" && request.method === "GET") || (pathname === "/api/decide" && request.method === "POST")) {
      let body = "";
      if (request.method === "POST") {
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 1_000_000) {
            response.writeHead(413, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: "request too large" })); return;
          }
        }
      }
      try {
        const gatewayPort = Number(process.env.GATEWAY_PORT ?? 8787);
        const upstream = await fetch(`http://127.0.0.1:${gatewayPort}${pathname === "/api/healthz" ? "/healthz" : "/decide"}`, {
          method: request.method,
          ...(request.method === "POST" ? { headers: { "content-type": "application/json" }, body } : {}),
        });
        response.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(await upstream.text());
      } catch {
        response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: false, error: "model gateway is not running (start it with npm run gateway)" }));
      }
      return;
    }
    const allowed = pathname.startsWith("/apps/web/public/") || /^\/packages\/(core|adapter-wasm|agent)\/dist\//.test(pathname);
    if (!allowed || pathname.split("/").some(segment => segment === ".." || segment.startsWith(".")) || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const body = await readFile(path.join(repoRoot, pathname));
      response.writeHead(200, { "content-type": types[path.extname(pathname)] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startRuntimeServer(Number(process.env.PORT ?? 4173));
  console.log(`Runtime diagnostic server listening on loopback port ${server.address().port}`);
}
