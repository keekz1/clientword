import { el, api, toast, when, size, STATUS, inkFor, ago, initials, dateTime } from "/ui.js";

const root = document.getElementById("root");
let me = null;
let view = { name: "clients" };
let timers = [];
let filter = "all";
let query = "";

async function boot() {
  try { me = await api("/api/me"); }
  catch { location.href = "/"; return; }
  go({ name: "clients" });
}

function go(v) {
  timers.forEach(clearInterval); timers = [];
  view = v; render(); window.scrollTo(0, 0);
}

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
const loading = () => el("div", { class: "stack", "aria-busy": "true" }, el("div", { class: "skeleton", style: "width:40%;height:28px" }), el("div", { class: "skeleton", style: "height:120px" }), el("div", { class: "skeleton", style: "height:120px" }));
const confirmBox = (text) => window.confirm(text);

// ---------- clients list ----------
async function clientsView() {
  shell(loading());
  let list;
  try { list = await api("/api/clients"); } catch (e) { return shell(el("p", { class: "err" }, e.message)); }

  const count = (fn) => list.filter(fn).length;
  const stats = el("div", { class: "stats" },
    stat(count((c) => c.status === "active"), "Active clients"),
    stat(count((c) => c.status === "invited" || c.status === "in_progress"), "Onboarding"),
    stat(count((c) => c.status === "ready"), "Ready for you"),
    stat(list.reduce((n, c) => n + c.unread, 0), "Unread messages"));

  const matches = (c) => {
    if (filter === "onboarding" && !["invited", "in_progress"].includes(c.status)) return false;
    if (filter !== "all" && filter !== "onboarding" && c.status !== filter) return false;
    const q = query.trim().toLowerCase();
    return !q || [c.name, c.email, c.project].some((v) => (v || "").toLowerCase().includes(q));
  };
  const tbody = el("tbody");
  const empty = el("div", { class: "empty" }, "No clients match.");
  const paint = () => {
    const rows = list.filter(matches);
    tbody.replaceChildren(...rows.map(row));
    empty.hidden = rows.length > 0;
  };
  const search = el("input", { type: "search", placeholder: "Search clients", "aria-label": "Search clients", value: query, oninput: (e) => { query = e.target.value; paint(); } });
  const pills = el("div", { class: "pills", role: "group", "aria-label": "Filter" },
    [["all", "All"], ["onboarding", "Onboarding"], ["ready", "Ready"], ["active", "Active"], ["archived", "Archived"]].map(([k, label]) =>
      el("button", { "aria-pressed": String(filter === k), onclick: (e) => { filter = k; pills.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === e.currentTarget)); paint(); } }, label)));

  const body = list.length
    ? [stats, el("div", { class: "toolbar" }, search, pills),
       el("div", { class: "card", style: "padding:6px 8px;overflow-x:auto" },
         el("table", {},
           el("thead", {}, el("tr", {}, el("th", {}, "Client"), el("th", { class: "hide-sm" }, "Progress"), el("th", {}, "Status"), el("th", { class: "hide-sm" }, "Last activity"))),
           tbody), empty)]
    : el("div", { class: "card empty" },
        el("h2", {}, "Add your first client"),
        el("p", {}, "Each client gets a private page with your questions, contract, file upload and booking link."),
        el("p", { class: "hint" }, "Tip: check Setup first so their page looks right."),
        el("div", { class: "row", style: "justify-content:center" },
          el("button", { class: "btn", onclick: addClientModal }, "Add a client"),
          el("button", { class: "btn ghost", onclick: () => go({ name: "setup" }) }, "Open Setup")));
  shell([el("div", { class: "head" }, el("h1", {}, "Clients"), el("button", { class: "btn", onclick: addClientModal }, "+ Add client")), body]);
  if (list.length) paint();
}
const stat = (n, label) => el("div", { class: "card stat" }, el("b", {}, String(n)), el("span", {}, label));

