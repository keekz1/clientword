import { el, api, size, inkFor, toast, ago, dateTime, money } from "/ui.js";
import { openSigner, pdfToWord, fetchBytes, saveFile } from "/pdfdoc.js";

const root = document.getElementById("root");
const tok = location.pathname.split("/")[2];
const base = "/api/portal/" + tok;
let data;
let draftMsg = ""; // keep half-typed text when the page refreshes itself
let refreshThread = null;

async function load() {
  try { data = await api(base); }
  catch (e) {
    root.replaceChildren(el("div", { class: "portal-body", style: "margin-top:80px" }, el("div", { class: "card finish" }, el("h2", {}, "Link not found"), el("p", { class: "muted" }, e.message))));
    return;
  }
  render();
}

function render() {
  const { brand, client, steps } = data;
  document.title = `${brand.business} · Welcome`;
  document.documentElement.style.setProperty("--brand", brand.colour);
  document.documentElement.style.setProperty("--brand-ink", inkFor(brand.colour));

  const done = steps.filter((s) => s.done).length;
  const all = steps.length && done === steps.length;
  const builders = { intake: intakeStep, contract: contractStep, document: documentStep, deposit: depositStep, files: filesStep, meeting: meetingStep };
  const sections = steps.map((s, i) => builders[s.key](s, i + 1));

  root.replaceChildren(
    el("header", { class: "portal-top" }, el("div", { class: "in" },
      el("div", { class: "biz" }, brand.business),
      el("h1", {}, `Welcome, ${client.name.split(" ")[0]}`),
      brand.welcome ? el("div", { style: "opacity:.92" }, brand.welcome) : null)),
    el("main", { class: "portal-body" },
      steps.length ? el("div", { class: "progress", role: "img", "aria-label": `${done} of ${steps.length} steps done` }, steps.map((s) => el("div", { class: s.done ? "done" : "" }))) : null,
      all ? el("div", { class: "card finish step" }, el("div", { class: "big" }, "🎉"), el("h2", {}, "You're all set"), el("p", { class: "muted", style: "margin:0" }, `${brand.name} has everything needed and will be in touch. You can come back to this page any time to add more.`)) : null,
      !steps.length ? el("div", { class: "card finish" }, el("p", { style: "margin:0" }, `Nothing to do here yet. ${brand.name} will be in touch.`)) : null,
      sections,
      linksBox(),
      messagesBox(),
      el("p", { class: "powered" }, "This page is private to you. Please don't share the link. ", el("a", { href: "/privacy" }, "Privacy"))));
}

function stepShell(s, n, body) {
  return el("section", { class: "card step" + (s.done ? " done" : "") },
    el("header", {}, el("span", { class: "num" }, s.done ? "✓" : n), el("h2", {}, s.label)), body);
}

// ----- intake form -----
function intakeStep(s, n) {
  const { questions } = data.brand;
  const saved = data.intake?.answers || {};
  const err = el("div", { class: "err", role: "alert" });
  const inputs = {};
  const fields = questions.map((q) => {
    const id = "q-" + q.id;
    let input;
    if (q.type === "long") input = el("textarea", { id });
    else if (q.type === "choice") input = el("select", { id }, el("option", { value: "" }, "Choose…"), ...q.options.map((o) => el("option", { value: o }, o)));
    else input = el("input", { type: "text", id });
    input.value = saved[q.id] || "";
    inputs[q.id] = input;
    return el("div", {}, el("label", { for: id }, q.label, q.required ? el("span", { "aria-hidden": "true" }, " *") : null), input);
  });
  const btn = el("button", { class: "btn", type: "submit" }, s.done ? "Update answers" : "Save answers");
  const form = el("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true;
    const answers = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
    try { await api(base + "/intake", { method: "POST", body: { answers } }); await load(); toast("Saved"); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  } }, fields, err, btn);
  return stepShell(s, n, form);
}

