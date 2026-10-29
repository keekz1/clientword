// PDF tools that run entirely in the browser: fill in and sign a PDF, and turn a PDF into a Word file.
// Nothing is sent anywhere until the person presses "Sign and send". Libraries are loaded on demand from /vendor.
import { el } from "/ui.js";

// ---------- library loading ----------
const loadScript = (src) => new Promise((ok, bad) => {
  const s = document.createElement("script");
  s.src = src; s.onload = ok; s.onerror = () => bad(new Error("Couldn't load the PDF tools. Check your connection and try again."));
  document.head.append(s);
});
async function pdfjs() {
  const lib = await import("/vendor/pdf.min.mjs");
  lib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  return lib;
}
async function pdfLib() { if (!window.PDFLib) await loadScript("/vendor/pdf-lib.min.js"); return window.PDFLib; }
async function docxLib() { if (!window.docx) await loadScript("/vendor/docx.iife.js"); return window.docx; }
async function openPdf(bytes) {
  const lib = await pdfjs();
  try { return await lib.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: "/vendor/standard_fonts/", isEvalSupported: false }).promise; }
  catch (e) {
    if (e && e.name === "PasswordException") throw new Error("This PDF is password protected. Please ask for an unprotected copy.");
    throw new Error("This file couldn't be opened as a PDF.");
  }
}

export async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Couldn't download the document. Please try again.");
  return new Uint8Array(await r.arrayBuffer());
}
export function saveFile(data, filename, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return "unavailable";
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const baseName = (n) => String(n || "document").replace(/\.pdf$/i, "");

// ---------- PDF -> Word ----------
// Rebuilds the text as editable paragraphs: headings by size, paragraphs by spacing, bullets and numbering kept.
// Pictures, tables and exact layout are not carried over, and scanned PDFs (no real text) can't be converted.
export async function pdfToWord(bytes, filename) {
  const pdf = await openPdf(bytes);
  const D = await docxLib();
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => typeof i.str === "string" && i.str.trim() !== "")
      .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width, fs: Math.abs(i.transform[3]) || i.height || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= Math.max(2, Math.min(last.fs, it.fs) * 0.45)) last.parts.push(it);
      else lines.push({ y: it.y, fs: it.fs, parts: [it] });
    }
    for (const ln of lines) {
      ln.parts.sort((a, b) => a.x - b.x);
      let text = "", prevEnd = null;
      for (const part of ln.parts) {
        if (prevEnd !== null && part.x - prevEnd > ln.fs * 0.2 && !text.endsWith(" ") && !part.s.startsWith(" ")) text += " ";
        text += part.s; prevEnd = part.x + part.w;
      }
      ln.text = text.replace(/\s+/g, " ").trim();
      ln.x = ln.parts[0].x; ln.end = prevEnd; ln.fs = Math.max(...ln.parts.map((q) => q.fs));
    }
    pages.push({ lines: lines.filter((l) => l.text), width: vp.width });
  }
  const sizes = pages.flatMap((p) => p.lines.map((l) => l.fs)).sort((a, b) => a - b);
  const chars = pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.text.length, 0), 0);
  if (chars < 20) throw new Error("This PDF has no selectable text (it looks like a scan), so it can't be converted to Word without text recognition.");
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  const headSizes = [...new Set(sizes.filter((s) => s >= body * 1.25).map((s) => Math.round(s)))].sort((a, b) => b - a);
  const levels = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3];

  const children = [];
  const startsItem = /^(\d+[.)]|[a-z][.)]|[•·▪◦●-])\s/;
  pages.forEach((pg, pi) => {
    const minX = Math.min(...pg.lines.map((l) => l.x), pg.width);
    let para = null, prev = null;
    const flush = () => { if (para) children.push(buildPara(para, pi === 0 && !children.length ? false : false)); para = null; };
    const buildPara = (q) => new D.Paragraph({
      pageBreakBefore: q.pageBreak, heading: q.heading, alignment: q.centered ? D.AlignmentType.CENTER : undefined,
      indent: q.indent > 10 ? { left: Math.min(Math.round(q.indent * 20), 4000) } : undefined, spacing: { after: 120 },
      children: [new D.TextRun({ text: q.text, size: Math.max(16, Math.min(56, Math.round(q.fs * 2))) })],
    });
    let first = true;
    for (const ln of pg.lines) {
      const hIdx = headSizes.indexOf(Math.round(ln.fs));
      const isHead = hIdx >= 0 && ln.text.length < 120;
      const centered = ln.x > minX + ln.fs * 3 && Math.abs((ln.x + ln.end) / 2 - pg.width / 2) < ln.fs * 1.5;
      const gap = prev ? prev.y - ln.y : 0;
      const newPara = !para || isHead || para.heading || gap > ln.fs * 1.75 || startsItem.test(ln.text) || centered || para.centered || Math.abs(ln.fs - para.fs) > 1.5;
      if (newPara) {
        flush();
        para = { text: ln.text, fs: ln.fs, heading: isHead ? levels[Math.min(hIdx, 2)] : undefined, centered, indent: ln.x - minX, pageBreak: first && pi > 0 };
        first = false;
      } else {
        para.text += (para.text.endsWith("-") && !/\s-$/.test(para.text) ? "" : " ") + ln.text;
      }
      prev = ln;
    }
    flush();
  });
  const doc = new D.Document({ creator: "Clientword", title: baseName(filename), sections: [{ children }] });
  return D.Packer.toBlob(doc);
}