function row(c) {
  const done = c.steps.filter((s) => s.done).length;
  const go1 = () => go({ name: "client", id: c.id });
  return el("tr", { class: "click", tabIndex: 0, onclick: go1, onkeydown: (e) => e.key === "Enter" && go1() },
    el("td", {}, el("div", { class: "who-cell" }, el("span", { class: "avatar", "aria-hidden": "true" }, initials(c.name)),
      el("div", {}, el("strong", {}, c.name), c.unread ? el("span", { class: "badge", title: c.unread + " unread" }, String(c.unread)) : null,
        el("div", { class: "muted small" }, c.project || c.email || "")))),
    el("td", { class: "hide-sm", style: "width:140px" }, c.steps.length
      ? el("div", { title: `${done} of ${c.steps.length} steps` }, el("div", { class: "bar" }, el("i", { style: `width:${Math.round(done / c.steps.length * 100)}%` })), el("div", { class: "muted small" }, `${done}/${c.steps.length}`))
      : el("span", { class: "muted" }, "—")),
    el("td", {}, el("span", { class: "chip " + c.status }, STATUS[c.status])),
    el("td", { class: "hide-sm muted nowrap" }, c.opened || c.lastActivity ? ago(c.lastActivity) : "Not opened"));
}

function addClientModal() {
  const err = el("div", { class: "err", role: "alert" });
  const name = el("input", { type: "text", id: "cn", autocomplete: "off" });
  const email = el("input", { type: "email", id: "ce", autocomplete: "off" });
  const project = el("input", { type: "text", id: "cp", autocomplete: "off" });
  const close = () => { bg.remove(); document.removeEventListener("keydown", esc); };
  const esc = (e) => e.key === "Escape" && close();
  const bg = el("div", { class: "modal-bg", onclick: (e) => e.target === bg && close() },
    el("form", { class: "card modal stack", role: "dialog", "aria-modal": "true", "aria-label": "Add a client", onsubmit: async (e) => {
      e.preventDefault();
      try {
        const c = await api("/api/clients", { method: "POST", body: { name: name.value, email: email.value, project: project.value } });
        close(); go({ name: "client", id: c.id });
      } catch (x) { err.textContent = x.message; }
    } },
      el("h2", {}, "Add a client"),
      el("div", {}, el("label", { for: "cn" }, "Client name"), name),
      el("div", {}, el("label", { for: "ce" }, "Email ", el("span", { class: "muted" }, "(needed to email them their link)")), email),
      el("div", {}, el("label", { for: "cp" }, "Project ", el("span", { class: "muted" }, "(optional)")), project),
      err,
      el("div", { class: "row" }, el("button", { class: "btn", type: "submit" }, "Create client"), el("button", { class: "btn ghost", type: "button", onclick: close }, "Cancel"))));
  document.body.append(bg);
  document.addEventListener("keydown", esc);
  name.focus();
}

