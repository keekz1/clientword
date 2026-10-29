import { el, api, toast, when, size, STATUS, inkFor } from "/ui.js";

const root = document.getElementById("root");
let me = null;
let view = { name: "clients" };

async function boot() {
  try { me = await api("/api/me"); }
  catch { location.href = "/"; return; }
  go({ name: "clients" });
}

function go(v) { view = v; render(); }

function shell(content) {
  root.replaceChildren(
    el("nav", { class: "side", "aria-label": "Main" },
      el("div", { class: "logo" }, "Client", el("span", {}, "word")),
      navBtn("Clients", "clients"),
      navBtn("Setup", "setup"),
      el("div", { class: "who muted" }, me.email, el("br"),
        el("a", { href: "#", onclick: async (e) => { e.preventDefault(); await api("/api/auth/logout", { method: "POST" }); location.href = "/"; } }, "Log out"))),
    el("main", { class: "main" }, content));
}
const navBtn = (label, name) =>
  el("button", { class: "nav", "aria-current": view.name === name || (name === "clients" && view.name === "client") ? "page" : false, onclick: () => go({ name }) }, label);

function render() {
  if (view.name === "clients") return clientsView();
  if (view.name === "client") return clientView(view.id);
  return setupView();
}

// ---------- clients list ----------
async function clientsView() {
  shell(el("p", { class: "muted" }, "Loading…"));
  const list = await api("/api/clients");
  const body = list.length
    ? el("div", { class: "card", style: "padding:6px 8px;overflow-x:auto" },
        el("table", {},
          el("thead", {}, el("tr", {}, el("th", {}, "Client"), el("th", { class: "hide-sm" }, "Project"), el("th", {}, "Progress"), el("th", {}, "Status"), el("th", { class: "hide-sm" }, "Added"))),
          el("tbody", {}, list.map((c) =>
            el("tr", { class: "click", tabIndex: 0, onclick: () => go({ name: "client", id: c.id }), onkeydown: (e) => e.key === "Enter" && go({ name: "client", id: c.id }) },
              el("td", {}, el("strong", {}, c.name), c.email ? el("div", { class: "muted small" }, c.email) : null),
              el("td", { class: "hide-sm" }, c.project || "—"),
              el("td", {}, el("div", { class: "dots", title: c.steps.filter((s) => s.done).length + " of " + c.steps.length + " steps done" }, c.steps.map((s) => el("i", { class: s.done ? "on" : "" })))),
              el("td", {}, el("span", { class: "chip " + c.status }, STATUS[c.status])),
              el("td", { class: "hide-sm muted" }, when(c.created)))))))
    : el("div", { class: "card empty" },
        el("h2", {}, "No clients yet"),
        el("p", {}, "Add your first client and send them their personal onboarding link."),
        el("button", { class: "btn", onclick: addClientModal }, "Add a client"));
  shell([el("div", { class: "head" }, el("h1", {}, "Clients"), el("button", { class: "btn", onclick: addClientModal }, "+ Add client")), body]);
}