// ----- PDF document: fill in, sign, download, or convert to Word -----
function documentStep(s, n) {
  const d = data.document, err = el("div", { class: "err", role: "alert" });
  const run = (btn, label, fn) => async () => {
    err.textContent = ""; btn.disabled = true; const old = btn.textContent; btn.textContent = label;
    try { await fn(); } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; btn.textContent = old; }
  };
  const word = el("button", { class: "btn ghost sm", type: "button" }, "Download as Word");
  word.onclick = run(word, "Converting…", async () => {
    const blob = await pdfToWord(await fetchBytes(base + "/document-file"), d.name);
    saveFile(blob, d.name.replace(/\.pdf$/i, "") + ".docx");
  });
  if (d.signed) {
    const dl = el("a", { class: "btn ghost sm", href: base + "/document-signed" }, "Download signed PDF");
    return stepShell(s, n, el("div", { class: "stack" },
      el("strong", {}, d.name),
      el("p", { class: "ok-text", style: "margin:0" }, `✓ Signed by ${d.signed.name} on ${dateTime(d.signed.at)}`),
      el("div", { class: "doc-actions" }, dl, word), err));
  }
  const open = el("button", { class: "btn", type: "button" }, "Open and sign");
  open.onclick = run(open, "Opening…", async () => {
    const bytes = await fetchBytes(base + "/document-file");
    await openSigner({ bytes, filename: d.name, defaultName: data.client.name, onComplete: async ({ bytes: out, name, agree }) => {
      const t = await api(base + "/document-upload-url", { method: "POST", body: { size: out.length } });
      let stored;
      const blob = new Blob([out], { type: "application/pdf" });
      if (t.mode === "direct") {
        let put; try { put = await fetch(t.url, { method: "PUT", body: blob, headers: t.headers || {} }); } catch { throw new Error("The upload didn't complete. Check your connection and try again."); }
        if (!put.ok) throw new Error("The upload didn't complete. Please try again.");
        stored = t.stored;
      } else stored = (await api(base + "/document-upload", { method: "POST", body: blob })).stored;
      await api(base + "/document-sign", { method: "POST", body: { stored, name, agree } });
      load();
    } });
  });
  return stepShell(s, n, el("div", { class: "stack" },
    el("strong", {}, d.name),
    el("p", { class: "hint", style: "margin:0" }, "Open the document, fill in anything that's needed (text, date, ticks), add your signature, then press Finish. It works on phones too."),
    el("div", { class: "doc-actions" }, open, el("a", { class: "btn ghost sm", href: base + "/document-file" }, "Download PDF"), word), err));
}

// ----- contract -----
function contractStep(s, n) {
  const k = data.contract;
  if (k.signed) {
    return stepShell(s, n, el("div", { class: "stack" },
      el("strong", {}, k.title),
      el("div", { class: "sign-text" }, k.body),
      el("p", { class: "ok-text", style: "margin:0" }, `✓ Signed by ${k.signed.name} on ${dateTime(k.signed.at)}`),
      el("a", { href: base + "/contract-copy", target: "_blank", rel: "noopener", class: "small" }, "Open a printable copy of the signed agreement")));
  }
  const err = el("div", { class: "err", role: "alert" });
  const name = el("input", { type: "text", id: "sig", class: "sig-input", autocomplete: "name", placeholder: "Type your full name" });
  const agree = el("input", { type: "checkbox", id: "agree" });
  const btn = el("button", { class: "btn", type: "submit" }, "Sign agreement");
  return stepShell(s, n, el("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true;
    try { await api(base + "/sign", { method: "POST", body: { name: name.value, agree: agree.checked } }); await load(); toast("Signed. Thank you"); }
    catch (x) { err.textContent = x.message; btn.disabled = false; }
  } },
    el("strong", {}, k.title),
    el("div", { class: "sign-text", tabIndex: 0, role: "region", "aria-label": "Contract text" }, k.body),
    el("label", { class: "check", for: "agree" }, agree, "I have read this agreement and I agree to it."),
    el("div", {}, el("label", { for: "sig" }, "Type your full name as your signature"), name),
    err, btn));
}

// ----- deposit -----
function depositStep(s, n) {
  const d = data.deposit;
  const err = el("div", { class: "err", role: "alert" });
  const body = el("div", { class: "stack" },
    el("div", { class: "deposit-box" }, el("div", { class: "hint" }, "Deposit"), el("div", { class: "amt" }, money(d.amountPence, d.currency)),
      d.note ? el("pre", {}, d.note) : null),
    d.url ? el("a", { class: "btn" + (s.done ? " ghost" : ""), href: d.url, target: "_blank", rel: "noopener noreferrer" }, "Open payment link ↗") : null);
  if (d.state === "received") body.append(el("p", { class: "ok-text", style: "margin:0" }, "✓ Payment received. Thank you."));
  else if (d.state === "claimed") body.append(el("p", { class: "ok-text", style: "margin:0" }, `✓ Thanks. ${data.brand.name.split(" ")[0]} will confirm once it arrives.`));
  else body.append(el("p", { class: "hint", style: "margin:0" }, "Pay using the details above, then tell us here."), err,
    el("button", { class: "btn ghost", onclick: async (e) => { e.currentTarget.disabled = true; try { await api(base + "/paid", { method: "POST" }); await load(); toast("Thanks, noted"); } catch (x) { err.textContent = x.message; e.currentTarget.disabled = false; } } }, "I've paid"));
  return stepShell(s, n, body);
}