// ---------- one client ----------
async function clientView(id) {
  shell(loading());
  let c;
  try { c = await api("/api/clients/" + id); } catch { return go({ name: "clients" }); }
  const link = location.origin + "/c/" + c.token;
  const linkInput = el("input", { type: "text", readOnly: true, value: link, "aria-label": "Client link" });
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); clientView(id); } catch (x) { toast(x.message); } };

  const linkCard = el("div", { class: "card stack" },
    el("h3", {}, "Client link"),
    el("p", { class: "hint", style: "margin:0" }, c.opened ? "They have opened it." : "Not opened yet. Anyone with this link can fill in their page, so share it only with them."),
    el("div", { class: "linkbox" }, linkInput,
      el("button", { class: "btn", onclick: async () => { try { await navigator.clipboard.writeText(link); } catch { linkInput.select(); document.execCommand("copy"); } toast("Link copied"); } }, "Copy"),
      el("a", { class: "btn ghost", href: link, target: "_blank", rel: "noopener" }, "Preview")),
    el("div", { class: "row" },
      el("button", { class: "btn ghost sm", disabled: !c.email, title: c.email ? "" : "Add an email for this client first", onclick: () => act(() => api(`/api/clients/${c.id}/invite`, { method: "POST" }), "Email sent") },
        c.invitedAt ? "Email link again" : "Email link to client"),
      ["invited", "in_progress"].includes(c.status) ? el("button", { class: "btn ghost sm", disabled: !c.email, onclick: () => act(() => api(`/api/clients/${c.id}/remind`, { method: "POST" }), "Reminder sent") }, "Send reminder") : null,
      !c.email ? el("span", { class: "hint" }, "No email on file.") : c.invitedAt ? el("span", { class: "hint" }, "Emailed " + ago(c.invitedAt)) : null));

  const answers = c.intake
    ? el("dl", { class: "qa" }, c.questions.flatMap((q) => [el("dt", {}, q.label), el("dd", {}, c.intake.answers[q.id] || "—")]))
    : el("p", { class: "muted", style: "margin:0" }, "Not filled in yet.");
  const filesBox = c.files.length
    ? el("ul", { class: "files" }, c.files.map((f) => el("li", {}, el("a", { href: `/api/clients/${c.id}/files/${f.id}` }, f.name), el("span", { class: "muted" }, size(f.size)))))
    : el("p", { class: "muted", style: "margin:0" }, "No files yet.");
  const meeting = c.meeting ? el("p", { style: "margin:0" }, "Booked: ", el("strong", {}, c.meeting.when)) : el("p", { class: "muted", style: "margin:0" }, "Not booked yet.");

  const notes = el("textarea", { "aria-label": "Private notes", placeholder: "Private notes (your client never sees these)" });
  notes.value = c.notes || "";

  shell([
    el("button", { class: "back", onclick: () => go({ name: "clients" }) }, "← All clients"),
    el("div", { class: "head" },
      el("div", { class: "who-cell" }, el("span", { class: "avatar", style: "width:46px;height:46px;font-size:1rem" }, initials(c.name)),
        el("div", {}, el("h1", { style: "margin:0" }, c.name), el("div", { class: "muted" }, [c.project, c.email].filter(Boolean).join(" · ") || "No project details"))),
      el("span", { class: "chip " + c.status }, STATUS[c.status])),
    linkCard,
    el("div", { class: "cols", style: "margin-top:16px" },
      el("div", {},
        el("div", { class: "card" }, el("h3", {}, "Their answers"), answers),
        contractCard(c, act),
        el("div", { class: "card" }, el("h3", {}, "Files"), filesBox),
        el("div", { class: "card" }, el("h3", {}, "Call"), meeting)),
      el("div", {},
        messagesCard(c),
        el("div", { class: "card stack" }, el("h3", { style: "margin:0" }, "Private notes"), notes,
          el("button", { class: "btn sm", style: "align-self:flex-start", onclick: () => act(() => api("/api/clients/" + c.id, { method: "PATCH", body: { notes: notes.value } }), "Notes saved") }, "Save notes")))),
    el("div", { class: "row", style: "margin-top:16px" },
      c.status !== "active" ? el("button", { class: "btn", onclick: () => act(() => api("/api/clients/" + c.id, { method: "PATCH", body: { status: "active" } }), "Marked active") }, "Mark as active client")
        : el("button", { class: "btn ghost", onclick: () => act(() => api("/api/clients/" + c.id, { method: "PATCH", body: { status: "" } })) }, "Move back to onboarding"),
      c.status !== "archived" ? el("button", { class: "btn ghost", onclick: () => act(() => api("/api/clients/" + c.id, { method: "PATCH", body: { status: "archived" } }), "Archived") }, "Archive") : null,
      el("button", { class: "btn danger", onclick: async () => { if (confirmBox("Delete this client with their answers, files and messages? This can't be undone.")) { await api("/api/clients/" + c.id, { method: "DELETE" }); go({ name: "clients" }); } } }, "Delete")),
  ]);
}

