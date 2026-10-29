import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { loadConfig, checkProduction } from "./config.mjs";
import { createBackends } from "./store.mjs";
import { createMailer, emails } from "./mail.mjs";

const scrypt = promisify(crypto.scrypt);
const PUBLIC = path.join(import.meta.dirname, "public");
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 20; // per client
const MAX_MESSAGES = 500; // per client
const SESSION_DAYS = 14;
const RESET_MINUTES = 60;
const REMIND_AFTER_DAYS = 3;
const MAX_REMINDERS = 3;
const MAIL_THROTTLE_MS = 10 * 60 * 1000; // at most one message email per 10 minutes per client and direction

const DEFAULT_QUESTIONS = [
  { id: "q1", label: "What are you hoping to achieve?", type: "long", required: true },
  { id: "q2", label: "Do you have a deadline?", type: "text", required: false },
  { id: "q3", label: "Budget range", type: "choice", options: ["Under £500", "£500 – £2,000", "£2,000 – £10,000", "£10,000+"], required: false },
];
const DEFAULT_CONTRACT = { title: "Service agreement", body: "" };

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// ---------- small helpers ----------
const rid = () => crypto.randomBytes(8).toString("hex");
const secret = () => crypto.randomBytes(24).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
const validColour = (c) => /^#[0-9a-fA-F]{6}$/.test(c);
const safeUrl = (u) => { // meeting links must be http(s), never javascript: or data:
  if (!u) return "";
  try { const x = new URL(u); return ["http:", "https:"].includes(x.protocol) ? x.toString() : ""; }
  catch { return ""; }
};
const equalSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return salt + ":" + (await scrypt(pw, salt, 64)).toString("hex");
}
const DUMMY_HASH = "0".repeat(32) + ":" + "0".repeat(128);
async function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(hash, "hex");
  const b = await scrypt(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

export function createApp({ config, store, files, mailer }) {
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const fail = (res, code, message) => json(res, code, { error: message });
  const log = (event, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...extra }));

  const ipOf = (req) => {
    if (config.trustProxy) { // behind App Runner the real client is the last address the proxy appended
      const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || "?";
  };
  const baseUrl = (req) => config.appUrl || (config.production ? "" : `http://${req.headers.host || "localhost"}`);

  // ----- cookies and sessions -----
  const cookie = (req, name) => {
    const m = (req.headers.cookie || "").split(/;\s*/).find((p) => p.startsWith(name + "="));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  };
  const sessionCookie = (value, maxAge) =>
    `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.production ? "; Secure" : ""}`;
  async function startSession(res, f) {
    const sid = secret();
    await store.addSession({ id: sha(sid), freelancerId: f.id, created: Date.now(), expires: Date.now() + SESSION_DAYS * 86400_000 });
    return { "set-cookie": sessionCookie(sid, SESSION_DAYS * 86400) };
  }
  async function currentFreelancer(req) {
    const sid = cookie(req, "sid");
    if (!sid) return null;
    const s = await store.session(sha(sid));
    if (!s) return null;
    const f = await store.freelancerById(s.freelancerId);
    // A password reset invalidates every session created before it
    if (!f || (f.passwordChangedAt && s.created < f.passwordChangedAt)) return null;
    return f;
  }

  // ----- in-memory rate limiter (per instance) -----
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600_000)) hits.delete(k); }, 600_000).unref();
  function limited(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length > max;
  }

  // ----- onboarding logic -----
  function stepsFor(f, c) {
    const steps = [];
    if (f.questions.length) steps.push({ key: "intake", label: "Tell me about your project", done: !!c.intake });
    if (c.contract) steps.push({ key: "contract", label: "Review and sign", done: !!c.contract.signed });
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
    status: statusOf(f, c), steps: stepsFor(f, c), token: c.token, lastActivity: c.lastActivity, opened: !!c.opened,
    unread: c.unread || 0, lastMessageAt: c.lastMessageAt || 0, invitedAt: c.invitedAt || 0,
    reminders: c.reminders || 0, hasContract: !!c.contract, signed: !!c.contract?.signed,
  });
  const clientLink = (req, c) => `${baseUrl(req)}/c/${c.token}`;

  // Fire-and-forget email: a mail problem must never break the request that caused it.
  function notify(kind, data, to) {
    if (!to) return;
    const { subject, text, html } = emails[kind](data);
    Promise.resolve().then(() => mailer.send({ to, subject, text, html })).catch((e) => log("mail_failed", { kind, error: String(e.message || e) }));
  }

  // After anything the client does: tell the freelancer once when every step is done.
  async function checkComplete(req, f, c) {
    const complete = statusOf(f, c) === "ready";
    if (complete && !c.notifiedReady) {
      c.notifiedReady = true;
      if (f.notify !== false) notify("finished", { f, c, link: `${baseUrl(req)}/app` }, f.email);
    } else if (!complete && statusOf(f, c) !== "active" && c.notifiedReady) {
      c.notifiedReady = false; // a new step was added, so a later completion should notify again
    }
  }

  // ---------- API ----------
  async function api(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const ip = ipOf(req);

    if (p === "/api/auth/signup" && method === "POST") {
      if (limited("signup:" + ip, 10, 3600_000)) return fail(res, 429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      const email = clip(b.email, 200).toLowerCase();
      const name = clip(b.name, 80);
      if (!name) return fail(res, 400, "Please enter your name.");
      if (!validEmail(email)) return fail(res, 400, "Please enter a valid email.");
      const pw = String(b.password || "");
      if (pw.length < 8 || pw.length > 200) return fail(res, 400, "Password must be 8 to 200 characters.");
      const f = await store.addFreelancer({
        id: rid(), email, name, business: clip(b.business, 80) || name,
        password: await hashPassword(pw), colour: "#4f46e5",
        welcome: "Welcome! A few quick steps so we can get started smoothly.",
        meetingUrl: "", meetingNote: "Pick a time that suits you for a short kick-off call.",
        askForFiles: true, questions: DEFAULT_QUESTIONS, contractTemplate: DEFAULT_CONTRACT, notify: true,
        created: Date.now(), passwordChangedAt: 0,
      });
      if (!f) return fail(res, 409, "An account with that email already exists.");
      return json(res, 200, { ok: true }, await startSession(res, f));
    }
    if (p === "/api/auth/login" && method === "POST") {
      if (limited("login:" + ip, 10, 900_000)) return fail(res, 429, "Too many attempts. Try again in a few minutes.");
      const b = await readJson(req);
      const f = await store.freelancerByEmail(clip(b.email, 200).toLowerCase());
      // Always run the hash so response time doesn't reveal whether the email exists
      const good = await checkPassword(String(b.password || "").slice(0, 200), f ? f.password : DUMMY_HASH);
      if (!f || !good) return fail(res, 401, "Email or password is incorrect.");
      return json(res, 200, { ok: true }, await startSession(res, f));
    }
    if (p === "/api/auth/logout" && method === "POST") {
      const sid = cookie(req, "sid");
      if (sid) await store.dropSession(sha(sid));
      return json(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    }
    if (p === "/api/auth/forgot" && method === "POST") {
      if (limited("forgot:" + ip, 5, 3600_000)) return fail(res, 429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      const f = await store.freelancerByEmail(clip(b.email, 200).toLowerCase());
      if (f && baseUrl(req)) {
        const token = secret();
        await store.putReset({ hash: sha(token), freelancerId: f.id, expires: Date.now() + RESET_MINUTES * 60_000 });
        notify("reset", { f, link: `${baseUrl(req)}/reset?token=${token}` }, f.email);
      }
      return json(res, 200, { ok: true }); // same answer whether or not the account exists
    }
    if (p === "/api/auth/reset" && method === "POST") {
      if (limited("reset:" + ip, 10, 3600_000)) return fail(res, 429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      const pw = String(b.password || "");
      if (pw.length < 8 || pw.length > 200) return fail(res, 400, "Password must be 8 to 200 characters.");
      const r = await store.takeReset(sha(String(b.token || "")));
      if (!r) return fail(res, 400, "This reset link has expired or was already used. Please request a new one.");
      const f = await store.freelancerById(r.freelancerId);
      if (!f) return fail(res, 400, "This reset link is no longer valid.");
      f.password = await hashPassword(pw);
      f.passwordChangedAt = Date.now();
      await store.saveFreelancer(f);
      return json(res, 200, { ok: true }, await startSession(res, f));
    }

    // scheduled job: remind clients who haven't finished (call daily from any scheduler that can POST)
    if (p === "/api/cron/reminders" && method === "POST") {
      if (!config.cronSecret || !equalSecret(req.headers["x-cron-secret"] || "", config.cronSecret)) return fail(res, 404, "Not found.");
      let sent = 0;
      const cache = new Map();
      for (const c of await store.allClients()) {
        if (!c.email) continue;
        let f = cache.get(c.freelancerId);
        if (!f) { f = await store.freelancerById(c.freelancerId); cache.set(c.freelancerId, f); }
        if (!f) continue;
        const st = statusOf(f, c);
        if (st !== "invited" && st !== "in_progress") continue;
        if (!c.invitedAt && !c.lastRemindedAt) continue; // never email someone who wasn't invited by email
        const since = Date.now() - Math.max(c.lastRemindedAt || 0, c.invitedAt || 0); // time since we last emailed them
        if ((c.reminders || 0) >= MAX_REMINDERS || since < REMIND_AFTER_DAYS * 86400_000) continue;
        notify("reminder", { f, c, link: clientLink(req, c) }, c.email);
        c.reminders = (c.reminders || 0) + 1; c.lastRemindedAt = Date.now();
        await store.saveClient(c); sent++;
      }
      return json(res, 200, { sent });
    }

    // client portal: access by secret link token
    let m = p.match(/^\/api\/portal\/([\w-]{20,})(\/[a-z]+)?$/);
    if (m) return portal(req, res, m[1], m[2] || "", ip);

    // everything below needs a logged-in freelancer
    const f = await currentFreelancer(req);
    if (!f) return fail(res, 401, "Please log in.");

    if (p === "/api/me" && method === "GET") return json(res, 200, { email: f.email, notify: f.notify !== false, contractTemplate: f.contractTemplate || DEFAULT_CONTRACT, ...brand(f) });

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
      f.notify = b.notify !== false;
      if (b.contractTemplate) f.contractTemplate = { title: clip(b.contractTemplate.title, 120) || "Service agreement", body: clip(b.contractTemplate.body, 20000) };
      if (Array.isArray(b.questions)) {
        f.questions = b.questions.slice(0, 15).map((q) => ({
          id: clip(q.id, 20) || rid(),
          label: clip(q.label, 200),
          type: ["text", "long", "choice"].includes(q.type) ? q.type : "text",
          options: q.type === "choice" ? (q.options || []).slice(0, 10).map((o) => clip(o, 80)).filter(Boolean) : undefined,
          required: !!q.required,
        })).filter((q) => q.label);
      }
      await store.saveFreelancer(f);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/clients" && method === "GET") {
      const list = await store.clientsOf(f.id);
      return json(res, 200, list.map((c) => clientSummary(f, c)).sort((a, b) => b.created - a.created));
    }
    if (p === "/api/clients" && method === "POST") {
      const b = await readJson(req);
      const name = clip(b.name, 80);
      if (!name) return fail(res, 400, "Client name is required.");
      const email = clip(b.email, 200).toLowerCase();
      if (email && !validEmail(email)) return fail(res, 400, "That email doesn't look right.");
      const c = await store.addClient({
        id: rid(), freelancerId: f.id, token: secret(), name, email, project: clip(b.project, 120),
        created: Date.now(), lastActivity: Date.now(), intake: null, files: [], meeting: null, contract: null,
        notes: "", status: "", unread: 0, reminders: 0,
      });
      return json(res, 200, clientSummary(f, c));
    }

    m = p.match(/^\/api\/clients\/(\w+)(?:\/(files|contract|invite|remind|messages)(?:\/(\w+))?)?$/);
    if (!m) return fail(res, 404, "Not found.");
    const c = await store.clientById(f.id, m[1]);
    if (!c) return fail(res, 404, "Client not found.");
    const sub = m[2], subId = m[3];

    if (!sub) {
      if (method === "GET") {
        return json(res, 200, { ...clientSummary(f, c), intake: c.intake, files: c.files, meeting: c.meeting, notes: c.notes, questions: f.questions, contract: c.contract || null, contractTemplate: f.contractTemplate || DEFAULT_CONTRACT });
      }
      if (method === "PATCH") {
        const b = await readJson(req);
        if (typeof b.notes === "string") c.notes = clip(b.notes, 4000);
        if (["active", "archived", ""].includes(b.status)) c.status = b.status;
        if (b.name !== undefined) c.name = clip(b.name, 80) || c.name;
        await store.saveClient(c);
        return json(res, 200, clientSummary(f, c));
      }
      if (method === "DELETE") {
        for (const file of c.files) await files.del(`${c.id}/${file.stored}`);
        await store.deleteClient(f.id, c.id);
        return json(res, 200, { ok: true });
      }
    }

    if (sub === "files" && subId && method === "GET") {
      const file = c.files.find((x) => x.id === subId);
      if (!file) return fail(res, 404, "File not found.");
      const buf = await files.get(`${c.id}/${file.stored}`);
      if (!buf) return fail(res, 404, "File not found.");
      const safe = file.name.replace(/[^\w.\- ]/g, "_");
      res.writeHead(200, {
        "content-type": "application/octet-stream", // never let the browser render an upload
        "content-disposition": `attachment; filename="${safe}"`, "x-content-type-options": "nosniff", "content-length": buf.length,
      });
      return res.end(buf);
    }

    if (sub === "contract" && method === "PUT") {
      if (c.contract?.signed) return fail(res, 409, "This contract is already signed and can't be changed.");
      const b = await readJson(req);
      const title = clip(b.title, 120), body = clip(b.body, 20000);
      if (!title && !body) { c.contract = null; }
      else {
        if (!title) return fail(res, 400, "Please give the contract a title.");
        if (body.length < 10) return fail(res, 400, "The contract text is too short.");
        c.contract = { title, body, added: Date.now(), signed: null };
      }
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(res, 200, clientSummary(f, c));
    }

    if (sub === "invite" && method === "POST") {
      if (!c.email) return fail(res, 400, "Add an email address for this client first.");
      if (limited("invite:" + c.id, 5, 3600_000)) return fail(res, 429, "You've sent this a few times already. Try again later.");
      notify("invite", { f, c, link: clientLink(req, c) }, c.email);
      c.invitedAt = Date.now();
      await store.saveClient(c);
      return json(res, 200, clientSummary(f, c));
    }
    if (sub === "remind" && method === "POST") {
      if (!c.email) return fail(res, 400, "Add an email address for this client first.");
      if (statusOf(f, c) === "ready" || c.status) return fail(res, 400, "This client has nothing left to do.");
      if (Date.now() - (c.lastRemindedAt || 0) < 86400_000) return fail(res, 429, "You reminded them within the last day.");
      notify("reminder", { f, c, link: clientLink(req, c) }, c.email);
      c.lastRemindedAt = Date.now(); c.reminders = (c.reminders || 0) + 1;
      await store.saveClient(c);
      return json(res, 200, clientSummary(f, c));
    }

    if (sub === "messages") {
      if (method === "GET") {
        if (c.unread) { c.unread = 0; await store.saveClient(c); }
        return json(res, 200, await store.messagesOf(c.id));
      }
      if (method === "POST") {
        const b = await readJson(req);
        const text = clip(b.text, 2000);
        if (!text) return fail(res, 400, "Write a message first.");
        if (limited("fmsg:" + f.id, 60, 600_000)) return fail(res, 429, "Slow down a little.");
        if ((await store.messagesOf(c.id)).length >= MAX_MESSAGES) return fail(res, 400, "This conversation is full.");
        const msg = await store.addMessage({ id: rid(), clientId: c.id, from: "freelancer", text, at: Date.now() });
        if (c.email && Date.now() - (c.lastMailToClient || 0) > MAIL_THROTTLE_MS) {
          notify("messageToClient", { f, c, link: clientLink(req, c), text }, c.email);
          c.lastMailToClient = Date.now(); await store.saveClient(c);
        }
        return json(res, 200, msg);
      }
    }
    return fail(res, 404, "Not found.");
  }

  async function portal(req, res, tok, sub, ip) {
    const c = await store.clientByToken(tok);
    if (!c) return fail(res, 404, "This link isn't valid. Please check with the person who sent it.");
    const f = await store.freelancerById(c.freelancerId);
    if (!f) return fail(res, 404, "This link isn't valid. Please check with the person who sent it.");
    const method = req.method;
    // Per-link limit: stops a leaked link being used to flood storage or inboxes
    if (method !== "GET" && limited("portal:" + c.id, 120, 3600_000)) return fail(res, 429, "Too many actions. Please try again later.");

    if (sub === "" && method === "GET") {
      if (!c.opened) { c.opened = Date.now(); await store.saveClient(c); }
      return json(res, 200, {
        client: { name: c.name, project: c.project }, brand: brand(f),
        steps: stepsFor(f, c), status: statusOf(f, c), intake: c.intake,
        files: c.files.map(({ id, name, size }) => ({ id, name, size })), meeting: c.meeting,
        contract: c.contract ? { title: c.contract.title, body: c.contract.body, signed: c.contract.signed ? { name: c.contract.signed.name, at: c.contract.signed.at } : null } : null,
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
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(res, 200, { ok: true });
    }
    if (sub === "/upload" && method === "POST") {
      if (!f.askForFiles) return fail(res, 400, "File uploads are turned off.");
      if (c.files.length >= MAX_FILES) return fail(res, 400, "File limit reached.");
      if (Number(req.headers["content-length"] || 0) > MAX_UPLOAD) return fail(res, 413, "That file is over 10 MB.");
      let buf;
      try { buf = await readBody(req, MAX_UPLOAD); }
      catch (e) { return fail(res, e.code === 413 ? 413 : 400, "That file is over 10 MB."); }
      if (!buf.length) return fail(res, 400, "That file is empty.");
      let name = "file";
      try { name = decodeURIComponent(String(req.headers["x-filename"] || "file")); } catch { /* keep default */ }
      name = clip(name, 120).replace(/[\\/\0]/g, "_") || "file";
      const file = { id: rid(), name, size: buf.length, stored: crypto.randomBytes(16).toString("hex"), at: Date.now() };
      await files.put(`${c.id}/${file.stored}`, buf);
      c.files.push(file);
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(res, 200, { id: file.id, name: file.name, size: file.size });
    }
    if (sub === "/skipfiles" && method === "POST") {
      c.filesSkipped = true; c.lastActivity = Date.now();
      await checkComplete(req, f, c); await store.saveClient(c);
      return json(res, 200, { ok: true });
    }
    if (sub === "/meeting" && method === "POST") {
      const b = await readJson(req);
      const when = clip(b.when, 60);
      if (!when) return fail(res, 400, "Please tell us when you booked.");
      c.meeting = { when, at: Date.now() };
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(res, 200, { ok: true });
    }
    if (sub === "/sign" && method === "POST") {
      if (!c.contract) return fail(res, 400, "There's nothing to sign yet.");
      if (c.contract.signed) return fail(res, 409, "This has already been signed.");
      const b = await readJson(req);
      const name = clip(b.name, 120);
      if (name.length < 2) return fail(res, 400, "Please type your full name to sign.");
      if (b.agree !== true) return fail(res, 400, "Please tick the box to confirm you agree.");
      c.contract.signed = {
        name, at: Date.now(), ip, ua: clip(req.headers["user-agent"], 300),
        hash: sha(c.contract.title + "\n" + c.contract.body), // proves which exact text was signed
      };
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      if (f.notify !== false) notify("signed", { f, c, link: `${baseUrl(req)}/app` }, f.email);
      return json(res, 200, { ok: true });
    }
    if (sub === "/messages" && method === "GET") return json(res, 200, await store.messagesOf(c.id));
    if (sub === "/messages" && method === "POST") {
      const b = await readJson(req);
      const text = clip(b.text, 2000);
      if (!text) return fail(res, 400, "Write a message first.");
      if (limited("cmsg:" + c.id, 30, 600_000)) return fail(res, 429, "Slow down a little.");
      if ((await store.messagesOf(c.id)).length >= MAX_MESSAGES) return fail(res, 400, "This conversation is full.");
      const msg = await store.addMessage({ id: rid(), clientId: c.id, from: "client", text, at: Date.now() });
      c.unread = (c.unread || 0) + 1; c.lastMessageAt = msg.at; c.lastActivity = msg.at;
      if (f.notify !== false && Date.now() - (c.lastMailToFreelancer || 0) > MAIL_THROTTLE_MS) {
        notify("messageToFreelancer", { f, c, link: `${baseUrl(req)}/app`, text }, f.email);
        c.lastMailToFreelancer = Date.now();
      }
      await store.saveClient(c);
      return json(res, 200, msg);
    }
    return fail(res, 404, "Not found.");
  }

  // ---------- static pages ----------
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  function securityHeaders(res) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("content-security-policy", CSP);
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (config.production) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  function serveStatic(req, res, url) {
    let file;
    if (url.pathname === "/") file = "index.html";
    else if (url.pathname === "/app") file = "app.html";
    else if (url.pathname === "/reset") file = "reset.html";
    else if (url.pathname.startsWith("/c/")) file = "client.html";
    else file = decodeURIComponent(url.pathname.slice(1));
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(full)] || "application/octet-stream",
      "cache-control": path.extname(full) === ".html" ? "no-cache" : "public, max-age=300",
      // Client and reset links are secret, so keep them out of search engines
      "x-robots-tag": file === "client.html" || file === "reset.html" || file === "app.html" ? "noindex, nofollow" : "all",
    });
    fs.createReadStream(full).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const started = Date.now();
    securityHeaders(res);
    let url;
    try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }
    try {
      if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
      if (url.pathname.startsWith("/api/")) {
        // Block cross-site writes: browsers send Origin on POST/PUT/PATCH/DELETE
        const origin = req.headers.origin;
        if (req.method !== "GET" && origin) {
          let host = ""; try { host = new URL(origin).host; } catch { /* invalid origin */ }
          if (host !== req.headers.host) return fail(res, 403, "Blocked.");
        }
        return await api(req, res, url);
      }
      return serveStatic(req, res, url);
    } catch (e) {
      if (e.code === 400 || e.code === 413) return fail(res, e.code, e.message);
      log("error", { path: url.pathname, error: String(e && e.stack || e) });
      if (!res.headersSent) return fail(res, 500, "Something went wrong.");
      res.end();
    } finally {
      if (url.pathname.startsWith("/api/") && config.production) log("req", { m: req.method, p: url.pathname.replace(/\/[\w-]{20,}/g, "/:token"), s: res.statusCode, ms: Date.now() - started });
    }
  });
}

// ---------- start-up ----------
if (process.argv[1] === import.meta.filename) {
  const config = loadConfig();
  checkProduction(config);
  const { store, files } = await createBackends(config);
  const server = createApp({ config, store, files, mailer: createMailer(config) });
  server.listen(config.port, () => console.log(`Clientword running at http://localhost:${config.port}`));
  const stop = () => server.close(() => process.exit(0)); // finish in-flight requests on deploy
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
