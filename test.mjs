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
import { createMailer } from "./mail.mjs";

process.env.QUIET = "1";
let total = 0;

async function suite(name, make) {
  console.log(`\n${name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-"));
  const config = loadConfig({ PORTAL_DATA: dir, CRON_SECRET: "test-cron-secret-0123456789abcdef" });
  const { store, files, table } = make(dir);
  const mailer = createMailer(config);
  const server = createApp({ config, store, files, mailer });
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
  assert.equal((await anon("POST", `/api/portal/${c.token}/upload`, Buffer.alloc(11 * 1024 * 1024), { raw: true })).status, 413); ok("11 MB upload rejected");
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
  assert.equal(p.data.status, "ready"); assert.ok(p.data.steps.every((s) => s.done)); ok("status becomes 'ready' when every step is done");
  assert.equal(mailTo("ada@x.com", "signed").length, 1); assert.equal(mailTo("ada@x.com", "finished onboarding").length, 1); ok("freelancer emailed once for signature and once for completion");
  const detail = (await A("GET", "/api/clients/" + c.id)).data;
  const sig = detail.contract.signed;
  assert.equal(sig.name, "Grace Hopper"); assert.match(sig.hash, /^[0-9a-f]{64}$/); ok("signature record has name, time and SHA-256 of the text");
  assert.equal((await A("PUT", `/api/clients/${c.id}/contract`, { title: "Changed", body: "Different text entirely here." })).status, 409); ok("signed contract can't be edited");

  // --- freelancer view, files, isolation ---
  assert.equal(detail.intake.answers[qid], "A site <b>x</b>"); assert.equal(detail.files.length, 1); ok("freelancer sees answers and files");
  const dl = await A("GET", `/api/clients/${c.id}/files/${detail.files[0].id}`);
  assert.equal(dl.data, "hello brief"); assert.match(dl.headers.get("content-disposition"), /attachment/); ok("file download is an attachment");
  await bob("POST", "/api/auth/signup", { name: "Bob", email: "bob@x.com", password: "another-pass-1" });
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

await suite("Local JSON store", (dir) => ({ store: createLocalStore(dir), files: createLocalFiles(dir) }));
await suite("DynamoDB store logic (in-memory table)", (dir) => { const table = createMemoryTable(); return { table, store: createDynamoStore(table), files: createLocalFiles(dir) }; });

console.log("\nConfig checks");
assert.throws(() => checkProduction(loadConfig({ NODE_ENV: "production" })), /STORE must be 'dynamo'/);
assert.doesNotThrow(() => checkProduction(loadConfig({ NODE_ENV: "production", STORE: "dynamo", TABLE_NAME: "t", BUCKET: "b", APP_URL: "https://x.co.uk", MAIL: "ses", TRUST_PROXY: "1" })));
console.log(`  ✓ ${++total}. production refuses to start with unsafe settings`);

console.log(`\nAll ${total} checks passed`);