function contractCard(c, act) {
  const card = el("div", { class: "card stack" }, el("h3", { style: "margin:0" }, "Contract"));
  const signed = c.contract?.signed;
  if (signed) {
    card.append(
      el("strong", {}, c.contract.title),
      el("div", { class: "contract-text" }, c.contract.body),
      el("div", { class: "sigbox" },
        el("div", { class: "ok-text" }, "✓ Signed by ", el("strong", {}, signed.name)),
        el("div", {}, dateTime(signed.at)),
        el("div", { class: "hint" }, "From IP ", signed.ip),
        el("div", { class: "hint" }, "Fingerprint of the signed text (SHA-256):"), el("code", {}, signed.hash)));
    return card;
  }
  const edit = () => {
    const title = el("input", { type: "text", id: "ct", value: c.contract?.title || c.contractTemplate.title });
    const body = el("textarea", { id: "cb", style: "min-height:200px" });
    body.value = c.contract?.body || c.contractTemplate.body;
    const err = el("div", { class: "err", role: "alert" });
    card.replaceChildren(el("h3", { style: "margin:0" }, c.contract ? "Edit contract" : "Add a contract"),
      el("p", { class: "hint", style: "margin:0" }, "Your client will see this as a step and sign it by typing their name. You can't edit it after they sign."),
      el("div", {}, el("label", { for: "ct" }, "Title"), title), el("div", {}, el("label", { for: "cb" }, "Contract text"), body), err,
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: async () => { try { await api(`/api/clients/${c.id}/contract`, { method: "PUT", body: { title: title.value, body: body.value } }); toast("Contract saved"); act(async () => {}); } catch (x) { err.textContent = x.message; } } }, "Save contract"),
        el("button", { class: "btn ghost", onclick: () => act(async () => {}) }, "Cancel")));
  };
  if (!c.contract) {
    card.append(el("p", { class: "muted", style: "margin:0" }, "No contract yet. Add one and your client will be asked to sign it."), el("button", { class: "btn ghost sm", style: "align-self:flex-start", onclick: edit }, "Add a contract"));
  } else {
    card.append(el("strong", {}, c.contract.title), el("div", { class: "contract-text" }, c.contract.body),
      el("p", { class: "hint", style: "margin:0" }, "Waiting for their signature."),
      el("div", { class: "row" }, el("button", { class: "btn ghost sm", onclick: edit }, "Edit"),
        el("button", { class: "btn danger sm", onclick: () => confirmBox("Remove this contract?") && act(() => api(`/api/clients/${c.id}/contract`, { method: "PUT", body: { title: "", body: "" } }), "Removed") }, "Remove")));
  }
  return card;
}