// ---------- fill in and sign ----------
const INK = "#1b2a6b";
const SCRIPT_FONTS = '"Snell Roundhand","Segoe Script","Brush Script MT","Apple Chancery","Lucida Handwriting","URW Chancery L",cursive';
const today = () => new Date().toLocaleDateString("en-GB");
let uid = 0;

function signatureDialog(defaultName) { // -> Promise<{ url, ratio } | null>
  return new Promise((resolve) => {
    let mode = "type", drawn = false;
    const name = el("input", { type: "text", value: defaultName || "", "aria-label": "Your name", maxLength: 60 });
    const prev = el("canvas", { width: 760, height: 220, class: "sig-canvas", "aria-label": "Signature preview" });
    const pad = el("canvas", { width: 760, height: 220, class: "sig-canvas draw", "aria-label": "Draw your signature here" });
    const pctx = pad.getContext("2d");
    pctx.lineWidth = 5; pctx.lineCap = "round"; pctx.lineJoin = "round"; pctx.strokeStyle = INK;
    let down = false;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
    pad.addEventListener("pointerdown", (e) => { down = true; drawn = true; pad.setPointerCapture(e.pointerId); const [x, y] = pos(e); pctx.beginPath(); pctx.moveTo(x, y); pctx.lineTo(x + 0.1, y + 0.1); pctx.stroke(); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (!down) return; const [x, y] = pos(e); pctx.lineTo(x, y); pctx.stroke(); });
    const up = () => { down = false; };
    pad.addEventListener("pointerup", up); pad.addEventListener("pointercancel", up);

    const drawTyped = () => {
      const c = prev.getContext("2d"); c.clearRect(0, 0, prev.width, prev.height);
      c.fillStyle = INK; c.textBaseline = "middle"; c.font = `96px ${SCRIPT_FONTS}`;
      let size = 96; while (c.measureText(name.value || " ").width > prev.width - 40 && size > 24) { size -= 4; c.font = `${size}px ${SCRIPT_FONTS}`; }
      c.fillText(name.value, 20, prev.height / 2);
    };
    name.addEventListener("input", drawTyped);
    const err = el("div", { class: "err", role: "alert" });
    const typeBox = el("div", { class: "stack" }, el("label", { for: "sg-name" }, "Type your name"), name, prev);
    name.id = "sg-name";
    const drawBox = el("div", { class: "stack", hidden: true }, el("div", { class: "hint", style: "margin:0" }, "Draw with your finger, mouse or pen."), pad,
      el("button", { class: "btn ghost sm", type: "button", style: "align-self:flex-start", onclick: () => { pctx.clearRect(0, 0, pad.width, pad.height); drawn = false; } }, "Clear"));
    const tabType = el("button", { type: "button", role: "tab", "aria-selected": "true", onclick: () => setMode("type") }, "Type");
    const tabDraw = el("button", { type: "button", role: "tab", "aria-selected": "false", onclick: () => setMode("draw") }, "Draw");
    function setMode(m) {
      mode = m; typeBox.hidden = m !== "type"; drawBox.hidden = m !== "draw";
      tabType.setAttribute("aria-selected", m === "type"); tabDraw.setAttribute("aria-selected", m === "draw");
    }
    const close = (v) => { bg.remove(); resolve(v); };
    const use = () => {
      const src = mode === "type" ? prev : pad;
      if (mode === "type" && !name.value.trim()) { err.textContent = "Type your name first."; return; }
      if (mode === "draw" && !drawn) { err.textContent = "Draw your signature first."; return; }
      // crop to the ink so the signature sits snugly where it is placed
      const ctx = src.getContext("2d"), { width: w, height: h } = src, d = ctx.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 <= x0 || y1 <= y0) { err.textContent = "Couldn't read the signature. Please try again."; return; }
      const pad8 = 8, cw = x1 - x0 + 1 + pad8 * 2, ch = y1 - y0 + 1 + pad8 * 2;
      const out = document.createElement("canvas"); out.width = cw; out.height = ch;
      out.getContext("2d").drawImage(src, x0 - pad8, y0 - pad8, cw, ch, 0, 0, cw, ch);
      close({ url: out.toDataURL("image/png"), ratio: ch / cw });
    };
    const bg = el("div", { class: "modal-bg ed-top", onclick: (e) => e.target === bg && close(null) },
      el("div", { class: "card modal stack", style: "max-width:520px", role: "dialog", "aria-modal": "true", "aria-label": "Create your signature" },
        el("h2", {}, "Your signature"), el("div", { class: "tabs", role: "tablist" }, tabType, tabDraw), typeBox, drawBox, err,
        el("div", { class: "row" }, el("button", { class: "btn", type: "button", onclick: use }, "Use this signature"), el("button", { class: "btn ghost", type: "button", onclick: () => close(null) }, "Cancel"))));
    document.body.append(bg); drawTyped(); name.focus();
  });
}