function addClientModal() {
  const err = el("div", { class: "err", role: "alert" });
  const name = el("input", { type: "text", id: "cn", autocomplete: "off" });
  const email = el("input", { type: "email", id: "ce", autocomplete: "off" });
  const project = el("input", { type: "text", id: "cp", autocomplete: "off" });
  const close = () => bg.remove();
  const bg = el("div", { class: "modal-bg", onclick: (e) => e.target === bg && close() },
    el("form", { class: "card modal stack", onsubmit: async (e) => {
      e.preventDefault();
      try {
        const c = await api("/api/clients", { method: "POST", body: { name: name.value, email: email.value, project: project.value } });
        close(); go({ name: "client", id: c.id });
      } catch (x) { err.textContent = x.message; }
    } },
      el("h2", {}, "Add a client"),
      el("div", {}, el("label", { for: "cn" }, "Client name"), name),
      el("div", {}, el("label", { for: "ce" }, "Email ", el("span", { class: "muted" }, "(optional)")), email),
      el("div", {}, el("label", { for: "cp" }, "Project ", el("span", { class: "muted" }, "(optional)")), project),
      err,
      el("div", { class: "row" }, el("button", { class: "btn", type: "submit" }, "Create link"), el("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
  document.body.append(bg);
  name.focus();
}

// ---------- one client ----------
async function clientView(id) {
  shell(el("p", { class: "muted" }, "Loading…"));
  let c;
  try { c = await api("/api/clients/" + id); } catch { return go({ name: "clients" }); }
  const link = location.origin + "/c/" + c.token;
  const linkInput = el("input", { type: "text", readOnly: true, value: link, "aria-label": "Client link" });
  const notes = el("textarea", { "aria-label": "Private notes", placeholder: "Private notes (your client never sees these)" });
  notes.value = c.notes || "";

  const answers = c.intake
    ? el("dl", { class: "qa" }, c.questions.flatMap((q) => [el("dt", {}, q.label), el("dd", {}, c.intake.answers[q.id] || "—")]))
    : el("p", { class: "muted" }, "Not filled in yet.");
  const files = c.files.length
    ? el("ul", { class: "files" }, c.files.map((f) => el("li", {}, el("a", { href: `/api/clients/${c.id}/files/${f.id}` }, f.name), el("span", { class: "muted" }, size(f.size)))))
    : el("p", { class: "muted" }, "No files yet.");
  const meeting = c.meeting ? el("p", {}, "Booked: ", el("strong", {}, c.meeting.when)) : el("p", { class: "muted" }, "Not booked yet.");

  const setStatus = async (status) => { await api("/api/clients/" + c.id, { method: "PATCH", body: { status } }); toast("Updated"); clientView(id); };

  shell([
    el("button", { class: "back", onclick: () => go({ name: "clients" }) }, "← All clients"),
    el("div", { class: "head" },
      el("div", {}, el("h1", {}, c.name), el("div", { class: "muted" }, [c.project, c.email].filter(Boolean).join(" · ") || "No project details")),
      el("span", { class: "chip " + c.status }, STATUS[c.status])),
    el("div", { class: "card stack" },
      el("h3", {}, "Client link"),
      el("p", { class: "muted small", style: "margin:0" }, c.opened ? "They have opened it." : "Not opened yet. Send them this link; anyone with it can fill in their page, so share it privately."),
      el("div", { class: "linkbox" }, linkInput,
        el("button", { class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(link); } catch { linkInput.select(); document.execCommand("copy"); } toast("Link copied"); } }, "Copy"),
        el("a", { class: "btn ghost", href: link, target: "_blank", rel: "noopener" }, "Preview"))),
    el("div", { class: "card", style: "margin-top:16px" }, el("h3", {}, "Their answers"), answers),
    el("div", { class: "card", style: "margin-top:16px" }, el("h3", {}, "Files"), files),
    el("div", { class: "card", style: "margin-top:16px" }, el("h3", {}, "Call"), meeting),
    el("div", { class: "card stack", style: "margin-top:16px" }, el("h3", {}, "Notes"), notes,
      el("button", { class: "btn sm", style: "align-self:flex-start", onclick: async () => { await api("/api/clients/" + c.id, { method: "PATCH", body: { notes: notes.value } }); toast("Notes saved"); } }, "Save notes")),
    el("div", { class: "row", style: "margin-top:16px" },
      c.status !== "active" ? el("button", { class: "btn", onclick: () => setStatus("active") }, "Mark as active client") : el("button", { class: "btn ghost", onclick: () => setStatus("") }, "Move back to onboarding"),
      c.status !== "archived" ? el("button", { class: "btn ghost", onclick: () => setStatus("archived") }, "Archive") : null,
      el("button", { class: "btn danger", onclick: async () => { if (confirm("Delete this client and their files? This can't be undone.")) { await api("/api/clients/" + c.id, { method: "DELETE" }); go({ name: "clients" }); } } }, "Delete")),
  ]);
}

// ---------- setup ----------
function setupView() {
  const q = structuredClone(me.questions);
  const err = el("div", { class: "err", role: "alert" });
  const f = {
    name: el("input", { type: "text", id: "s-name", value: me.name }),
    business: el("input", { type: "text", id: "s-biz", value: me.business }),
    colour: el("input", { type: "color", id: "s-col", value: me.colour }),
    welcome: el("textarea", { id: "s-wel" }),
    meetingUrl: el("input", { type: "url", id: "s-url", placeholder: "https://calendly.com/you  or  https://cal.com/you", value: me.meetingUrl }),
    meetingNote: el("input", { type: "text", id: "s-mnote", value: me.meetingNote }),
    askForFiles: el("input", { type: "checkbox", id: "s-files", checked: me.askForFiles }),
  };
  f.welcome.value = me.welcome;

  const preview = el("div", { class: "card", style: "padding:0;overflow:hidden" });
  const paintPreview = () => {
    const col = f.colour.value;
    preview.replaceChildren(el("div", { style: `background:${col};color:${inkFor(col)};padding:18px 20px` },
      el("div", { style: "font-weight:700;opacity:.9;font-size:.9rem" }, f.business.value || "Your business"),
      el("div", { style: "font-size:1.2rem;font-weight:700;margin-top:4px" }, "Welcome, Jordan"),
      el("div", { style: "opacity:.9;font-size:.9rem;margin-top:2px" }, f.welcome.value || "")));
  };
  [f.colour, f.business, f.welcome].forEach((n) => n.addEventListener("input", paintPreview));
  paintPreview();

  const qList = el("div");
  const paintQ = () => qList.replaceChildren(...q.map((item, i) => {
    const opts = el("input", { type: "text", class: "opts", placeholder: "Options, separated by commas", value: (item.options || []).join(", "), "aria-label": "Options",
      oninput: (e) => (item.options = e.target.value.split(",").map((s) => s.trim()).filter(Boolean)) });
    return el("div", { class: "qrow" },
      el("input", { type: "text", value: item.label, "aria-label": "Question", placeholder: "Your question", oninput: (e) => (item.label = e.target.value) }),
      el("select", { "aria-label": "Answer type", onchange: (e) => { item.type = e.target.value; if (item.type === "choice" && !item.options) item.options = []; paintQ(); } },
        ...[["text", "Short answer"], ["long", "Long answer"], ["choice", "Multiple choice"]].map(([v, l]) => el("option", { value: v, selected: item.type === v }, l))),
      el("label", { class: "small", style: "margin:0;white-space:nowrap;font-weight:500" }, el("input", { type: "checkbox", checked: !!item.required, onchange: (e) => (item.required = e.target.checked) }), " Required"),
      el("button", { class: "btn danger sm", type: "button", "aria-label": "Remove question", onclick: () => { q.splice(i, 1); paintQ(); } }, "✕"),
      item.type === "choice" ? opts : null);
  }));
  paintQ();

  shell([
    el("div", { class: "head" }, el("h1", {}, "Setup"), el("button", { class: "btn", onclick: save }, "Save changes")),
    el("div", { class: "card stack" },
      el("h2", {}, "Your branding"),
      el("div", { class: "row" },
        el("div", { class: "grow" }, el("label", { for: "s-name" }, "Your name"), f.name),
        el("div", { class: "grow" }, el("label", { for: "s-biz" }, "Business name"), f.business),
        el("div", {}, el("label", { for: "s-col" }, "Colour"), f.colour)),
      el("div", {}, el("label", { for: "s-wel" }, "Welcome message"), f.welcome),
      el("div", {}, el("div", { class: "muted small", style: "margin-bottom:6px" }, "Preview of your client page header"), preview)),
    el("div", { class: "card stack", style: "margin-top:16px" },
      el("h2", {}, "Intake questions"),
      el("p", { class: "muted small", style: "margin:0" }, "Your client answers these on their page. Remove them all to skip this step."),
      qList,
      el("button", { class: "btn ghost sm", style: "align-self:flex-start", onclick: () => { q.push({ id: "", label: "", type: "text", required: false }); paintQ(); } }, "+ Add question")),
    el("div", { class: "card stack", style: "margin-top:16px" },
      el("h2", {}, "Files"),
      el("label", { for: "s-files", style: "display:flex;gap:10px;align-items:center;font-weight:500" }, f.askForFiles, "Ask clients to upload files (briefs, logos, documents; 10 MB each)")),
    el("div", { class: "card stack", style: "margin-top:16px" },
      el("h2", {}, "Meeting"),
      el("p", { class: "muted small", style: "margin:0" }, "Paste your booking link from Calendly, Cal.com, Google Calendar appointment pages, etc. Leave empty to skip this step."),
      el("div", {}, el("label", { for: "s-url" }, "Booking link"), f.meetingUrl),
      el("div", {}, el("label", { for: "s-mnote" }, "Short note for the client"), f.meetingNote)),
    err,
  ]);

  async function save() {
    err.textContent = "";
    try {
      await api("/api/settings", { method: "PUT", body: {
        name: f.name.value, business: f.business.value, colour: f.colour.value, welcome: f.welcome.value,
        meetingUrl: f.meetingUrl.value.trim(), meetingNote: f.meetingNote.value, askForFiles: f.askForFiles.checked, questions: q } });
      me = await api("/api/me");
      toast("Saved");
    } catch (x) { err.textContent = x.message; window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }
  }
}

boot();
