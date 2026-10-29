import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

process.env.PORTAL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "portal-"));
const { server } = await import("./server.mjs");
await new Promise((r) => server.listen(0, r));
const base = "http://localhost:" + server.address().port;

let cookie = "";
async function call(method, p, body, { raw, headers } = {}) {
  const res = await fetch(base + p, {
    method, redirect: "manual",
    headers: { ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
let n = 0;
const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);

// auth
assert.equal((await call("GET", "/api/clients")).status, 401); ok("clients need login");
assert.equal((await call("POST", "/api/auth/signup", { name: "A", email: "bad", password: "12345678" })).status, 400); ok("bad email rejected");
assert.equal((await call("POST", "/api/auth/signup", { name: "A", email: "a@x.com", password: "short" })).status, 400); ok("short password rejected");
let r = await call("POST", "/api/auth/signup", { name: "Ada Lovelace", business: "Ada Design", email: "ada@x.com", password: "correct-horse" });
assert.equal(r.status, 200); assert.match(r.headers.get("set-cookie"), /HttpOnly/); ok("signup sets HttpOnly cookie");
const adaCookie = cookie;
assert.equal((await call("POST", "/api/auth/signup", { name: "A", email: "ADA@x.com", password: "correct-horse" })).status, 409); ok("duplicate email (case-insensitive) rejected");
cookie = "";
assert.equal((await call("POST", "/api/auth/login", { email: "ada@x.com", password: "wrong-pass-1" })).status, 401); ok("wrong password rejected");
assert.equal((await call("POST", "/api/auth/login", { email: "nobody@x.com", password: "wrong-pass-1" })).data.error, "Email or password is incorrect."); ok("same message for unknown email");
assert.equal((await call("POST", "/api/auth/login", { email: "ada@x.com", password: "correct-horse" })).status, 200); ok("login works");

// settings
r = await call("PUT", "/api/settings", { colour: "#0f766e", welcome: "Hi!", meetingUrl: "javascript:alert(1)", askForFiles: true, questions: [] });
assert.equal(r.status, 400); ok("javascript: meeting link rejected");
r = await call("PUT", "/api/settings", { colour: "red", welcome: "Hi!", meetingUrl: "https://cal.com/ada", meetingNote: "Book", askForFiles: true,
  questions: [{ label: "Goal?", type: "long", required: true }, { label: "Size", type: "choice", options: ["S", "M"] }, { label: "", type: "text" }] });
assert.equal(r.status, 200);
let me = (await call("GET", "/api/me")).data;
assert.equal(me.colour, "#4f46e5"); assert.equal(me.questions.length, 2); assert.equal(me.meetingUrl, "https://cal.com/ada"); ok("settings saved; invalid colour ignored; empty question dropped");

// clients
assert.equal((await call("POST", "/api/clients", { name: "" })).status, 400); ok("client name required");
const c = (await call("POST", "/api/clients", { name: "Grace Hopper", email: "grace@x.com", project: "Website" })).data;
assert.ok(c.token.length >= 30); assert.equal(c.status, "invited"); assert.equal(c.steps.length, 3); ok("client created with secret token and 3 steps");

// client portal (no cookie)
const adaSession = cookie; cookie = "";
let p = await call("GET", "/api/portal/" + c.token);
assert.equal(p.status, 200); assert.equal(p.data.brand.business, "Ada Design");
assert.ok(!("email" in p.data.brand) && !JSON.stringify(p.data).includes("ada@x.com")); ok("portal works without login and doesn't leak freelancer email");
assert.equal((await call("GET", "/api/portal/" + "x".repeat(32))).status, 404); ok("unknown token → 404");
const qid = p.data.brand.questions[0].id, sid = p.data.brand.questions[1].id;
assert.equal((await call("POST", `/api/portal/${c.token}/intake`, { answers: {} })).status, 400); ok("required question enforced");
assert.equal((await call("POST", `/api/portal/${c.token}/intake`, { answers: { [qid]: "A site", [sid]: "XL" } })).status, 400); ok("invalid choice rejected");
assert.equal((await call("POST", `/api/portal/${c.token}/intake`, { answers: { [qid]: "A site <b>x</b>", [sid]: "M" } })).status, 200); ok("intake saved");
r = await call("POST", `/api/portal/${c.token}/upload`, Buffer.from("hello brief"), { raw: true, headers: { "x-filename": encodeURIComponent("../../etc/brief.txt") } });
assert.equal(r.status, 200); assert.ok(!r.data.name.includes("/")); ok("upload works; path separators stripped from name");
assert.equal((await call("POST", `/api/portal/${c.token}/upload`, Buffer.alloc(11 * 1024 * 1024), { raw: true })).status, 413); ok("11 MB upload rejected");
assert.equal((await call("POST", `/api/portal/${c.token}/meeting`, { when: "" })).status, 400); ok("meeting needs a time");
assert.equal((await call("POST", `/api/portal/${c.token}/meeting`, { when: "Tue 2pm" })).status, 200); ok("meeting noted");
p = await call("GET", "/api/portal/" + c.token);
assert.equal(p.data.status, "ready"); assert.ok(p.data.steps.every((s) => s.done)); ok("status becomes 'ready' when all steps done");

// freelancer view + isolation
cookie = adaSession;
const detail = (await call("GET", "/api/clients/" + c.id)).data;
assert.equal(detail.intake.answers[qid], "A site <b>x</b>"); assert.equal(detail.files.length, 1); ok("freelancer sees answers and files");
const dl = await call("GET", `/api/clients/${c.id}/files/${detail.files[0].id}`);
assert.equal(dl.data, "hello brief"); assert.match(dl.headers.get("content-disposition"), /attachment/); ok("file download is an attachment");
await call("POST", "/api/auth/signup", { name: "Bob", email: "bob@x.com", password: "another-pass-1" });
assert.equal((await call("GET", "/api/clients/" + c.id)).status, 404);
assert.equal((await call("GET", `/api/clients/${c.id}/files/${detail.files[0].id}`)).status, 404);
assert.equal((await call("DELETE", "/api/clients/" + c.id)).status, 404); ok("another freelancer can't see, download or delete Ada's client");
assert.equal((await call("POST", "/api/clients", { name: "x" }, { headers: { origin: "https://evil.example" } })).status, 403); ok("cross-site write blocked");
assert.equal((await call("GET", "/../server.mjs")).status, 404);
assert.equal((await call("GET", "/%2e%2e/server.mjs")).status, 404); ok("no path traversal to source");

cookie = adaSession;
assert.equal((await call("PATCH", "/api/clients/" + c.id, { status: "active", notes: "Great fit" })).data.status, "active"); ok("mark active + notes");
assert.equal((await call("DELETE", "/api/clients/" + c.id)).status, 200);
assert.equal((await call("GET", "/api/portal/" + c.token)).status, 404);
assert.equal(fs.readdirSync(path.join(process.env.PORTAL_DATA, "uploads")).length, 0); ok("delete removes client, link and files from disk");

console.log(`\nAll ${n} checks passed`);
server.close();
