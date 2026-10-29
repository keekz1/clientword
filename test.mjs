// Runs the same API checks against both storage back ends:
//   1. local JSON file store
//   2. DynamoDB store logic, running on an in-memory table (no AWS needed)
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createApp } from "./server.mjs";
import { loadConfig, checkProduction } from "./config.mjs";
import { createLocalStore } from "./store-local.mjs";
import { createDynamoStore } from "./store-dynamo.mjs";
import { createMemoryTable } from "./dynamo-adapter.mjs";
import { createLocalFiles } from "./files.mjs";
import { createHandler } from "./core.mjs";
import { createMemoryLimiter, createTableLimiter } from "./limiter.mjs";
import { createMailer } from "./mail.mjs";

process.env.QUIET = "1";
let total = 0;

async function suite(name, make) {
  console.log(`\n${name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const config = loadConfig({ PORTAL_DATA: dir, CRON_SECRET: "test-cron-secret-0123456789abcdef" });
  const { store, files, table, limiter } = make(dir);
  const mailer = createMailer(config);
  const server = createApp({ config, store, files, mailer, limiter });
  await new Promise((r) => server.listen(0, r));
  const base = "http://localhost:" + server.address().port;

  // a tiny HTTP client with its own cookie jar
  const agent = () => {
    let cookie = "";
    return async function call(method, p, body, { raw, headers } = {}) {
      const res = await fetch(base + p, {
        method, redirect: "manual",
        headers: { ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers, setCookie: sc, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
    };
  };
  const ok = (label) => console.log(`  ✓ ${++total}. ${label}`);
  const tick = () => new Promise((r) => setTimeout(r, 20)); // lets fire-and-forget emails finish
  const mailTo = (to, subjectPart) => mailer.outbox.filter((m) => m.to === to && m.subject.includes(subjectPart));

  const ada = agent(), anon = agent(), bob = agent();

  // --- basics and headers ---
  assert.equal((await anon("GET", "/healthz")).status, 200); ok("health check");
  const home = await anon("GET", "/");
  assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(home.headers.get("x-content-type-options"), "nosniff"); ok("security headers on pages");
  assert.equal((await anon("GET", "/api/clients")).status, 401); ok("clients need login");

  // --- accounts ---
  assert.equal((await anon("POST", "/api/auth/signup", { name: "A", email: "bad", password: "12345678" })).status, 400); ok("bad email rejected");
  assert.equal((await anon("POST", "/api/auth/signup", { name: "A", email: "a@x.com", password: "short" })).status, 400); ok("short password rejected");
  let r = await ada("POST", "/api/auth/signup", { name: "Ada Lovelace", business: "Ada Design", email: "ada@x.com", password: "correct-horse" });
  assert.equal(r.status, 200); assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Lax/); ok("signup sets HttpOnly cookie");
  assert.equal((await anon("POST", "/api/auth/signup", { name: "A", email: "ADA@x.com", password: "correct-horse" })).status, 409); ok("duplicate email (case-insensitive) rejected");
  assert.equal((await anon("POST", "/api/auth/login", { email: "ada@x.com", password: "wrong-pass-1" })).status, 401);
  assert.equal((await anon("POST", "/api/auth/login", { email: "nobody@x.com", password: "wrong-pass-1" })).data.error, "Email or password is incorrect."); ok("wrong password and unknown email give the same error");
  const ada2 = agent();
  assert.equal((await ada2("POST", "/api/auth/login", { email: "ada@x.com", password: "correct-horse" })).status, 200); ok("login works");

  // --- email verification (done first, while Ada is still unverified) ---
  const verifyMail = mailTo("ada@x.com", "Confirm your email")[0];
  assert.ok(verifyMail, "verification email sent at signup");
  const verifyToken = verifyMail.text.match(/token=([\w-]+)/)[1]; ok("signup sends a verification email");
  assert.equal((await ada("GET", "/api/me")).data.verified, false);
  const pre = (await ada("POST", "/api/clients", { name: "Pre", email: "pre@x.com" })).data;
  assert.equal((await ada("POST", `/api/clients/${pre.id}/invite`)).status, 403); ok("unverified accounts can't email clients");
  assert.equal((await anon("POST", "/api/auth/verify", { token: "nope" })).status, 400);
  assert.equal((await anon("POST", "/api/auth/verify", { token: verifyToken })).status, 200);
  assert.equal((await anon("POST", "/api/auth/verify", { token: verifyToken })).status, 400); ok("email verification works once");
  assert.equal((await ada("GET", "/api/me")).data.verified, true);
  assert.equal((await ada("POST", `/api/clients/${pre.id}/invite`)).status, 200); ok("verified accounts can email clients");
  await ada("DELETE", "/api/clients/" + pre.id);

  // --- password reset ---
  mailer.outbox.length = 0;
  assert.equal((await anon("POST", "/api/auth/forgot", { email: "nobody@x.com" })).status, 200); await tick();
  assert.equal(mailer.outbox.length, 0); ok("reset for unknown email: same answer, no email");
  assert.equal((await anon("POST", "/api/auth/forgot", { email: "ada@x.com" })).status, 200); await tick();
  const resetMail = mailTo("ada@x.com", "Reset")[0];
  assert.ok(resetMail, "reset email sent");
  const resetToken = resetMail.text.match(/token=([\w-]+)/)[1]; ok("reset email contains a token link");
  assert.equal((await anon("POST", "/api/auth/reset", { token: "nope", password: "new-password-1" })).status, 400); ok("bad reset token rejected");
  r = await anon("POST", "/api/auth/reset", { token: resetToken, password: "new-password-1" });
  assert.equal(r.status, 200); ok("reset with valid token works and logs in");
  assert.equal((await anon("POST", "/api/auth/reset", { token: resetToken, password: "another-pass-1" })).status, 400); ok("reset token works only once");
  assert.equal((await ada("GET", "/api/me")).status, 401); ok("old sessions are logged out after a password reset");
  assert.equal((await anon("GET", "/api/me")).status, 200);
  const adaNew = agent();
  assert.equal((await adaNew("POST", "/api/auth/login", { email: "ada@x.com", password: "new-password-1" })).status, 200); ok("new password works");
  const A = adaNew;

  // --- settings ---
  r = await A("PUT", "/api/settings", { colour: "#0f766e", welcome: "Hi!", meetingUrl: "javascript:alert(1)", askForFiles: true, questions: [] });
  assert.equal(r.status, 400); ok("javascript: meeting link rejected");
  r = await A("PUT", "/api/settings", { colour: "red", welcome: "Hi!", meetingUrl: "https://cal.com/ada", meetingNote: "Book", askForFiles: true, notify: true,
    contractTemplate: { title: "Terms", body: "Standard terms go here." },
    questions: [{ label: "Goal?", type: "long", required: true }, { label: "Size", type: "choice", options: ["S", "M"] }, { label: "", type: "text" }] });
  assert.equal(r.status, 200);
  const me = (await A("GET", "/api/me")).data;
  assert.equal(me.colour, "#4f46e5"); assert.equal(me.questions.length, 2); assert.equal(me.contractTemplate.title, "Terms"); ok("settings saved; rejected request changed nothing; invalid colour ignored");

  // --- clients and invites ---
  assert.equal((await A("POST", "/api/clients", { name: "" })).status, 400); ok("client name required");
  const c = (await A("POST", "/api/clients", { name: "Grace Hopper", email: "grace@x.com", project: "Website" })).data;
  assert.ok(c.token.length >= 30); assert.equal(c.status, "invited"); assert.equal(c.steps.length, 3); ok("client created with secret token and 3 steps");
  const noEmail = (await A("POST", "/api/clients", { name: "No Email" })).data;
  assert.equal((await A("POST", `/api/clients/${noEmail.id}/invite`)).status, 400); ok("can't email a link with no client email");
  mailer.outbox.length = 0;
  assert.equal((await A("POST", `/api/clients/${c.id}/invite`)).status, 200); await tick();
  const invite = mailTo("grace@x.com", "onboarding page")[0];
  assert.ok(invite.text.includes(`/c/${c.token}`) && invite.html.includes(`/c/${c.token}`)); ok("invite email has the client's private link");
  assert.equal((await A("POST", `/api/clients/${c.id}/remind`)).status, 200); await tick();
  assert.equal((await A("POST", `/api/clients/${c.id}/remind`)).status, 429); ok("manual reminder works, max once a day");

  // --- contract ---
  assert.equal((await A("PUT", `/api/clients/${c.id}/contract`, { title: "Agreement", body: "short" })).status, 400);
  r = await A("PUT", `/api/clients/${c.id}/contract`, { title: "Agreement", body: "I will build your website for the agreed price." });
  assert.equal(r.status, 200); assert.equal(r.data.steps.length, 4); ok("contract added and becomes a client step");

  // --- deposit request ---
  assert.equal((await A("PUT", `/api/clients/${c.id}/deposit`, { amount: "abc" })).status, 400);
  assert.equal((await A("PUT", `/api/clients/${c.id}/deposit`, { amount: 500, url: "javascript:alert(1)" })).status, 400); ok("deposit needs a sensible amount and an https link");
  r = await A("PUT", `/api/clients/${c.id}/deposit`, { amount: 500, currency: "GBP", url: "https://pay.example/abc", note: "Sort code 00-00-00, account 12345678" });
  assert.equal(r.status, 200); assert.equal(r.data.deposit, "requested"); assert.equal(r.data.steps.length, 5); ok("deposit request added as a client step");
  const dep = (await A("GET", "/api/clients/" + c.id)).data.deposit;
  assert.equal(dep.amountPence, 50000); assert.equal(dep.state, "requested");

  // --- shared links ---
  assert.equal((await A("POST", `/api/clients/${c.id}/links`, { title: "Final files", url: "javascript:x" })).status, 400);
  assert.equal((await A("POST", `/api/clients/${c.id}/links`, { title: "", url: "https://drive.example/x" })).status, 400);
  let links = (await A("POST", `/api/clients/${c.id}/links`, { title: "Logo pack", url: "https://drive.example/logo" })).data;
  assert.equal(links.length, 1); ok("freelancer can share a link (https only, needs a title)");

  // --- client portal (no login) ---
  let p = await anon("GET", "/api/portal/" + c.token);
  assert.equal(p.status, 200); assert.equal(p.data.brand.business, "Ada Design");
  assert.ok(!JSON.stringify(p.data).includes("ada@x.com")); assert.equal(p.data.contract.signed, null); ok("portal works without login and doesn't leak the freelancer's email");
  assert.equal((await anon("GET", "/api/portal/" + "x".repeat(32))).status, 404); ok("unknown token → 404");
  const qid = p.data.brand.questions[0].id, sid = p.data.brand.questions[1].id;
  assert.equal((await anon("POST", `/api/portal/${c.token}/intake`, { answers: {} })).status, 400); ok("required question enforced");
  assert.equal((await anon("POST", `/api/portal/${c.token}/intake`, { answers: { [qid]: "A site", [sid]: "XL" } })).status, 400); ok("invalid choice rejected");
  assert.equal((await anon("POST", `/api/portal/${c.token}/intake`, { answers: { [qid]: "A site <b>x</b>", [sid]: "M" } })).status, 200); ok("intake saved");
  r = await anon("POST", `/api/portal/${c.token}/upload`, Buffer.from("hello brief"), { raw: true, headers: { "x-filename": encodeURIComponent("../../etc/brief.txt") } });
  assert.equal(r.status, 200); assert.ok(!r.data.name.includes("/")); ok("upload works; path separators stripped from the name");
  assert.equal((await anon("POST", `/api/portal/${c.token}/upload`, Buffer.alloc(26 * 1024 * 1024), { raw: true })).status, 413); ok("26 MB upload rejected (limit is 25 MB)");
  assert.equal((await anon("POST", `/api/portal/${c.token}/meeting`, { when: "Tue 2pm" })).status, 200); ok("meeting noted");
  p = await anon("GET", "/api/portal/" + c.token);
  assert.equal(p.data.status, "in_progress"); ok("still 'in progress' while the contract is unsigned");

  // signing
  assert.equal((await anon("POST", `/api/portal/${c.token}/sign`, { name: "Grace Hopper", agree: false })).status, 400);
  assert.equal((await anon("POST", `/api/portal/${c.token}/sign`, { name: "G", agree: true })).status, 400); ok("signing needs a name and the tick box");
  mailer.outbox.length = 0;
  assert.equal((await anon("POST", `/api/portal/${c.token}/sign`, { name: "Grace Hopper", agree: true })).status, 200); await tick();
  assert.equal((await anon("POST", `/api/portal/${c.token}/sign`, { name: "Grace Hopper", agree: true })).status, 409); ok("can sign only once");
  p = await anon("GET", "/api/portal/" + c.token);
  assert.equal(p.data.status, "in_progress"); assert.equal(p.data.deposit.state, "requested"); assert.equal(p.data.links[0].title, "Logo pack"); ok("client sees the deposit request and shared link; not 'ready' until the deposit step is done");
  assert.ok(!JSON.stringify(p.data).includes(links[0].at)); // internal fields stay hidden
  assert.equal((await anon("POST", `/api/portal/${c.token}/paid`)).status, 200);
  assert.equal((await anon("POST", `/api/portal/${c.token}/paid`)).status, 200); await tick();
  p = await anon("GET", "/api/portal/" + c.token);
  assert.equal(p.data.status, "ready"); assert.ok(p.data.steps.every((s) => s.done)); assert.equal(p.data.deposit.state, "claimed"); ok("status becomes 'ready' when every step is done");
  assert.equal(mailTo("ada@x.com", "signed").length, 1); assert.equal(mailTo("ada@x.com", "finished onboarding").length, 1); assert.equal(mailTo("ada@x.com", "paid the deposit").length, 1); ok("freelancer emailed once each for signature, payment claim and completion");
  assert.equal((await A("POST", `/api/clients/${c.id}/deposit/received`)).data.deposit, "received");
  assert.equal((await A("PUT", `/api/clients/${c.id}/deposit`, { amount: 1 })).status, 409); ok("freelancer confirms receipt; a received deposit can't be changed");
  links = (await A("DELETE", `/api/clients/${c.id}/links/${links[0].id}`)).data;
  assert.equal(links.length, 0); ok("shared link can be removed");
  const detail = (await A("GET", "/api/clients/" + c.id)).data;
  const sig = detail.contract.signed;
  assert.equal(sig.name, "Grace Hopper"); assert.match(sig.hash, /^[0-9a-f]{64}$/); ok("signature record has name, time and SHA-256 of the text");
  assert.equal((await A("PUT", `/api/clients/${c.id}/contract`, { title: "Changed", body: "Different text entirely here." })).status, 409); ok("signed contract can't be edited");

  // --- freelancer view, files, isolation ---
  assert.equal(detail.intake.answers[qid], "A site <b>x</b>"); assert.equal(detail.files.length, 1); ok("freelancer sees answers and files");
  const dl = await A("GET", `/api/clients/${c.id}/files/${detail.files[0].id}`);
  assert.equal(dl.data, "hello brief"); assert.match(dl.headers.get("content-disposition"), /attachment/); ok("file download is an attachment");
  await bob("POST", "/api/auth/signup", { name: "Bob", email: "bob@x.com", password: "another-pass-1" });
  const bobVerify = mailTo("bob@x.com", "Confirm your email")[0].text.match(/token=([\w-]+)/)[1];
  assert.equal((await bob("GET", "/api/clients/" + c.id)).status, 404);
  assert.equal((await bob("GET", `/api/clients/${c.id}/files/${detail.files[0].id}`)).status, 404);
  assert.equal((await bob("GET", `/api/clients/${c.id}/messages`)).status, 404);
  assert.equal((await bob("PUT", `/api/clients/${c.id}/contract`, { title: "x", body: "hijacked contract text" })).status, 404);
  assert.equal((await bob("DELETE", "/api/clients/" + c.id)).status, 404); ok("another freelancer can't see, download, message, edit or delete Ada's client");
  assert.equal((await A("POST", "/api/clients", { name: "x" }, { headers: { origin: "https://evil.example" } })).status, 403); ok("cross-site write blocked");
  assert.equal((await anon("GET", "/../server.mjs")).status, 404);
  assert.equal((await anon("GET", "/%2e%2e/server.mjs")).status, 404);
  assert.equal((await anon("GET", "/%2e%2e%2fstore.mjs")).status, 404); ok("no path traversal to source");

  // --- messages ---
  mailer.outbox.length = 0;
  assert.equal((await anon("POST", `/api/portal/${c.token}/messages`, { text: "" })).status, 400);
  assert.equal((await anon("POST", `/api/portal/${c.token}/messages`, { text: "Hi Ada, quick question" })).status, 200);
  assert.equal((await anon("POST", `/api/portal/${c.token}/messages`, { text: "Second message" })).status, 200); await tick();
  assert.equal(mailTo("ada@x.com", "New message").length, 1); ok("client message works; freelancer emailed once (throttled)");
  let list = (await A("GET", "/api/clients")).data;
  assert.equal(list.find((x) => x.id === c.id).unread, 2); ok("unread count shown to freelancer");
  let thread = (await A("GET", `/api/clients/${c.id}/messages`)).data;
  assert.equal(thread.length, 2); assert.equal(thread[0].from, "client");
  list = (await A("GET", "/api/clients")).data;
  assert.equal(list.find((x) => x.id === c.id).unread, 0); ok("opening the thread marks it read");
  assert.equal((await A("POST", `/api/clients/${c.id}/messages`, { text: "Hi Grace, yes!" })).status, 200); await tick();
  assert.equal(mailTo("grace@x.com", "New message from Ada").length, 1);
  const cm = (await anon("GET", `/api/portal/${c.token}/messages`)).data;
  assert.equal(cm.length, 3); assert.equal(cm[2].from, "freelancer"); ok("freelancer reply reaches the client (page and email)");
  assert.equal((await A("POST", `/api/clients/${c.id}/messages`, { text: "x".repeat(5000) })).data.text.length, 2000); ok("messages are capped at 2000 characters");

  // --- data export ---
  const exp = await A("GET", "/api/account/export");
  assert.match(exp.headers.get("content-disposition"), /attachment/);
  const expText = JSON.stringify(exp.data);
  assert.ok(!expText.includes("scrypt") && !/"password"/.test(expText));
  const expJson = exp.data;
  assert.equal(expJson.clients.find((x) => x.id === c.id).messages.length, 4); ok("account export includes clients and messages, but not the password");

  // --- reminders job ---
  const c2 = (await A("POST", "/api/clients", { name: "Slow Client", email: "slow@x.com" })).data;
  await A("POST", `/api/clients/${c2.id}/invite`);
  const cron = (secret) => anon("POST", "/api/cron/reminders", undefined, { headers: secret ? { "x-cron-secret": secret } : {} });
  assert.equal((await cron()).status, 404); assert.equal((await cron("wrong")).status, 404); ok("reminders job needs the secret");
  mailer.outbox.length = 0;
  assert.equal((await cron("test-cron-secret-0123456789abcdef")).data.sent, 0); ok("no reminder for a client invited just now");
  const raw = (await store.allClients()).find((x) => x.id === c2.id);
  raw.invitedAt = Date.now() - 4 * 86400_000; await store.saveClient(raw);
  assert.equal((await cron("test-cron-secret-0123456789abcdef")).data.sent, 1); await tick();
  assert.equal(mailTo("slow@x.com", "Reminder").length, 1);
  assert.equal((await cron("test-cron-secret-0123456789abcdef")).data.sent, 0); ok("reminder sent after 3 days, then not again right away");
  assert.equal((await cron("test-cron-secret-0123456789abcdef")).data.sent, 0);

  // --- Bob: token kinds, then deleting an account ---
  assert.equal((await anon("POST", "/api/auth/reset", { token: bobVerify, password: "hijack-pass-1" })).status, 400);
  assert.equal((await anon("POST", "/api/auth/verify", { token: bobVerify })).status, 200); ok("a verification link can't be used to reset a password");
  assert.equal((await bob("DELETE", "/api/account", { password: "wrong-password" })).status, 403);
  const bobClient = (await bob("POST", "/api/clients", { name: "Bob's client", email: "bc@x.com" })).data;
  await bob("POST", `/api/clients/${bobClient.id}/links`, { title: "L", url: "https://x.example/l" });
  assert.equal((await bob("DELETE", "/api/account", { password: "another-pass-1" })).status, 200);
  assert.equal((await bob("GET", "/api/me")).status, 401);
  assert.equal((await anon("POST", "/api/auth/login", { email: "bob@x.com", password: "another-pass-1" })).status, 401);
  assert.equal((await anon("GET", "/api/portal/" + bobClient.token)).status, 404);
  assert.equal((await anon("POST", "/api/auth/signup", { name: "Bob Again", email: "bob@x.com", password: "another-pass-1" })).status, 200); ok("deleting an account needs the password and removes the account, clients and links; the email can sign up again");

  // --- status, notes, deletion ---
  assert.equal((await A("PATCH", "/api/clients/" + c.id, { status: "active", notes: "Great fit" })).data.status, "active"); ok("mark active + notes");
  assert.equal((await A("DELETE", "/api/clients/" + c.id)).status, 200);
  assert.equal((await anon("GET", "/api/portal/" + c.token)).status, 404);
  assert.equal(files._count?.() ?? 0, 0); ok("delete removes client, link, messages and files");
  if (table) {
    await A("DELETE", "/api/clients/" + c2.id); await A("DELETE", "/api/clients/" + noEmail.id);
    const left = [...(await table.scan(""))].filter((x) => x.pk.startsWith("T#") || x.pk.startsWith("M#") || x.sk.startsWith("C#"));
    assert.equal(left.length, 0); ok("DynamoDB layout: no orphaned token, message or client rows after deletes");
  }
  server.close();
}

await suite("Local JSON store", (dir) => ({ store: createLocalStore(dir), files: createLocalFiles(dir), limiter: createMemoryLimiter() }));
await suite("DynamoDB store logic (in-memory table)", (dir) => { const table = createMemoryTable(); return { table, store: createDynamoStore(table), files: createLocalFiles(dir), limiter: createTableLimiter(table) }; });

// ---- the path used on Amplify: web-standard handler, direct-to-S3 uploads, DynamoDB-backed limits ----
console.log("\nServerless path (web handler, fake S3, DynamoDB limiter)");
{
  const ok = (msg) => console.log(`  ✓ ${++total}. ${msg}`);
  const table = createMemoryTable();
  const objects = new Map(); // fake bucket
  const s3 = {
    async put(k, b) { objects.set(k, b.length); }, async get() { return null; }, async del(k) { objects.delete(k); },
    async size(k) { return objects.get(k) || 0; },
    async presignPut(k, size) { return { url: `https://bucket.s3.eu-west-2.amazonaws.com/${k}?sig=${size}`, headers: {} }; },
    async presignGet(k, name) { return `https://bucket.s3.eu-west-2.amazonaws.com/${k}?dl=${name}`; },
  };
  const config = loadConfig({ PORTAL_DATA: os.tmpdir(), TRUST_PROXY: "1", APP_URL: "https://clientword.example", CRON_SECRET: "x".repeat(30) });
  const mailer = createMailer(config);
  const handle = createHandler({ config, store: createDynamoStore(table), files: s3, mailer, limiter: createTableLimiter(table) });
  let cookie = "";
  const call = async (method, p, body, headers = {}) => {
    const r = await handle(new Request("https://clientword.example" + p, {
      method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data, headers: r.headers };
  };
  const ip = (a) => ({ "cloudfront-viewer-address": a + ":50000" });

  let r = await call("POST", "/api/auth/signup", { name: "Sam", email: "sam@example.com", password: "correct horse 9" }, ip("203.0.113.5"));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.ok(r.headers.get("x-content-type-options") === "nosniff"); ok("web handler: signup works and API responses carry security headers");
  const c = (await call("POST", "/api/clients", { name: "Zed", email: "zed@example.com" })).data;
  const token = (await call("GET", "/api/clients/" + c.id)).data.token;
  const P = "/api/portal/" + token;

  r = await call("POST", P + "/upload-url", { name: "brief.pdf", size: 1234 });
  assert.equal(r.data.mode, "direct"); assert.match(r.data.url, /^https:\/\/bucket\.s3\./); assert.match(r.data.stored, /^[0-9a-f]{32}$/);
  const stored = r.data.stored;
  r = await call("POST", P + "/upload-done", { stored, name: "brief.pdf" });
  assert.equal(r.status, 400); ok("claiming an upload that never reached S3 is refused");
  objects.set(`${c.id}/${stored}`, 1234); // the browser's PUT to S3
  r = await call("POST", P + "/upload-done", { stored, name: "../brief.pdf" });
  assert.equal(r.status, 200); assert.equal(r.data.size, 1234); assert.ok(!r.data.name.includes("/")); ok("direct upload registered with the size S3 reports");
  assert.equal((await call("POST", P + "/upload-done", { stored, name: "again" })).status, 409); ok("the same upload can't be added twice");
  assert.equal((await call("POST", P + "/upload-done", { stored: "../../etc/passwd", name: "x" })).status, 400); ok("upload keys are validated");
  assert.equal((await call("POST", P + "/upload-url", { name: "big", size: 26 * 1024 * 1024 })).status, 413); ok("26 MB upload refused before any link is issued");
  r = await call("POST", P + "/upload-url", { name: "sneaky", size: 100 });
  objects.set(`${c.id}/${r.data.stored}`, 30 * 1024 * 1024); // client lied about the size
  r = await call("POST", P + "/upload-done", { stored: r.data.stored, name: "sneaky" });
  assert.equal(r.status, 413); assert.equal([...objects.keys()].filter((k) => objects.get(k) > 26e6).length, 0); ok("an oversized object is rejected and deleted");

  const detail = (await call("GET", "/api/clients/" + c.id)).data;
  const dl = await handle(new Request(`https://clientword.example/api/clients/${c.id}/files/${detail.files[0].id}`, { headers: { cookie }, redirect: "manual" }));
  assert.equal(dl.status, 302); assert.match(dl.headers.get("location"), /dl=/); ok("downloads redirect to a short-lived S3 link");

  // rate limits are per real client address (from CloudFront) and live in the table
  let last;
  for (let i = 0; i < 11; i++) last = await call("POST", "/api/auth/login", { email: "sam@example.com", password: "wrong" }, ip("198.51.100.9"));
  assert.equal(last.status, 429);
  r = await call("POST", "/api/auth/login", { email: "sam@example.com", password: "wrong" }, ip("198.51.100.77"));
  assert.equal(r.status, 401); ok("login limit counts per CloudFront-reported address, stored in DynamoDB");
  assert.ok([...(await table.scan("W"))].length > 0); ok("limit counters are TTL'd rows in the table");

  // writes are accepted from the configured APP_URL even when the Host header is the internal one
  r = await call("PUT", "/api/settings", { welcome: "Hi" }, { origin: "https://clientword.example", host: "internal.amplify.local" });
  assert.equal(r.status, 200);
  r = await call("PUT", "/api/settings", { welcome: "Hi" }, { origin: "https://evil.example", host: "internal.amplify.local" });
  assert.equal(r.status, 403); ok("origin check accepts APP_URL, rejects other sites");
  assert.equal((await handle(new Request("https://clientword.example/anything"))).status, 404); ok("non-API paths are not handled by the API");
}

console.log("\nConfig checks");
assert.throws(() => checkProduction(loadConfig({ NODE_ENV: "production" })), /STORE must be 'dynamo'/);
assert.doesNotThrow(() => checkProduction(loadConfig({ NODE_ENV: "production", STORE: "dynamo", TABLE_NAME: "t", BUCKET: "b", APP_URL: "https://x.co.uk", MAIL: "ses", TRUST_PROXY: "1" })));
console.log(`  ✓ ${++total}. production refuses to start with unsafe settings`);

console.log(`\nAll ${total} checks passed`);