// ----- links shared by the freelancer -----
function linksBox() {
  if (!data.links.length) return null;
  return el("section", { class: "card step" }, el("header", {}, el("h2", {}, "Shared with you")),
    el("ul", { class: "files" }, data.links.map((l) => el("li", {}, el("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.title), el("span", { class: "muted" }, "↗")))));
}

// ----- files -----
function filesStep(s, n) {
  const err = el("div", { class: "err", role: "alert" });
  const picker = el("input", { type: "file", multiple: true, class: "sr", id: "picker", onchange: () => upload([...picker.files]) });
  const drop = el("label", { class: "drop", for: "picker", style: "display:block;font-weight:500",
    ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files]); } },
    "Drop files here or click to choose", el("div", { class: "small" }, "Up to 25 MB each"));

  // On AWS the browser sends the file straight to S3 (so big files never pass through the app);
  // without S3 (local development) it posts the bytes to the server instead.
  async function sendFile(file) {
    const t = await api(base + "/upload-url", { method: "POST", body: { name: file.name, size: file.size } });
    if (t.mode !== "direct") return api(base + "/upload", { method: "POST", body: file, headers: { "x-filename": encodeURIComponent(file.name) } });
    let put;
    try { put = await fetch(t.url, { method: "PUT", body: file, headers: t.headers || {} }); }
    catch { throw new Error("The upload didn't complete. Check your connection and try again."); }
    if (!put.ok) throw new Error("The upload didn't complete. Please try again.");
    return api(base + "/upload-done", { method: "POST", body: { stored: t.stored, name: file.name } });
  }

  async function upload(files) {
    err.textContent = "";
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) { err.textContent = `${file.name} is over 25 MB.`; continue; }
      drop.firstChild.textContent = `Uploading ${file.name}…`;
      try { await sendFile(file); }
      catch (x) { err.textContent = `${file.name}: ${x.message}`; }
    }
    await load();
  }
  const list = data.files.length ? el("ul", { class: "files" }, data.files.map((f) => el("li", {}, el("span", {}, f.name), el("span", { class: "muted" }, size(f.size))))) : null;
  const skip = !s.done ? el("button", { class: "btn ghost sm", type: "button", style: "margin-top:12px", onclick: async () => { await api(base + "/skipfiles", { method: "POST" }); load(); } }, "I have nothing to share right now") : null;
  return stepShell(s, n, el("div", {}, picker, drop, err, list, skip));
}

// ----- meeting -----
function meetingStep(s, n) {
  const { brand } = data;
  const err = el("div", { class: "err", role: "alert" });
  const when = el("input", { type: "text", id: "when", placeholder: "e.g. Tuesday 4 Nov, 2:30pm", value: data.meeting?.when || "" });
  const form = el("form", { class: "stack", novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    try { await api(base + "/meeting", { method: "POST", body: { when: when.value } }); await load(); toast("Thanks, noted"); }
    catch (x) { err.textContent = x.message; }
  } },
    el("div", {}, el("label", { for: "when" }, s.done ? "Your booking" : "Once you've booked, tell us when"), when), err,
    el("button", { class: "btn" + (s.done ? " ghost" : ""), type: "submit" }, s.done ? "Update" : "I've booked"));
  return stepShell(s, n, el("div", { class: "stack" },
    brand.meetingNote ? el("p", { style: "margin:0" }, brand.meetingNote) : null,
    el("a", { class: "btn", href: brand.meetingUrl, target: "_blank", rel: "noopener noreferrer" }, "Open booking page ↗"),
    form));
}

// ----- messages -----
function messagesBox() {
  const thread = el("div", { class: "thread", "aria-live": "polite" });
  const input = el("textarea", { placeholder: `Message ${data.brand.name.split(" ")[0]}…`, "aria-label": "Message", maxLength: 2000, rows: 1, oninput: (e) => (draftMsg = e.target.value) });
  input.value = draftMsg;
  const send = el("button", { class: "btn", type: "button" }, "Send");
  const paint = (msgs) => {
    thread.replaceChildren(...(msgs.length ? msgs.map((m) => el("div", { class: "bubble " + (m.from === "client" ? "me" : "them") }, m.text, el("small", {}, ago(m.at)))) : [el("p", { class: "muted small", style: "margin:0" }, "Questions? Send a message here.")]));
    thread.scrollTop = thread.scrollHeight;
  };
  const refresh = () => api(base + "/messages").then(paint).catch(() => {});
  send.onclick = async () => {
    const text = input.value.trim(); if (!text) return;
    send.disabled = true;
    try { await api(base + "/messages", { method: "POST", body: { text } }); input.value = ""; draftMsg = ""; await refresh(); }
    catch (x) { toast(x.message); }
    send.disabled = false;
  };
  refreshThread = refresh;
  refresh();
  return el("section", { class: "card step" }, el("header", {}, el("h2", {}, "Messages")), thread, el("div", { class: "msgbox" }, input, send));
}

// Pull in new messages when the client returns to the tab (only the thread, so typed answers are never reset)
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && refreshThread) refreshThread(); });

load();
