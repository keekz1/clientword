import { api, el } from "/ui.js";
const token = new URLSearchParams(location.search).get("token") || "";
history.replaceState(null, "", "/verify"); // keep the secret out of the address bar and history
const box = document.getElementById("box");
api("/api/auth/verify", { method: "POST", body: { token } })
  .then(() => box.replaceChildren(el("h1", { style: "font-size:1.4rem;margin:0" }, "Email confirmed"), el("p", { style: "margin:0" }, "You can now email clients from Clientword."), el("a", { class: "btn", href: "/app" }, "Go to your dashboard")))
  .catch((e) => box.replaceChildren(el("h1", { style: "font-size:1.4rem;margin:0" }, "That link didn't work"), el("p", { class: "muted", style: "margin:0" }, e.message), el("a", { class: "btn", href: "/app" }, "Go to your dashboard")));
