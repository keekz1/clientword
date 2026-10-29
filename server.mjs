import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { store, UPLOADS } from "./store.mjs";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(import.meta.dirname, "public");
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 20; // per client
const SESSION_DAYS = 14;

const DEFAULT_QUESTIONS = [
  { id: "q1", label: "What are you hoping to achieve?", type: "long", required: true },
  { id: "q2", label: "Do you have a deadline?", type: "text", required: false },
  { id: "q3", label: "Budget range", type: "choice", options: ["Under £500", "£500 – £2,000", "£2,000 – £10,000", "£10,000+"], required: false },
];

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// ---------- helpers ----------
const id = () => crypto.randomBytes(8).toString("hex");
const token = () => crypto.randomBytes(24).toString("base64url");
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const fail = (res, code, message) => json(res, code, { error: message });

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("Too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  try { return buf.length ? JSON.parse(buf.toString("utf8")) : {}; }
  catch { throw Object.assign(new Error("Bad JSON"), { code: 400 }); }
}

const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
const validColour = (c) => /^#[0-9a-fA-F]{6}$/.test(c);
// Only allow http(s) links for the meeting URL, never javascript: or data:
const safeUrl = (u) => {
  if (!u) return "";
  try { const x = new URL(u); return ["http:", "https:"].includes(x.protocol) ? x.toString() : ""; }
  catch { return ""; }
};