// Opens the editor. onComplete({ bytes, name }) must upload the result; it can throw to show an error.
export async function openSigner({ bytes, filename, defaultName, onComplete }) {
  const pdf = await openPdf(bytes);
  if (pdf.numPages > 60) throw new Error("This document is too long to fill in here (60 pages max).");
  const first = await pdf.getPage(1);
  for (let p = 1; p <= pdf.numPages; p++) {
    if ((await pdf.getPage(p)).rotate % 360 !== 0) throw new Error("This PDF has rotated pages. Please ask for it to be saved again (Print > Save as PDF) and try once more.");
  }
  void first;

  const items = []; // { id, page, type, x, y, fs|w, text|url, ratio } with x, y, w, fs as fractions of the page width/height
  let tool = null, selected = null, savedSig = null;
  const pageEls = [];
  const bar = el("div", { class: "ed-bar" });
  const scroller = el("div", { class: "ed-scroll" });
  const status = el("div", { class: "ed-hint", role: "status" }, "Choose a tool, then tap on the page.");
  const root = el("div", { class: "pdf-ed", role: "dialog", "aria-modal": "true", "aria-label": "Fill in and sign: " + filename }, bar, status, scroller);
  const toolBtns = {};
  const pageW = (i) => pageEls[i].wrap.clientWidth;

  function setTool(t) {
    tool = tool === t ? null : t;
    for (const [k, b] of Object.entries(toolBtns)) b.setAttribute("aria-pressed", String(k === tool));
    scroller.classList.toggle("placing", !!tool);
    status.textContent = tool ? "Now tap where it should go on the page." : "Choose a tool, then tap on the page. Drag things to move them.";
  }
  function select(it) {
    selected = it;
    for (const q of items) q.node?.classList.toggle("sel", q === it);
    sizeBtns.hidden = !it || it.type === "sig"; delBtn.hidden = !it;
  }
  const sizeBtns = el("span", { class: "row", hidden: true, style: "gap:4px" },
    el("button", { class: "btn ghost sm", type: "button", "aria-label": "Smaller", onclick: () => bump(-0.15) }, "A−"),
    el("button", { class: "btn ghost sm", type: "button", "aria-label": "Larger", onclick: () => bump(0.15) }, "A+"));
  const delBtn = el("button", { class: "btn ghost sm", type: "button", hidden: true, onclick: () => remove(selected) }, "Delete");
  function bump(f) { if (!selected || selected.type === "sig") return; selected.fs = Math.min(0.08, Math.max(0.01, selected.fs * (1 + f))); paint(selected); }
  function remove(it) { if (!it) return; it.node.remove(); items.splice(items.indexOf(it), 1); select(null); }

  // position and size an item's element from its fractions
  function paint(it) {
    const W = pageW(it.page), H = pageEls[it.page].wrap.clientHeight, n = it.node;
    n.style.left = it.x * W + "px"; n.style.top = it.y * H + "px";
    if (it.type === "text") { n.style.fontSize = it.fs * W + "px"; n.firstChild.style.width = Math.max(3, it.text.length + 1) + "ch"; }
    else if (it.type === "tick") { n.style.width = n.style.height = it.fs * W + "px"; }
    else { n.style.width = it.w * W + "px"; n.style.height = it.w * W * it.ratio + "px"; }
  }
  function build(it) {
    const n = el("div", { class: "ed-item " + it.type, tabIndex: 0 });
    if (it.type === "text") {
      const inp = el("input", { type: "text", value: it.text, "aria-label": "Text on the document", maxLength: 200 });
      inp.addEventListener("input", () => { it.text = inp.value; paint(it); });
      n.append(inp);
    } else if (it.type === "tick") {
      n.innerHTML = '<svg viewBox="0 0 20 20" width="100%" height="100%" aria-label="Tick"><polyline points="3,11 8,16 17,4" fill="none" stroke="' + INK + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    } else {
      n.append(el("img", { src: it.url, alt: "Your signature", draggable: false }));
      const h = el("span", { class: "ed-handle", "aria-hidden": "true" });
      h.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); e.preventDefault(); h.setPointerCapture(e.pointerId);
        const W = pageW(it.page), startX = e.clientX, w0 = it.w;
        const mv = (m) => { it.w = Math.min(0.9, Math.max(0.05, w0 + (m.clientX - startX) / W)); paint(it); };
        const done = () => { h.removeEventListener("pointermove", mv); h.removeEventListener("pointerup", done); };
        h.addEventListener("pointermove", mv); h.addEventListener("pointerup", done);
      });
      n.append(h);
    }
    // drag to move (not while typing in a text box)
    n.addEventListener("pointerdown", (e) => {
      select(it);
      if (e.target.tagName === "INPUT" && document.activeElement === e.target) return;
      if (e.target.classList.contains("ed-handle")) return;
      const W = pageW(it.page), H = pageEls[it.page].wrap.clientHeight, sx = e.clientX, sy = e.clientY, x0 = it.x, y0 = it.y;
      let moved = false;
      const mv = (m) => {
        if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
        if (!moved) { moved = true; n.setPointerCapture(e.pointerId); }
        it.x = Math.min(0.98, Math.max(0, x0 + (m.clientX - sx) / W)); it.y = Math.min(0.98, Math.max(0, y0 + (m.clientY - sy) / H)); paint(it);
      };
      const done = () => { n.removeEventListener("pointermove", mv); n.removeEventListener("pointerup", done); n.removeEventListener("pointercancel", done); };
      n.addEventListener("pointermove", mv); n.addEventListener("pointerup", done); n.addEventListener("pointercancel", done);
      if (e.target.tagName === "INPUT") return; // let a first tap focus the box; a drag still moves it
    });
    it.node = n;
    pageEls[it.page].layer.append(n);
    paint(it);
    return n;
  }
  async function place(pageIdx, e) {
    const rect = pageEls[pageIdx].layer.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
    const t = tool; setTool(t); // drop the tool after one placement
    let it;
    if (t === "text") it = { type: "text", text: "", fs: 0.022, x: fx, y: fy - 0.012 };
    else if (t === "date") it = { type: "text", text: today(), fs: 0.022, x: fx, y: fy - 0.012 };
    else if (t === "tick") it = { type: "tick", fs: 0.026, x: fx - 0.013, y: fy - 0.013 };
    else if (t === "sig") {
      if (!savedSig) { savedSig = await signatureDialog(defaultName); if (!savedSig) return; sigBtn.textContent = "Signature"; changeSig.hidden = false; }
      it = { type: "sig", url: savedSig.url, ratio: savedSig.ratio, w: 0.28, x: fx - 0.14, y: fy - 0.04 };
    } else return;
    it.id = ++uid; it.page = pageIdx;
    it.x = Math.min(0.9, Math.max(0, it.x)); it.y = Math.min(0.95, Math.max(0, it.y));
    items.push(it); build(it); select(it);
    if (it.type === "text") it.node.firstChild.focus();
  }

  // ----- toolbar -----
  const mk = (key, label) => (toolBtns[key] = el("button", { class: "btn ghost sm", type: "button", "aria-pressed": "false", onclick: () => setTool(key) }, label));
  const sigBtn = mk("sig", "✍ Sign here");
  const changeSig = el("button", { class: "btn ghost sm", type: "button", hidden: true, onclick: async () => { const s = await signatureDialog(defaultName); if (s) { savedSig = s; setTool("sig"); } } }, "Change signature");
  const err = el("div", { class: "err", role: "alert" });
  const finishBtn = el("button", { class: "btn sm", type: "button", onclick: finish }, "Finish");
  const cancelBtn = el("button", { class: "btn ghost sm", type: "button", onclick: () => { if (!items.length || confirm("Close without signing? Anything you've added will be lost.")) closeAll(); } }, "Close");
  bar.append(el("strong", { class: "ed-title" }, filename), mk("text", "T Text"), mk("date", "📅 Date"), mk("tick", "✓ Tick"), sigBtn, changeSig, sizeBtns, delBtn, el("span", { class: "grow" }), cancelBtn, finishBtn);

  const closeAll = () => { document.removeEventListener("keydown", onKey); root.remove(); document.body.classList.remove("ed-open"); };
  const onKey = (e) => {
    if (document.querySelector(".ed-top")) return;
    if (e.key === "Escape") { if (tool) setTool(tool); else select(null); }
    if ((e.key === "Delete" || e.key === "Backspace") && selected && e.target.tagName !== "INPUT") { e.preventDefault(); remove(selected); }
  };
  document.addEventListener("keydown", onKey);
  document.body.classList.add("ed-open");
  document.body.append(root);

  // ----- pages -----
  const avail = Math.min(scroller.clientWidth - 24 || 800, 980);
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const cssW = Math.max(280, avail), scale = cssW / base.width, vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const canvas = el("canvas", { class: "ed-page", "aria-label": `Page ${p} of ${pdf.numPages}` });
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = "100%"; canvas.style.height = "100%";
    const layer = el("div", { class: "ed-layer" });
    const wrap = el("div", { class: "ed-wrap", style: `width:${cssW}px;aspect-ratio:${vp.width}/${vp.height}` }, canvas, layer);
    const idx = p - 1;
    // "click" (not pointerdown) so a tap on a phone is a real gesture and the text box keeps focus afterwards
    layer.addEventListener("click", (e) => { if (e.target === layer) { if (tool) place(idx, e); else select(null); } });
    pageEls.push({ wrap, layer });
    scroller.append(wrap);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: page.getViewport({ scale: scale * dpr }) }).promise;
  }
  window.addEventListener("resize", onResize);
  function onResize() { if (!root.isConnected) { window.removeEventListener("resize", onResize); return; } for (const it of items) paint(it); }

  // ----- finishing -----
  async function finish() {
    err.textContent = "";
    if (!items.some((i) => i.type === "sig")) { status.textContent = "Add your signature first: tap “Sign here”, then tap the page."; status.classList.add("warn"); setTimeout(() => status.classList.remove("warn"), 2500); return; }
    select(null);
    const nameIn = el("input", { type: "text", id: "ed-name", value: defaultName || "", autocomplete: "name", maxLength: 120 });
    const agree = el("input", { type: "checkbox", id: "ed-agree" });
    const go = el("button", { class: "btn", type: "submit" }, "Sign and send");
    const e2 = el("div", { class: "err", role: "alert" });
    const box = el("form", { class: "card modal stack", style: "max-width:480px", novalidate: true, role: "dialog", "aria-modal": "true", "aria-label": "Confirm signing", onsubmit: async (ev) => {
      ev.preventDefault(); e2.textContent = "";
      if (nameIn.value.trim().length < 2) { e2.textContent = "Please type your full name."; return; }
      if (!agree.checked) { e2.textContent = "Please tick the box to confirm."; return; }
      go.disabled = true; go.textContent = "Signing…";
      try {
        const out = await buildSignedPdf({ bytes, items, pageEls, name: nameIn.value.trim(), filename });
        await onComplete({ bytes: out, name: nameIn.value.trim(), agree: true });
        box.replaceChildren(
          el("h2", {}, "Signed ✓"), el("p", { style: "margin:0" }, "Thank you. A signed copy has been sent. You can keep one for yourself:"),
          el("div", { class: "row" },
            el("button", { class: "btn", type: "button", onclick: () => saveFile(out, baseName(filename) + " - signed.pdf", "application/pdf") }, "Download signed PDF"),
            el("button", { class: "btn ghost", type: "button", onclick: () => { bg.remove(); closeAll(); } }, "Close")));
      } catch (x) { e2.textContent = x.message || "Something went wrong. Please try again."; go.disabled = false; go.textContent = "Sign and send"; }
    } },
      el("h2", {}, "Sign and send"),
      el("p", { class: "hint", style: "margin:0" }, "Your filled-in document is combined into one PDF with a signature page, and sent back. The original stays untouched."),
      el("div", {}, el("label", { for: "ed-name" }, "Your full name"), nameIn),
      el("label", { class: "check", for: "ed-agree" }, agree, "I agree that my typed name and the signature I added are my electronic signature on this document."),
      e2, el("div", { class: "row" }, go, el("button", { class: "btn ghost", type: "button", onclick: () => bg.remove() }, "Back")));
    const bg = el("div", { class: "modal-bg ed-top" }, box);
    document.body.append(bg); nameIn.focus();
  }
}