function messagesCard(c) {
  const thread = el("div", { class: "thread", "aria-live": "polite" });
  const input = el("textarea", { placeholder: "Write a message…", "aria-label": "Message", maxLength: 2000, rows: 1 });
  const send = el("button", { class: "btn", type: "button" }, "Send");
  let lastCount = -1;
  const paint = (msgs) => {
    if (msgs.length === lastCount) return;
    lastCount = msgs.length;
    thread.replaceChildren(...(msgs.length ? msgs.map((m) => el("div", { class: "bubble " + (m.from === "freelancer" ? "me" : "them") }, m.text, el("small", {}, ago(m.at)))) : [el("p", { class: "muted small", style: "margin:0" }, "No messages yet.")]));
    thread.scrollTop = thread.scrollHeight;
  };
  const refresh = () => api(`/api/clients/${c.id}/messages`).then(paint).catch(() => {});
  const doSend = async () => {
    const text = input.value.trim(); if (!text) return;
    send.disabled = true;
    try { await api(`/api/clients/${c.id}/messages`, { method: "POST", body: { text } }); input.value = ""; await refresh(); }
    catch (x) { toast(x.message); }
    send.disabled = false; input.focus();
  };
  send.onclick = doSend;
  input.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } };
  refresh();
  timers.push(setInterval(() => document.visibilityState === "visible" && refresh(), 20000));
  return el("div", { class: "card" }, el("h3", {}, "Messages"), thread,
    el("div", { class: "msgbox" }, input, send),
    el("p", { class: "hint", style: "margin:8px 0 0" }, c.email ? "They're emailed when you write (at most every 10 minutes)." : "No email on file, so they only see this when they open their page."));
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
    notify: el("input", { type: "checkbox", id: "s-notify", checked: me.notify }),
    ctitle: el("input", { type: "text", id: "s-ct", value: me.contractTemplate.title }),
    cbody: el("textarea", { id: "s-cb", style: "min-height:160px", placeholder: "Paste your standard terms here. You can edit them for each client." }),
  };
  f.welcome.value = me.welcome;
  f.cbody.value = me.contractTemplate.body;

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

  const section = (title, ...kids) => el("div", { class: "card stack", style: "margin-top:16px" }, el("h2", {}, title), ...kids);
  shell([
    el("div", { class: "head" }, el("h1", {}, "Setup"), el("button", { class: "btn", onclick: save }, "Save changes")),
    el("div", { class: "card stack" },
      el("h2", {}, "Your branding"),
      el("div", { class: "row" },
        el("div", { class: "grow" }, el("label", { for: "s-name" }, "Your name"), f.name),
        el("div", { class: "grow" }, el("label", { for: "s-biz" }, "Business name"), f.business),
        el("div", {}, el("label", { for: "s-col" }, "Colour"), f.colour)),
      el("div", {}, el("label", { for: "s-wel" }, "Welcome message"), f.welcome),
      el("div", {}, el("div", { class: "hint", style: "margin-bottom:6px" }, "Preview of your client page header"), preview)),
    section("Intake questions",
      el("p", { class: "hint", style: "margin:0" }, "Your client answers these on their page. Remove them all to skip this step."),
      qList,
      el("button", { class: "btn ghost sm", style: "align-self:flex-start", onclick: () => { q.push({ id: "", label: "", type: "text", required: false }); paintQ(); } }, "+ Add question")),
    section("Contract template",
      el("p", { class: "hint", style: "margin:0" }, "Optional. This text is pre-filled when you add a contract to a client, where you can still change it. Have a solicitor check terms you rely on."),
      el("div", {}, el("label", { for: "s-ct" }, "Title"), f.ctitle), el("div", {}, el("label", { for: "s-cb" }, "Text"), f.cbody)),
    section("Files", el("label", { for: "s-files", class: "switch" }, f.askForFiles, "Ask clients to upload files (briefs, logos, documents; 10 MB each)")),
    section("Meeting",
      el("p", { class: "hint", style: "margin:0" }, "Paste your booking link from Calendly, Cal.com, Google Calendar appointment pages, etc. Leave empty to skip this step."),
      el("div", {}, el("label", { for: "s-url" }, "Booking link"), f.meetingUrl),
      el("div", {}, el("label", { for: "s-mnote" }, "Short note for the client"), f.meetingNote)),
    section("Notifications", el("label", { for: "s-notify", class: "switch" }, f.notify, "Email me when a client finishes, signs or messages me")),
    err,
  ]);

  async function save() {
    err.textContent = "";
    try {
      await api("/api/settings", { method: "PUT", body: {
        name: f.name.value, business: f.business.value, colour: f.colour.value, welcome: f.welcome.value,
        meetingUrl: f.meetingUrl.value.trim(), meetingNote: f.meetingNote.value, askForFiles: f.askForFiles.checked, notify: f.notify.checked,
        contractTemplate: { title: f.ctitle.value, body: f.cbody.value }, questions: q } });
      me = await api("/api/me");
      toast("Saved");
    } catch (x) { err.textContent = x.message; window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }
  }
}

boot();