function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex");
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((p) => p.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const sessionCookie = (value, maxAge) =>
  `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

function currentFreelancer(req) {
  const s = store.session(cookie(req, "sid"));
  return s ? store.freelancerById(s.freelancerId) : null;
}

// Simple in-memory limiter for login/signup (per IP)
const hits = new Map();
function limited(req, key, max, windowMs) {
  const k = key + ":" + (req.socket.remoteAddress || "?");
  const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(k, list);
  return list.length > max;
}

// Which onboarding steps apply to this freelancer, and which the client has done
function stepsFor(f, c) {
  const steps = [];
  if (f.questions.length) steps.push({ key: "intake", label: "Tell me about your project", done: !!c.intake });
  if (f.askForFiles) steps.push({ key: "files", label: "Share files", done: c.files.length > 0 || !!c.filesSkipped });
  if (f.meetingUrl) steps.push({ key: "meeting", label: "Book a call", done: !!c.meeting });
  return steps;
}
function statusOf(f, c) {
  if (c.status === "active" || c.status === "archived") return c.status;
  const steps = stepsFor(f, c);
  if (steps.length && steps.every((s) => s.done)) return "ready";
  return steps.some((s) => s.done) ? "in_progress" : "invited";
}

const brand = (f) => ({
  business: f.business, name: f.name, colour: f.colour, welcome: f.welcome,
  meetingUrl: f.meetingUrl, meetingNote: f.meetingNote, askForFiles: f.askForFiles, questions: f.questions,
});
const clientSummary = (f, c) => ({
  id: c.id, name: c.name, email: c.email, project: c.project, created: c.created,
  status: statusOf(f, c), steps: stepsFor(f, c), token: c.token,
  lastActivity: c.lastActivity, opened: !!c.opened,
});

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // --- freelancer auth ---
  if (p === "/api/auth/signup" && method === "POST") {
    if (limited(req, "signup", 10, 3600_000)) return fail(res, 429, "Too many attempts. Try again later.");
    const b = await readJson(req);
    const email = clip(b.email, 200).toLowerCase();
    const name = clip(b.name, 80);
    if (!name) return fail(res, 400, "Please enter your name.");
    if (!validEmail(email)) return fail(res, 400, "Please enter a valid email.");
    if (String(b.password || "").length < 8) return fail(res, 400, "Password must be at least 8 characters.");
    if (store.freelancerByEmail(email)) return fail(res, 409, "An account with that email already exists.");
    const f = store.addFreelancer({
      id: id(), email, name, business: clip(b.business, 80) || name,
      password: hashPassword(b.password), colour: "#4f46e5",
      welcome: "Welcome! A few quick steps so we can get started smoothly.",
      meetingUrl: "", meetingNote: "Pick a time that suits you for a short kick-off call.",
      askForFiles: true, questions: DEFAULT_QUESTIONS, created: Date.now(),
    });
    const sid = token();
    store.addSession({ token: sid, freelancerId: f.id, expires: Date.now() + SESSION_DAYS * 86400_000 });
    return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(sid, SESSION_DAYS * 86400) });
  }
  if (p === "/api/auth/login" && method === "POST") {
    if (limited(req, "login", 10, 900_000)) return fail(res, 429, "Too many attempts. Try again in a few minutes.");
    const b = await readJson(req);
    const f = store.freelancerByEmail(clip(b.email, 200).toLowerCase());
    // Same message for unknown email and wrong password
    if (!f || !checkPassword(String(b.password || ""), f.password)) return fail(res, 401, "Email or password is incorrect.");
    const sid = token();
    store.addSession({ token: sid, freelancerId: f.id, expires: Date.now() + SESSION_DAYS * 86400_000 });
    return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(sid, SESSION_DAYS * 86400) });
  }
  if (p === "/api/auth/logout" && method === "POST") {
    store.dropSession(cookie(req, "sid"));
    return json(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
  }

  // --- client portal (access by secret link token) ---
  let m = p.match(/^\/api\/portal\/([\w-]{20,})(\/[a-z]+)?$/);
  if (m) return portal(req, res, m[1], m[2] || "", url);

  // --- everything below needs a logged-in freelancer ---
  const f = currentFreelancer(req);
  if (!f) return fail(res, 401, "Please log in.");

  if (p === "/api/me" && method === "GET") return json(res, 200, { email: f.email, ...brand(f) });

  if (p === "/api/settings" && method === "PUT") {
    const b = await readJson(req);
    // Validate first, then change anything, so a rejected request leaves no half-applied edits
    const meetingUrl = safeUrl(clip(b.meetingUrl, 500));
    if (b.meetingUrl && !meetingUrl) return fail(res, 400, "Meeting link must start with https://");
    f.name = clip(b.name, 80) || f.name;
    f.business = clip(b.business, 80) || f.business;
    if (validColour(b.colour)) f.colour = b.colour;
    f.welcome = clip(b.welcome, 600);
    f.meetingUrl = meetingUrl;
    f.meetingNote = clip(b.meetingNote, 300);
    f.askForFiles = !!b.askForFiles;
    if (Array.isArray(b.questions)) {
      f.questions = b.questions.slice(0, 15).map((q) => ({
        id: clip(q.id, 20) || id(),
        label: clip(q.label, 200),
        type: ["text", "long", "choice"].includes(q.type) ? q.type : "text",
        options: q.type === "choice" ? (q.options || []).slice(0, 10).map((o) => clip(o, 80)).filter(Boolean) : undefined,
        required: !!q.required,
      })).filter((q) => q.label);
    }
    store.updateFreelancer(f);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/clients" && method === "GET") {
    return json(res, 200, store.clientsOf(f.id).map((c) => clientSummary(f, c)).sort((a, b) => b.created - a.created));
  }
  if (p === "/api/clients" && method === "POST") {
    const b = await readJson(req);
    const name = clip(b.name, 80);
    if (!name) return fail(res, 400, "Client name is required.");
    const email = clip(b.email, 200).toLowerCase();
    if (email && !validEmail(email)) return fail(res, 400, "That email doesn't look right.");
    const c = store.addClient({
      id: id(), freelancerId: f.id, token: token(), name, email, project: clip(b.project, 120),
      created: Date.now(), lastActivity: Date.now(), intake: null, files: [], meeting: null, notes: "", status: "",
    });
    return json(res, 200, clientSummary(f, c));
  }

  m = p.match(/^\/api\/clients\/(\w+)(\/files\/(\w+))?$/);
  if (m) {
    const c = store.clientById(f.id, m[1]);
    if (!c) return fail(res, 404, "Client not found.");
    if (m[2] && method === "GET") return sendFile(res, c, m[3]);
    if (method === "GET") {
      return json(res, 200, { ...clientSummary(f, c), intake: c.intake, files: c.files, meeting: c.meeting, notes: c.notes, questions: f.questions });
    }
    if (method === "PATCH") {
      const b = await readJson(req);
      if (typeof b.notes === "string") c.notes = clip(b.notes, 4000);
      if (["active", "archived", ""].includes(b.status)) c.status = b.status;
      if (b.name !== undefined) c.name = clip(b.name, 80) || c.name;
      store.updateClient(c);
      return json(res, 200, clientSummary(f, c));
    }
    if (method === "DELETE") {
      for (const file of c.files) fs.rmSync(path.join(UPLOADS, file.stored), { force: true });
      store.deleteClient(f.id, c.id);
      return json(res, 200, { ok: true });
    }
  }
  return fail(res, 404, "Not found.");
}

async function portal(req, res, tok, sub, url) {
  const c = store.clientByToken(tok);
  if (!c) return fail(res, 404, "This link isn't valid. Please check with the person who sent it.");
  const f = store.freelancerById(c.freelancerId);
  const method = req.method;

  if (sub === "" && method === "GET") {
    if (!c.opened) { c.opened = Date.now(); store.updateClient(c); }
    return json(res, 200, {
      client: { name: c.name, project: c.project }, brand: brand(f),
      steps: stepsFor(f, c), status: statusOf(f, c), intake: c.intake,
      files: c.files.map(({ id, name, size }) => ({ id, name, size })), meeting: c.meeting,
    });
  }
  if (sub === "/intake" && method === "POST") {
    const b = await readJson(req);
    const answers = {};
    for (const q of f.questions) {
      const v = clip(b.answers?.[q.id], 3000);
      if (q.required && !v) return fail(res, 400, `Please answer: ${q.label}`);
      if (q.type === "choice" && v && !q.options.includes(v)) return fail(res, 400, `Please choose an option for: ${q.label}`);
      answers[q.id] = v;
    }
    c.intake = { answers, at: Date.now() };
    c.lastActivity = Date.now();
    store.updateClient(c);
    return json(res, 200, { ok: true });
  }
  if (sub === "/upload" && method === "POST") {
    if (!f.askForFiles) return fail(res, 400, "File uploads are turned off.");
    if (c.files.length >= MAX_FILES) return fail(res, 400, "File limit reached.");
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_UPLOAD) return fail(res, 413, "That file is over 10 MB.");
    let buf;
    try { buf = await readBody(req, MAX_UPLOAD); }
    catch (e) { return fail(res, e.code === 413 ? 413 : 400, "That file is over 10 MB."); }
    if (!buf.length) return fail(res, 400, "That file is empty.");
    const name = clip(decodeURIComponent(String(req.headers["x-filename"] || "file")), 120).replace(/[\\/\0]/g, "_") || "file";
    const file = { id: id(), name, size: buf.length, stored: crypto.randomBytes(16).toString("hex"), at: Date.now() };
    fs.writeFileSync(path.join(UPLOADS, file.stored), buf);
    c.files.push(file);
    c.lastActivity = Date.now();
    store.updateClient(c);
    return json(res, 200, { id: file.id, name: file.name, size: file.size });
  }
  if (sub === "/skipfiles" && method === "POST") {
    c.filesSkipped = true; c.lastActivity = Date.now(); store.updateClient(c);
    return json(res, 200, { ok: true });
  }
  if (sub === "/meeting" && method === "POST") {
    const b = await readJson(req);
    const when = clip(b.when, 60);
    if (!when) return fail(res, 400, "Please tell us when you booked.");
    c.meeting = { when, at: Date.now() };
    c.lastActivity = Date.now();
    store.updateClient(c);
    return json(res, 200, { ok: true });
  }
  return fail(res, 404, "Not found.");
}

function sendFile(res, c, fileId) {
  const file = c.files.find((x) => x.id === fileId);
  if (!file) return fail(res, 404, "File not found.");
  const safe = file.name.replace(/[^\w.\- ]/g, "_");
  res.writeHead(200, {
    "content-type": "application/octet-stream", // never let the browser render an upload
    "content-disposition": `attachment; filename="${safe}"`,
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(path.join(UPLOADS, file.stored)).pipe(res);
}

// ---------- static pages ----------
function serveStatic(req, res, url) {
  let file;
  if (url.pathname === "/") file = "index.html";
  else if (url.pathname === "/app") file = "app.html";
  else if (url.pathname.startsWith("/c/")) file = "client.html";
  else file = url.pathname.slice(1);
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(full)] || "application/octet-stream",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    // Client links are secret, so keep them out of search engines
    "x-robots-tag": file === "client.html" ? "noindex, nofollow" : "all",
  });
  fs.createReadStream(full).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) {
      // Block cross-site writes: browsers send Origin on POST/PUT/PATCH/DELETE
      const origin = req.headers.origin;
      if (req.method !== "GET" && origin && new URL(origin).host !== req.headers.host) return fail(res, 403, "Blocked.");
      return await api(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    if (e.code === 400 || e.code === 413) return fail(res, e.code, e.message);
    console.error(e);
    return fail(res, 500, "Something went wrong.");
  }
});

if (process.argv[1] === import.meta.filename) {
  server.listen(PORT, () => console.log(`Client portal running at http://localhost:${PORT}`));
}
