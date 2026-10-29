import { api } from "/ui.js";
const token = new URLSearchParams(location.search).get("token") || "";
history.replaceState(null, "", "/reset"); // keep the secret out of the address bar and history
const $ = (id) => document.getElementById(id);
$("form").onsubmit = async (e) => {
  e.preventDefault(); $("go").disabled = true; $("err").textContent = "";
  try {
    await api("/api/auth/reset", { method: "POST", body: { token, password: $("pw").value } });
    location.href = "/app";
  } catch (x) { $("err").textContent = x.message; $("go").disabled = false; }
};
