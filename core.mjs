// Clientword core: every route, written against web-standard Request/Response so the same code
// runs in the local dev server (server.mjs) and inside Next.js route handlers on AWS Amplify.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { emails } from "./mail.mjs";

const scrypt = promisify(crypto.scrypt);
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB per file (bigger deliverables go as links)
const MAX_FILES = 20; // per client
const MAX_MESSAGES = 500; // per client
const MAX_LINKS = 20; // shared links per client
const VERIFY_DAYS = 7;
const CURRENCIES = ["GBP", "EUR", "USD"];
const CLIENT_MAILS_PER_DAY = 100; // per freelancer, so an account can't be used to spam
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

const bad = (code, message) => Object.assign(new Error(message), { code });
async function readBytes(req, limit) {
  if (Number(req.headers.get("content-length") || 0) > limit) throw bad(413, "Too large");
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > limit) throw bad(413, "Too large");
  return buf;
}
async function readJson(req) {
  const buf = await readBytes(req, 1_000_000);
  try { return buf.length ? JSON.parse(buf.toString("utf8")) : {}; }
  catch { throw bad(400, "Bad JSON"); }
}

export function createHandler({ config, store, files, mailer, limiter }) {
  const json = (code, body, headers = {}) =>
    new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
  const fail = (code, message) => json(code, { error: message });
  const hdr = (req, name) => req.headers.get(name) || "";
  const log = (event, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...extra }));

  const ipOf = (req, socketIp) => {
    if (config.trustProxy) { // behind CloudFront (Amplify) the real client is what the edge recorded, never what the client claims
      const cf = hdr(req, "cloudfront-viewer-address").replace(/:\d+$/, "");
      if (cf) return cf;
      const xff = hdr(req, "x-forwarded-for").split(",").map((x) => x.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return socketIp || "?";
  };
  const baseUrl = (req) => config.appUrl || (config.production ? "" : `http://${hdr(req, "host") || "localhost"}`);

  // ----- cookies and sessions -----
  const cookie = (req, name) => {
    const m = hdr(req, "cookie").split(/;\s*/).find((p) => p.startsWith(name + "="));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
  };
  const sessionCookie = (value, maxAge) =>
    `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.production ? "; Secure" : ""}`;
  async function startSession(f) {
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

  // ----- rate limiting (in memory locally, in DynamoDB on Amplify, where instances come and go) -----
  const limited = (key, max, windowMs) => limiter.hit(key, max, windowMs);

  // ----- onboarding logic -----
  function stepsFor(f, c) {
    const steps = [];
    if (f.questions.length) steps.push({ key: "intake", label: "Tell me about your project", done: !!c.intake });
    if (c.contract) steps.push({ key: "contract", label: "Review and sign", done: !!c.contract.signed });
    if (c.deposit) steps.push({ key: "deposit", label: "Pay your deposit", done: !!(c.deposit.claimedAt || c.deposit.paidAt) });
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
    reminders: c.reminders || 0, hasContract: !!c.contract, signed: !!c.contract?.signed, deposit: depositState(c),
  });
  const depositState = (c) => !c.deposit ? "none" : c.deposit.paidAt ? "received" : c.deposit.claimedAt ? "claimed" : "requested";
  const depositView = (c) => c.deposit && { amountPence: c.deposit.amountPence, currency: c.deposit.currency, note: c.deposit.note, url: c.deposit.url, state: depositState(c), claimedAt: c.deposit.claimedAt || 0, paidAt: c.deposit.paidAt || 0 };
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

  async function sendVerification(req, f) {
    if (!baseUrl(req)) return;
    const token = secret();
    await store.putReset({ hash: sha(token), freelancerId: f.id, kind: "verify", expires: Date.now() + VERIFY_DAYS * 86400_000 });
    notify("verify", { f, link: `${baseUrl(req)}/verify?token=${token}` }, f.email);
  }
  // Emails to a freelancer's clients go out only from verified accounts, within a daily cap
  const clientMailBlock = async (f) => !f.emailVerified ? "Please confirm your own email first. We've sent you a link, and you can resend it from the dashboard." : (await limited("clientmail:" + f.id, CLIENT_MAILS_PER_DAY, 86400_000)) ? "You've reached today's email limit. Try again tomorrow." : null;

  // ---------- API ----------
  async function api(req, url, socketIp) {
    const p = url.pathname;
    const method = req.method;
    const ip = ipOf(req, socketIp);

    if (p === "/api/auth/signup" && method === "POST") {
      if (await limited("signup:" + ip, 10, 3600_000)) return fail(429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      const email = clip(b.email, 200).toLowerCase();
      const name = clip(b.name, 80);
      if (!name) return fail(400, "Please enter your name.");
      if (!validEmail(email)) return fail(400, "Please enter a valid email.");
      const pw = String(b.password || "");
      if (pw.length < 8 || pw.length > 200) return fail(400, "Password must be 8 to 200 characters.");
      const f = await store.addFreelancer({
        id: rid(), email, name, business: clip(b.business, 80) || name,
        password: await hashPassword(pw), colour: "#4f46e5",
        welcome: "Welcome! A few quick steps so we can get started smoothly.",
        meetingUrl: "", meetingNote: "Pick a time that suits you for a short kick-off call.",
        askForFiles: true, questions: DEFAULT_QUESTIONS, contractTemplate: DEFAULT_CONTRACT, notify: true,
        created: Date.now(), passwordChangedAt: 0, emailVerified: false, currency: "GBP", payInstructions: "",
      });
      if (!f) return fail(409, "An account with that email already exists.");
      await sendVerification(req, f);
      return json(200, { ok: true }, await startSession(f));
    }
    if (p === "/api/auth/login" && method === "POST") {
      if (await limited("login:" + ip, 10, 900_000)) return fail(429, "Too many attempts. Try again in a few minutes.");
      const b = await readJson(req);
      const f = await store.freelancerByEmail(clip(b.email, 200).toLowerCase());
      // Always run the hash so response time doesn't reveal whether the email exists
      const good = await checkPassword(String(b.password || "").slice(0, 200), f ? f.password : DUMMY_HASH);
      if (!f || !good) return fail(401, "Email or password is incorrect.");
      return json(200, { ok: true }, await startSession(f));
    }
    if (p === "/api/auth/logout" && method === "POST") {
      const sid = cookie(req, "sid");
      if (sid) await store.dropSession(sha(sid));
      return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    }
    if (p === "/api/auth/forgot" && method === "POST") {
      if (await limited("forgot:" + ip, 5, 3600_000)) return fail(429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      const f = await store.freelancerByEmail(clip(b.email, 200).toLowerCase());
      if (f && baseUrl(req)) {
        const token = secret();
        await store.putReset({ hash: sha(token), freelancerId: f.id, kind: "reset", expires: Date.now() + RESET_MINUTES * 60_000 });
        notify("reset", { f, link: `${baseUrl(req)}/reset?token=${token}` }, f.email);
      }
      return json(200, { ok: true }); // same answer whether or not the account exists
    }
    if (p === "/api/auth/reset" && method === "POST") {
      if (await limited("reset:" + ip, 10, 3600_000)) return fail(429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      const pw = String(b.password || "");
      if (pw.length < 8 || pw.length > 200) return fail(400, "Password must be 8 to 200 characters.");
      const r = await store.takeReset(sha(String(b.token || "")), "reset");
      if (!r) return fail(400, "This reset link has expired or was already used. Please request a new one.");
      const f = await store.freelancerById(r.freelancerId);
      if (!f) return fail(400, "This reset link is no longer valid.");
      f.password = await hashPassword(pw);
      f.passwordChangedAt = Date.now();
      f.emailVerified = true; // they just proved they own the inbox
      await store.saveFreelancer(f);
      return json(200, { ok: true }, await startSession(f));
    }

    if (p === "/api/auth/verify" && method === "POST") {
      if (await limited("verify:" + ip, 20, 3600_000)) return fail(429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      const r = await store.takeReset(sha(String(b.token || "")), "verify");
      if (!r) return fail(400, "This confirmation link has expired or was already used. Log in and ask for a new one.");
      const f = await store.freelancerById(r.freelancerId);
      if (!f) return fail(400, "This confirmation link is no longer valid.");
      f.emailVerified = true;
      await store.saveFreelancer(f);
      return json(200, { ok: true });
    }

    // scheduled job: remind clients who haven't finished (call daily from any scheduler that can POST)
    if (p === "/api/cron/reminders" && method === "POST") {
      if (!config.cronSecret || !equalSecret(hdr(req, "x-cron-secret"), config.cronSecret)) return fail(404, "Not found.");
      let sent = 0;
      const cache = new Map();
      for (const c of await store.allClients()) {
        if (!c.email) continue;
        let f = cache.get(c.freelancerId);
        if (!f) { f = await store.freelancerById(c.freelancerId); cache.set(c.freelancerId, f); }
        if (!f || !f.emailVerified) continue;
        const st = statusOf(f, c);
        if (st !== "invited" && st !== "in_progress") continue;
        if (!c.invitedAt && !c.lastRemindedAt) continue; // never email someone who wasn't invited by email
        const since = Date.now() - Math.max(c.lastRemindedAt || 0, c.invitedAt || 0); // time since we last emailed them
        if ((c.reminders || 0) >= MAX_REMINDERS || since < REMIND_AFTER_DAYS * 86400_000) continue;
        if ((await clientMailBlock(f))) continue;
        notify("reminder", { f, c, link: clientLink(req, c) }, c.email);
        c.reminders = (c.reminders || 0) + 1; c.lastRemindedAt = Date.now();
        await store.saveClient(c); sent++;
      }
      return json(200, { sent });
    }

    // client portal: access by secret link token
    let m = p.match(/^\/api\/portal\/([\w-]{20,})(\/[a-z-]+)?$/);
    if (m) return portal(req, m[1], m[2] || "", ip);

    // everything below needs a logged-in freelancer
    const f = await currentFreelancer(req);
    if (!f) return fail(401, "Please log in.");

    if (p === "/api/auth/resend-verify" && method === "POST") {
      if (f.emailVerified) return json(200, { ok: true, already: true });
      if (await limited("resend:" + f.id, 3, 3600_000)) return fail(429, "You've asked a few times already. Check your spam folder, or try again later.");
      await sendVerification(req, f);
      return json(200, { ok: true });
    }
    if (p === "/api/account/export" && method === "GET") {
      const out = { exportedAt: new Date().toISOString(), account: (({ password, ...rest }) => rest)(f), clients: [] };
      for (const c of await store.clientsOf(f.id)) out.clients.push({ ...c, messages: await store.messagesOf(c.id) });
      return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="clientword-export.json"', "cache-control": "no-store" } });
    }
    if (p === "/api/account" && method === "DELETE") {
      if (await limited("delacct:" + f.id, 5, 3600_000)) return fail(429, "Too many attempts. Try again later.");
      const b = await readJson(req);
      if (!(await checkPassword(String(b.password || "").slice(0, 200), f.password))) return fail(403, "That password is not correct.");
      for (const c of await store.clientsOf(f.id)) {
        for (const file of c.files) await files.del(`${c.id}/${file.stored}`);
        await store.deleteClient(f.id, c.id);
      }
      await store.deleteFreelancer(f); // their sessions stop working because the account no longer exists
      log("account_deleted", { id: f.id });
      return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    }

    if (p === "/api/me" && method === "GET") return json(200, { email: f.email, verified: !!f.emailVerified, currency: f.currency || "GBP", payInstructions: f.payInstructions || "", notify: f.notify !== false, contractTemplate: f.contractTemplate || DEFAULT_CONTRACT, ...brand(f) });

    if (p === "/api/settings" && method === "PUT") {
      const b = await readJson(req);
      // Validate first, then change anything, so a rejected request leaves no half-applied edits
      const meetingUrl = safeUrl(clip(b.meetingUrl, 500));
      if (b.meetingUrl && !meetingUrl) return fail(400, "Meeting link must start with https://");
      f.name = clip(b.name, 80) || f.name;
      f.business = clip(b.business, 80) || f.business;
      if (validColour(b.colour)) f.colour = b.colour;
      f.welcome = clip(b.welcome, 600);
      f.meetingUrl = meetingUrl;
      f.meetingNote = clip(b.meetingNote, 300);
      f.askForFiles = !!b.askForFiles;
      f.notify = b.notify !== false;
      if (CURRENCIES.includes(b.currency)) f.currency = b.currency;
      f.payInstructions = clip(b.payInstructions, 600);
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
      return json(200, { ok: true });
    }

    if (p === "/api/clients" && method === "GET") {
      const list = await store.clientsOf(f.id);
      return json(200, list.map((c) => clientSummary(f, c)).sort((a, b) => b.created - a.created));
    }
    if (p === "/api/clients" && method === "POST") {
      const b = await readJson(req);
      const name = clip(b.name, 80);
      if (!name) return fail(400, "Client name is required.");
      const email = clip(b.email, 200).toLowerCase();
      if (email && !validEmail(email)) return fail(400, "That email doesn't look right.");
      const c = await store.addClient({
        id: rid(), freelancerId: f.id, token: secret(), name, email, project: clip(b.project, 120),
        created: Date.now(), lastActivity: Date.now(), intake: null, files: [], meeting: null, contract: null,
        notes: "", status: "", unread: 0, reminders: 0,
      });
      return json(200, clientSummary(f, c));
    }

    m = p.match(/^\/api\/clients\/(\w+)(?:\/(files|contract|invite|remind|messages|deposit|links)(?:\/(\w+))?)?$/);
    if (!m) return fail(404, "Not found.");
    const c = await store.clientById(f.id, m[1]);
    if (!c) return fail(404, "Client not found.");
    const sub = m[2], subId = m[3];

    if (!sub) {
      if (method === "GET") {
        return json(200, { ...clientSummary(f, c), intake: c.intake, files: c.files, meeting: c.meeting, notes: c.notes, questions: f.questions, contract: c.contract || null, contractTemplate: f.contractTemplate || DEFAULT_CONTRACT, deposit: depositView(c) || null, links: c.links || [], currency: f.currency || "GBP", payInstructions: f.payInstructions || "" });
      }
      if (method === "PATCH") {
        const b = await readJson(req);
        if (typeof b.notes === "string") c.notes = clip(b.notes, 4000);
        if (["active", "archived", ""].includes(b.status)) c.status = b.status;
        if (b.name !== undefined) c.name = clip(b.name, 80) || c.name;
        await store.saveClient(c);
        return json(200, clientSummary(f, c));
      }
      if (method === "DELETE") {
        for (const file of c.files) await files.del(`${c.id}/${file.stored}`);
        await store.deleteClient(f.id, c.id);
        return json(200, { ok: true });
      }
    }

    if (sub === "files" && subId && method === "GET") {
      const file = c.files.find((x) => x.id === subId);
      if (!file) return fail(404, "File not found.");
      const safe = file.name.replace(/[^\w.\- ]/g, "_");
      // S3: hand the browser a short-lived link straight to the file (keeps big downloads off the server)
      const direct = await files.presignGet(`${c.id}/${file.stored}`, safe);
      if (direct) return new Response(null, { status: 302, headers: { location: direct, "cache-control": "no-store" } });
      const buf = await files.get(`${c.id}/${file.stored}`);
      if (!buf) return fail(404, "File not found.");
      return new Response(buf, { status: 200, headers: {
        "content-type": "application/octet-stream", // never let the browser render an upload
        "content-disposition": `attachment; filename="${safe}"`, "x-content-type-options": "nosniff", "cache-control": "no-store",
      } });
    }

    if (sub === "contract" && method === "PUT") {
      if (c.contract?.signed) return fail(409, "This contract is already signed and can't be changed.");
      const b = await readJson(req);
      const title = clip(b.title, 120), body = clip(b.body, 20000);
      if (!title && !body) { c.contract = null; }
      else {
        if (!title) return fail(400, "Please give the contract a title.");
        if (body.length < 10) return fail(400, "The contract text is too short.");
        c.contract = { title, body, added: Date.now(), signed: null };
      }
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(200, clientSummary(f, c));
    }

    if (sub === "invite" && method === "POST") {
      if (!c.email) return fail(400, "Add an email address for this client first.");
      if (await limited("invite:" + c.id, 5, 3600_000)) return fail(429, "You've sent this a few times already. Try again later.");
      const blockedInvite = (await clientMailBlock(f));
      if (blockedInvite) return fail(f.emailVerified ? 429 : 403, blockedInvite);
      notify("invite", { f, c, link: clientLink(req, c) }, c.email);
      c.invitedAt = Date.now();
      await store.saveClient(c);
      return json(200, clientSummary(f, c));
    }
    if (sub === "remind" && method === "POST") {
      if (!c.email) return fail(400, "Add an email address for this client first.");
      if (statusOf(f, c) === "ready" || c.status) return fail(400, "This client has nothing left to do.");
      if (Date.now() - (c.lastRemindedAt || 0) < 86400_000) return fail(429, "You reminded them within the last day.");
      const blockedRemind = (await clientMailBlock(f));
      if (blockedRemind) return fail(f.emailVerified ? 429 : 403, blockedRemind);
      notify("reminder", { f, c, link: clientLink(req, c) }, c.email);
      c.lastRemindedAt = Date.now(); c.reminders = (c.reminders || 0) + 1;
      await store.saveClient(c);
      return json(200, clientSummary(f, c));
    }

    if (sub === "deposit" && !subId && method === "PUT") {
      if (c.deposit?.paidAt) return fail(409, "This deposit is already marked as received.");
      const b = await readJson(req);
      const amount = Number(b.amount);
      if (b.amount === "" || b.amount == null) { c.deposit = null; } // clearing the amount removes the request
      else {
        const pence = Math.round(amount * 100);
        if (!Number.isFinite(amount) || pence < 1 || pence > 100_000_000) return fail(400, "Enter a deposit amount between 0.01 and 1,000,000.");
        const url = safeUrl(clip(b.url, 500));
        if (b.url && !url) return fail(400, "The payment link must start with https://");
        const currency = CURRENCIES.includes(b.currency) ? b.currency : (f.currency || "GBP");
        c.deposit = { amountPence: pence, currency, note: clip(b.note, 600), url, claimedAt: c.deposit?.claimedAt || 0, paidAt: 0, added: c.deposit?.added || Date.now() };
      }
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(200, clientSummary(f, c));
    }
    if (sub === "deposit" && subId === "received" && method === "POST") {
      if (!c.deposit) return fail(400, "There's no deposit request on this client.");
      c.deposit.paidAt = Date.now(); c.deposit.claimedAt = c.deposit.claimedAt || c.deposit.paidAt;
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(200, clientSummary(f, c));
    }
    if (sub === "links" && !subId && method === "POST") {
      const b = await readJson(req);
      const title = clip(b.title, 120), url = safeUrl(clip(b.url, 1000));
      if (!title) return fail(400, "Give the link a title.");
      if (!url) return fail(400, "The link must start with https://");
      c.links = c.links || [];
      if (c.links.length >= MAX_LINKS) return fail(400, "That's the maximum number of links for one client.");
      c.links.push({ id: rid(), title, url, at: Date.now() });
      await store.saveClient(c);
      return json(200, c.links);
    }
    if (sub === "links" && subId && method === "DELETE") {
      c.links = (c.links || []).filter((l) => l.id !== subId);
      await store.saveClient(c);
      return json(200, c.links);
    }

    if (sub === "messages") {
      if (method === "GET") {
        if (c.unread) { c.unread = 0; await store.saveClient(c); }
        return json(200, await store.messagesOf(c.id));
      }
      if (method === "POST") {
        const b = await readJson(req);
        const text = clip(b.text, 2000);
        if (!text) return fail(400, "Write a message first.");
        if (await limited("fmsg:" + f.id, 60, 600_000)) return fail(429, "Slow down a little.");
        if ((await store.messagesOf(c.id)).length >= MAX_MESSAGES) return fail(400, "This conversation is full.");
        const msg = await store.addMessage({ id: rid(), clientId: c.id, from: "freelancer", text, at: Date.now() });
        if (c.email && f.emailVerified && Date.now() - (c.lastMailToClient || 0) > MAIL_THROTTLE_MS && !(await clientMailBlock(f))) {
          notify("messageToClient", { f, c, link: clientLink(req, c), text }, c.email);
          c.lastMailToClient = Date.now(); await store.saveClient(c);
        }
        return json(200, msg);
      }
    }
    return fail(404, "Not found.");
  }

  async function portal(req, tok, sub, ip) {
    const c = await store.clientByToken(tok);
    if (!c) return fail(404, "This link isn't valid. Please check with the person who sent it.");
    const f = await store.freelancerById(c.freelancerId);
    if (!f) return fail(404, "This link isn't valid. Please check with the person who sent it.");
    const method = req.method;
    // Per-link limit: stops a leaked link being used to flood storage or inboxes
    if (method !== "GET" && await limited("portal:" + c.id, 120, 3600_000)) return fail(429, "Too many actions. Please try again later.");

    if (sub === "" && method === "GET") {
      if (!c.opened) { c.opened = Date.now(); await store.saveClient(c); }
      return json(200, {
        client: { name: c.name, project: c.project }, brand: brand(f),
        steps: stepsFor(f, c), status: statusOf(f, c), intake: c.intake,
        files: c.files.map(({ id, name, size }) => ({ id, name, size })), meeting: c.meeting,
        deposit: depositView(c) || null, links: (c.links || []).map(({ id, title, url }) => ({ id, title, url })),
        contract: c.contract ? { title: c.contract.title, body: c.contract.body, signed: c.contract.signed ? { name: c.contract.signed.name, at: c.contract.signed.at } : null } : null,
      });
    }
    if (sub === "/intake" && method === "POST") {
      const b = await readJson(req);
      const answers = {};
      for (const q of f.questions) {
        const v = clip(b.answers?.[q.id], 3000);
        if (q.required && !v) return fail(400, `Please answer: ${q.label}`);
        if (q.type === "choice" && v && !q.options.includes(v)) return fail(400, `Please choose an option for: ${q.label}`);
        answers[q.id] = v;
      }
      c.intake = { answers, at: Date.now() };
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(200, { ok: true });
    }
    const cleanName = (raw) => clip(raw, 120).replace(/[\\/\0]/g, "_") || "file";
    // Step 1 of a direct upload: the browser asks where to put the file, then sends it to S3 itself.
    if (sub === "/upload-url" && method === "POST") {
      if (!f.askForFiles) return fail(400, "File uploads are turned off.");
      if (c.files.length >= MAX_FILES) return fail(400, "File limit reached.");
      const b = await readJson(req);
      const size = Math.floor(Number(b.size));
      if (!Number.isFinite(size) || size < 1) return fail(400, "That file is empty.");
      if (size > MAX_UPLOAD) return fail(413, "That file is over 25 MB.");
      const stored = crypto.randomBytes(16).toString("hex");
      const target = await files.presignPut(`${c.id}/${stored}`, size);
      if (!target) return json(200, { mode: "server" }); // local development: send the bytes to /upload instead
      return json(200, { mode: "direct", stored, url: target.url, headers: target.headers });
    }
    // Step 2: confirm the file really arrived, check its size, and add it to the client.
    if (sub === "/upload-done" && method === "POST") {
      if (!f.askForFiles) return fail(400, "File uploads are turned off.");
      if (c.files.length >= MAX_FILES) return fail(400, "File limit reached.");
      const b = await readJson(req);
      const stored = String(b.stored || "");
      if (!/^[0-9a-f]{32}$/.test(stored)) return fail(400, "Bad upload.");
      if (c.files.some((x) => x.stored === stored)) return fail(409, "Already added.");
      const size = await files.size(`${c.id}/${stored}`);
      if (!size) return fail(400, "The upload didn't arrive. Please try again.");
      if (size > MAX_UPLOAD) { await files.del(`${c.id}/${stored}`); return fail(413, "That file is over 25 MB."); }
      const file = { id: rid(), name: cleanName(b.name), size, stored, at: Date.now() };
      c.files.push(file);
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(200, { id: file.id, name: file.name, size: file.size });
    }
    // Direct-to-server upload, used when there is no S3 (local development)
    if (sub === "/upload" && method === "POST") {
      if (!f.askForFiles) return fail(400, "File uploads are turned off.");
      if (c.files.length >= MAX_FILES) return fail(400, "File limit reached.");
      let buf;
      try { buf = await readBytes(req, MAX_UPLOAD); }
      catch (e) { return fail(e.code === 413 ? 413 : 400, "That file is over 25 MB."); }
      if (!buf.length) return fail(400, "That file is empty.");
      let name = "file";
      try { name = decodeURIComponent(hdr(req, "x-filename") || "file"); } catch { /* keep default */ }
      const file = { id: rid(), name: cleanName(name), size: buf.length, stored: crypto.randomBytes(16).toString("hex"), at: Date.now() };
      await files.put(`${c.id}/${file.stored}`, buf);
      c.files.push(file);
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(200, { id: file.id, name: file.name, size: file.size });
    }
    if (sub === "/skipfiles" && method === "POST") {
      c.filesSkipped = true; c.lastActivity = Date.now();
      await checkComplete(req, f, c); await store.saveClient(c);
      return json(200, { ok: true });
    }
    if (sub === "/meeting" && method === "POST") {
      const b = await readJson(req);
      const when = clip(b.when, 60);
      if (!when) return fail(400, "Please tell us when you booked.");
      c.meeting = { when, at: Date.now() };
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      return json(200, { ok: true });
    }
    if (sub === "/sign" && method === "POST") {
      if (!c.contract) return fail(400, "There's nothing to sign yet.");
      if (c.contract.signed) return fail(409, "This has already been signed.");
      const b = await readJson(req);
      const name = clip(b.name, 120);
      if (name.length < 2) return fail(400, "Please type your full name to sign.");
      if (b.agree !== true) return fail(400, "Please tick the box to confirm you agree.");
      c.contract.signed = {
        name, at: Date.now(), ip, ua: clip(hdr(req, "user-agent"), 300),
        hash: sha(c.contract.title + "\n" + c.contract.body), // proves which exact text was signed
      };
      c.lastActivity = Date.now();
      await checkComplete(req, f, c);
      await store.saveClient(c);
      if (f.notify !== false) notify("signed", { f, c, link: `${baseUrl(req)}/app` }, f.email);
      return json(200, { ok: true });
    }
    if (sub === "/paid" && method === "POST") {
      if (!c.deposit) return fail(400, "There's no deposit to pay.");
      if (!c.deposit.claimedAt) {
        c.deposit.claimedAt = Date.now(); c.lastActivity = c.deposit.claimedAt;
        await checkComplete(req, f, c);
        await store.saveClient(c);
        if (f.notify !== false) notify("paid", { f, c, link: `${baseUrl(req)}/app` }, f.email);
      }
      return json(200, { ok: true });
    }
    if (sub === "/messages" && method === "GET") return json(200, await store.messagesOf(c.id));
    if (sub === "/messages" && method === "POST") {
      const b = await readJson(req);
      const text = clip(b.text, 2000);
      if (!text) return fail(400, "Write a message first.");
      if (await limited("cmsg:" + c.id, 30, 600_000)) return fail(429, "Slow down a little.");
      if ((await store.messagesOf(c.id)).length >= MAX_MESSAGES) return fail(400, "This conversation is full.");
      const msg = await store.addMessage({ id: rid(), clientId: c.id, from: "client", text, at: Date.now() });
      c.unread = (c.unread || 0) + 1; c.lastMessageAt = msg.at; c.lastActivity = msg.at;
      if (f.notify !== false && Date.now() - (c.lastMailToFreelancer || 0) > MAIL_THROTTLE_MS) {
        notify("messageToFreelancer", { f, c, link: `${baseUrl(req)}/app`, text }, f.email);
        c.lastMailToFreelancer = Date.now();
      }
      await store.saveClient(c);
      return json(200, msg);
    }
    return fail(404, "Not found.");
  }

  // ---------- entry point ----------
  const API_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
  const withHeaders = (resp) => { // redirects/files from S3 etc. keep their own headers; ours only fill gaps
    for (const [k, v] of Object.entries(API_HEADERS)) if (!resp.headers.has(k)) resp.headers.set(k, v);
    if (config.production) resp.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    return resp;
  };
  // Cross-site writes are blocked: browsers send Origin on POST/PUT/PATCH/DELETE
  const originAllowed = (req) => {
    const origin = req.headers.get("origin");
    if (req.method === "GET" || !origin) return true;
    let host = ""; try { host = new URL(origin).host; } catch { return false; }
    const allowed = new Set([hdr(req, "host"), hdr(req, "x-forwarded-host")].filter(Boolean));
    if (config.appUrl) { try { allowed.add(new URL(config.appUrl).host); } catch { /* ignore */ } }
    return allowed.has(host);
  };

  // handle(request, { ip }) -> Response. `ip` is the socket address when there is one (local server).
  return async function handle(req, { ip: socketIp } = {}) {
    const started = Date.now();
    let url;
    try { url = new URL(req.url); } catch { return withHeaders(new Response(null, { status: 400 })); }
    let resp;
    try {
      if (!url.pathname.startsWith("/api/")) resp = fail(404, "Not found.");
      else if (!originAllowed(req)) resp = fail(403, "Blocked.");
      else resp = await api(req, url, socketIp);
    } catch (e) {
      if (e && (e.code === 400 || e.code === 413)) resp = fail(e.code, e.message);
      else { log("error", { path: url.pathname, error: String(e && e.stack || e) }); resp = fail(500, "Something went wrong."); }
    }
    if (config.production) log("req", { m: req.method, p: url.pathname.replace(/\/[\w-]{20,}/g, "/:token"), s: resp.status, ms: Date.now() - started });
    return withHeaders(resp);
  };
}