// Combine the original PDF with everything the person added, then append a signature page.
async function buildSignedPdf({ bytes, items, pageEls, name, filename }) {
  const { PDFDocument, StandardFonts, rgb } = await pdfLib();
  let doc;
  try { doc = await PDFDocument.load(bytes); }
  catch { throw new Error("This PDF is protected or damaged, so it can't be signed here."); }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0x1b / 255, 0x2a / 255, 0x6b / 255);
  const pages = doc.getPages();
  const textPng = async (text, px) => { // text a standard PDF font can't draw (accents beyond Latin, other scripts) becomes a picture
    const c = document.createElement("canvas"), g = c.getContext("2d"), S = 3;
    g.font = `${px * S}px Helvetica, Arial, sans-serif`; c.width = Math.ceil(g.measureText(text).width) + 4; c.height = Math.ceil(px * S * 1.4);
    g.font = `${px * S}px Helvetica, Arial, sans-serif`; g.fillStyle = INK; g.textBaseline = "alphabetic"; g.fillText(text, 2, px * S);
    return { img: await doc.embedPng(c.toDataURL("image/png")), w: c.width / S, h: c.height / S };
  };
  for (const it of items) {
    const page = pages[it.page];
    const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    const W = box.width, H = box.height;
    const left = box.x + it.x * W, topFromBottom = (y) => box.y + H - y;
    if (it.type === "text" && it.text.trim()) {
      const fs = it.fs * W, baseY = topFromBottom(it.y * H + fs * 1.0);
      let encodable = true;
      try { font.encodeText(it.text); } catch { encodable = false; }
      if (encodable) page.drawText(it.text, { x: left, y: baseY, size: fs, font, color: ink });
      else { const t = await textPng(it.text, fs); page.drawImage(t.img, { x: left, y: baseY - fs * 0.28, width: t.w, height: t.h }); }
    } else if (it.type === "tick") {
      const s = it.fs * W, y0 = it.y * H, pt = (u, v) => ({ x: left + u * s, y: topFromBottom(y0 + v * s) });
      const a = pt(0.15, 0.55), b = pt(0.4, 0.8), c2 = pt(0.85, 0.2);
      page.drawLine({ start: a, end: b, thickness: s * 0.12, color: ink, lineCap: 1 });
      page.drawLine({ start: b, end: c2, thickness: s * 0.12, color: ink, lineCap: 1 });
    } else if (it.type === "sig") {
      const img = await doc.embedPng(it.url), w = it.w * W, h = w * it.ratio;
      page.drawImage(img, { x: left, y: topFromBottom(it.y * H + h), width: w, height: h });
    }
  }
  // signature page
  const origHash = await sha256Hex(bytes), when = new Date();
  const cert = doc.addPage([595.28, 841.89]);
  let y = 780;
  const line = (t, o = {}) => { cert.drawText(t, { x: 56, y, size: o.size || 11, font: o.bold ? bold : font, color: o.color || rgb(0.1, 0.1, 0.15) }); y -= o.gap || 18; };
  const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, "?");
  line("Signature page", { size: 22, bold: true, gap: 34 });
  line("Document: " + ascii(baseName(filename)) + ".pdf");
  line("Signed by: " + ascii(name));
  line("Date and time: " + when.toISOString().replace("T", " ").slice(0, 19) + " UTC (from the signer's device)");
  line("Fields completed: " + items.filter((i) => i.type !== "text" || i.text.trim()).length, { gap: 28 });
  line("Original document fingerprint (SHA-256):", { bold: true, gap: 16 });
  line(origHash.slice(0, 64), { size: 9, gap: 28 });
  line("This document was completed and signed electronically using Clientword. The signer typed their name", { size: 9.5, color: rgb(0.35, 0.37, 0.42), gap: 14 });
  line("and confirmed agreement before signing. Clientword also records the time, network address and the", { size: 9.5, color: rgb(0.35, 0.37, 0.42), gap: 14 });
  line("fingerprints of the original and signed files on its servers.", { size: 9.5, color: rgb(0.35, 0.37, 0.42) });
  return doc.save();
}
