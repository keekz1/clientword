import { api } from "/ui.js";
let mode = "signup";
const $ = (id) => document.getElementById(id);
function setMode(m) {
  mode = m;
  $("t-signup").setAttribute("aria-selected", m === "signup");
  $("t-login").setAttribute("aria-selected", m === "login");
  document.querySelectorAll("[data-only=signup]").forEach((d) => (d.hidden = m !== "signup"));
  $("forgot-row").hidden = m !== "login";
  $("go").textContent = m === "signup" ? "Create account" : "Log in";
  $("password").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("err").textContent = ""; $("ok").textContent = "";
}
$("t-signup").onclick = () => setMode("signup");
$("t-login").onclick = () => setMode("login");
$("nav-login").onclick = () => setMode("login");
$("showpw").onclick = () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("showpw").textContent = show ? "Hide" : "Show";
  $("showpw").setAttribute("aria-pressed", show);
};
$("forgot").onclick = async () => {
  $("err").textContent = ""; $("ok").textContent = "";
  if (!$("email").value.trim()) { $("err").textContent = "Enter your email above first."; return; }
  try {
    await api("/api/auth/forgot", { method: "POST", body: { email: $("email").value } });
    $("ok").textContent = "If that email has an account, a reset link is on its way.";
  } catch (x) { $("err").textContent = x.message; }
};
$("form").onsubmit = async (e) => {
  e.preventDefault();
  $("go").disabled = true; $("err").textContent = ""; $("ok").textContent = "";
  try {
    await api("/api/auth/" + mode, { method: "POST", body: { name: $("name").value, business: $("business").value, email: $("email").value, password: $("password").value } });
    location.href = "/app";
  } catch (x) { $("err").textContent = x.message; $("go").disabled = false; }
};
// Already logged in? Go straight to the dashboard. (A 401 here is normal for visitors.)
api("/api/me").then(() => (location.href = "/app")).catch(() => {});
