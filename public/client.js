import { el, api, size, inkFor, toast } from "/ui.js";

const root = document.getElementById("root");
const tok = location.pathname.split("/")[2];
const base = "/api/portal/" + tok;
let data;

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
  const sections = steps.map((s, i) => ({ intake: intakeStep, files: filesStep, meeting: meetingStep })[s.key](s, i + 1));

  root.replaceChildren(
    el("header", { class: "portal-top" }, el("div", { class: "in" },
      el("div", { class: "biz" }, brand.business),
      el("h1", {}, `Welcome, ${client.name.split(" ")[0]}`),
      brand.welcome ? el("div", { style: "opacity:.92" }, brand.welcome) : null)),
    el("main", { class: "portal-body" },
      steps.length ? el("div", { class: "progress", role: "img", "aria-label": `${done} of ${steps.length} steps done` }, steps.map((s) => el("div", { class: s.done ? "done" : "" }))) : null,
      all ? el("div", { class: "card finish step" }, el("div", { class: "big" }, "🎉"), el("h2", {}, "You're all set"), el("p", { class: "muted", style: "margin:0" }, `${brand.name} has everything needed and will be in touch. You can come back to this page any time to add more.`)) : null,
      !steps.length ? el("div", { class: "card finish" }, el("p", { style: "margin:0" }, `Nothing to do here yet. ${brand.name} will be in touch.`)) : null,
      sections));
}

function stepShell(s, n, body) {
  return el("section", { class: "card step" + (s.done ? " done" : "") },
    el("header", {}, el("span", { class: "num" }, s.done ? "✓" : n), el("h2", {}, s.label)), body);
}

// ----- 1. intake form -----
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

// ----- 2. files -----
function filesStep(s, n) {
  const err = el("div", { class: "err", role: "alert" });
  const picker = el("input", { type: "file", multiple: true, class: "sr", id: "picker", onchange: () => upload([...picker.files]) });
  const drop = el("label", { class: "drop", for: "picker", style: "display:block;font-weight:500",
    ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files]); } },
    "Drop files here or click to choose", el("div", { class: "small" }, "Up to 10 MB each"));

  async function upload(files) {
    err.textContent = "";
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) { err.textContent = `${file.name} is over 10 MB.`; continue; }
      drop.firstChild.textContent = `Uploading ${file.name}…`;
      try { await api(base + "/upload", { method: "POST", body: file, headers: { "x-filename": encodeURIComponent(file.name) } }); }
      catch (x) { err.textContent = `${file.name}: ${x.message}`; }
    }
    await load();
  }
  const list = data.files.length ? el("ul", { class: "files" }, data.files.map((f) => el("li", {}, el("span", {}, f.name), el("span", { class: "muted" }, size(f.size))))) : null;
  const skip = !s.done ? el("button", { class: "btn ghost sm", type: "button", style: "margin-top:12px", onclick: async () => { await api(base + "/skipfiles", { method: "POST" }); load(); } }, "I have nothing to share right now") : null;
  return stepShell(s, n, el("div", {}, picker, drop, err, list, skip));
}

// ----- 3. meeting -----
function meetingStep(s, n) {
  const { brand } = data;
  const err = el("div", { class: "err", role: "alert" });
  const when = el("input", { type: "text", id: "when", placeholder: "e.g. Tuesday 4 Nov, 2:30pm", value: data.meeting?.when || "", "aria-label": "When did you book?" });
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

load();
