// Local development server: serves public/ and the API from core.mjs on plain Node, no packages needed.
// (In production the same core runs inside Next.js on AWS Amplify; see app/api/[[...path]]/route.js.)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { loadConfig, checkProduction } from "./config.mjs";
import { createBackends } from "./store.mjs";
import { createMailer } from "./mail.mjs";
import { createHandler } from "./core.mjs";
import { securityHeaders } from "./security.mjs";

const PUBLIC = path.join(import.meta.dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PAGES = { "/": "index.html", "/app": "app.html", "/reset": "reset.html", "/verify": "verify.html", "/privacy": "privacy.html", "/terms": "terms.html" };

export function createApp({ config, store, files, mailer, limiter }) {
  const handle = createHandler({ config, store, files, mailer, limiter });
  const secure = securityHeaders({ production: config.production });

  function serveStatic(res, pathname) {
    const file = PAGES[pathname] || (pathname.startsWith("/c/") ? "client.html" : decodeURIComponent(pathname.slice(1)));
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(full)] || "application/octet-stream",
      "cache-control": path.extname(full) === ".html" ? "no-cache" : "public, max-age=300",
      // Client and reset links are secret, so keep them out of search engines
      "x-robots-tag": ["client.html", "reset.html", "verify.html", "app.html"].includes(file) ? "noindex, nofollow" : "all",
    });
    fs.createReadStream(full).pipe(res);
  }

  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(secure)) res.setHeader(k, v);
    let url;
    try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }
    if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
    // Turn the Node request into a standard Request, run the shared core, and send the Response back
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const request = new Request(`http://${req.headers.host || "localhost"}${req.url}`, {
      method: req.method, headers: req.headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
    });
    let resp;
    try { resp = await handle(request, { ip: req.socket.remoteAddress }); }
    catch (e) { resp = new Response(JSON.stringify({ error: "Something went wrong." }), { status: 500, headers: { "content-type": "application/json" } }); }
    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    const cookies = resp.headers.getSetCookie?.() || [];
    if (cookies.length) headers["set-cookie"] = cookies;
    res.writeHead(resp.status, headers);
    res.end(Buffer.from(await resp.arrayBuffer()));
  });
}

if (process.argv[1] === import.meta.filename) {
  const config = loadConfig();
  checkProduction(config);
  const { store, files, limiter } = await createBackends(config);
  const server = createApp({ config, store, files, limiter, mailer: createMailer(config) });
  server.listen(config.port, () => console.log(`Clientword running at http://localhost:${config.port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
