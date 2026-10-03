// ==UserScript==
// @updateURL    https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @downloadURL  https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @name         VN Quick Save + Route Guide (fatestaynight.vnovel.org)
// @namespace    https://github.com/YOUR-USERNAME/vn-quick-save
// @version      3.1
// @description  S = save menu, L = load menu (6 slots + auto-save). Position display, route guide on choice screens (H hides it), intro video when idle.
// @match        https://fatestaynight.vnovel.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Storage adapter: Tampermonkey / Violentmonkey
const store = {
  get(key, def, cb) { cb(GM_getValue(key, def)); },
  set(key, val) { GM_setValue(key, val); }
};

// ---- Settings: change the keys here ----
const SAVE_KEY = "s";
const LOAD_KEY = "l";
const GUIDE_KEY = "h"; // hides/shows the route guide
const SLOTS = 6;

// Intro video (pops up when the page stays unchanged for a while)
const IDLE_FIRST_MS = 25000;  // page unchanged for this long -> a video's first showing
const IDLE_REPEAT_MS = 40000; // once a video was watched, this long before it shows again
const CLOSE_WHEN_ENDED = true; // close the window by itself when the video finishes
const VIDEO_BASE = "https://dalavz.github.io/FSNBrowserPlus/videos/";
const VIDEOS = {
  fate: VIDEO_BASE + "fate.mp4",
  ubw: VIDEO_BASE + "ubw.mp4",
  hf: VIDEO_BASE + "heavens-feel.mp4"
};
// ----------------------------------------

const ORIGIN = location.origin;
const IS_TOUCH = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
const AUTO_COLOR = "#c13cff"; // bright purple for the auto-save slot
const COLS = "18px minmax(0, 1.5fr) minmax(0, 1fr) 36px 36px";
const THEMES = {
  save: { border: "#b00000", title: "#ff5a5a", row: "rgba(255,255,255,0.06)" },
  load: { border: "#1e6fff", title: "#6fb0ff", row: "rgba(60,130,255,0.14)" }
};

let menu = null;
let mode = null;          // "save" | "load" | null
let pending = null;       // slot index waiting for overwrite confirmation
let pendingImport = null; // decoded save code waiting for import confirmation
let view = null;          // null | "export" | "import" (the save-code screens)
let importDraft = "";     // text typed or pasted in the import box

// ---------- small helpers ----------
function el(tag, styles, text) {
  const e = document.createElement(tag);
  Object.assign(e.style, styles || {});
  if (text !== undefined) e.textContent = text;
  return e;
}

function toast(msg) {
  const t = el("div", {
    position: "fixed", top: "16px", right: "16px", zIndex: 2147483647,
    background: "rgba(0,0,0,0.85)", color: "#fff", padding: "10px 16px",
    borderRadius: "6px", font: "14px sans-serif", pointerEvents: "none"
  }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

// Keeps clicks/taps on our own UI from reaching the game underneath.
function swallowEvents(node) {
  ["click", "mousedown", "mouseup", "touchstart", "touchend", "pointerdown", "pointerup"]
    .forEach((type) => node.addEventListener(type, (ev) => ev.stopPropagation()));
}

function button(label, bg, fn, extra) {
  const b = el("div", Object.assign({
    textAlign: "center", padding: "7px 10px", borderRadius: "4px",
    cursor: "pointer", background: bg, fontWeight: "bold"
  }, extra || {}), label);
  b.addEventListener("click", fn);
  return b;
}

// ---------- link parsing ----------
function titleCase(str) {
  return str.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// /fate/3rd-day/0#page91  ->  Route "Fate", Scene "3rd Day", Part "0", Page "91"
function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { route: url, scene: "–", part: "–", page: "–" }; }
  const seg = u.pathname.split("/").filter(Boolean).map((x) => {
    try { return decodeURIComponent(x); } catch { return x; }
  });
  const m = u.hash.match(/(\d+)/);
  return {
    route: seg[0] ? titleCase(seg[0]) : "–",
    scene: seg[1] ? titleCase(seg[1]) : "–",
    part: seg[2] !== undefined ? seg[2] : "–",
    page: m ? m[1] : "–"
  };
}

function prettyLabel(url) {
  const p = parseUrl(url);
  const out = [];
  if (p.route !== "–") out.push(p.route);
  if (p.scene !== "–") out.push(p.scene);
  if (p.part !== "–") out.push("Part " + p.part);
  if (p.page !== "–") out.push("Page " + p.page);
  return out.join(" \u00b7 ") || url;
}

// "fate/3rd-day/0": route + scene + part. Changes when you move to a new part
// (a new scene or route also changes it). The page number is ignored.
function sceneKey() {
  try {
    const seg = new URL(location.href).pathname.split("/").filter(Boolean);
    return seg.length >= 2 ? seg.slice(0, 3).join("/") : null;
  } catch { return null; }
}

// Only links on this same site may be loaded (protects against tampered save files).
function isSafeUrl(url) {
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
}

// ---------- storage ----------
function getData(cb) {
  store.get("fsnSlots", null, (slots) => {
    if (!Array.isArray(slots)) slots = [];
    slots = slots.slice(0, SLOTS);
    while (slots.length < SLOTS) slots.push(null);
    store.get("fsnAuto", null, (auto) => cb(slots, auto || null));
  });
}

function refresh(message) {
  getData((slots, auto) => renderMenu(slots, auto, message));
}

// ---------- menu ----------
function closeMenu() {
  if (menu) menu.remove();
  menu = null;
  mode = null;
  pending = null;
  pendingImport = null;
  view = null;
  importDraft = "";
}

// Saving is only allowed inside a scene (not on the main menu or other non-scene pages).
function canSave() {
  return sceneKey() !== null;
}

function openMenu(newMode) {
  if (newMode === "save" && !canSave()) {
    toast("Saving is disabled on the main menu.");
    return;
  }
  mode = newMode;
  pending = null;
  pendingImport = null;
  view = null;
  refresh();
}

function makeRow(label, slot, extra, onClick) {
  const theme = THEMES[mode] || THEMES.save;
  const row = el("div", Object.assign({
    display: "grid", gridTemplateColumns: COLS, gap: "8px", padding: "7px 6px",
    cursor: "pointer", borderRadius: "4px", background: theme.row, marginBottom: "4px"
  }, extra || {}));
  row.appendChild(el("span", { fontWeight: "bold" }, label));
  if (slot) {
    const p = parseUrl(slot.url);
    row.appendChild(el("span", {}, p.route));
    row.appendChild(el("span", {}, p.scene));
    row.appendChild(el("span", {}, p.part));
    row.appendChild(el("span", {}, p.page));
  } else {
    row.appendChild(el("span", { color: "#888", gridColumn: "2 / 6" }, "Empty"));
  }
  row.addEventListener("click", onClick);
  return row;
}

function renderMenu(slots, auto, message) {
  if (menu) menu.remove();
  if (mode === "save" && !canSave()) mode = "load";
  const theme = THEMES[mode] || THEMES.save;
  menu = el("div", {
    position: "fixed", top: "16px", right: "16px", zIndex: 2147483647,
    background: "rgba(15,15,15,0.94)", color: "#fff", padding: "12px 14px",
    borderRadius: "8px", font: "14px sans-serif", boxSizing: "border-box",
    width: "min(350px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)",
    overflowY: "auto", boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
    border: "1px solid " + theme.border
  });
  swallowEvents(menu);

  // ----- overwrite confirmation -----
  if (pending !== null && slots[pending]) {
    const i = pending;
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "8px", color: theme.title }, "Replace slot " + (i + 1) + "?"));
    menu.appendChild(el("div", { fontSize: "12px", color: "#aaa" }, "Current:"));
    menu.appendChild(el("div", { marginBottom: "6px" }, prettyLabel(slots[i].url)));
    menu.appendChild(el("div", { fontSize: "12px", color: "#aaa" }, "New:"));
    menu.appendChild(el("div", { marginBottom: "8px" }, prettyLabel(location.href)));
    menu.appendChild(el("div", { color: "#ffb35a", fontSize: "12px", marginBottom: "8px" }, "The old save will be deleted."));
    const btns = el("div", { display: "flex", gap: "8px" });
    btns.appendChild(button("Yes (Y)", "#b00000", confirmYes, { flex: "1" }));
    btns.appendChild(button("No (N)", "#444", cancelConfirm, { flex: "1" }));
    menu.appendChild(btns);
    document.body.appendChild(menu);
    return;
  }

  // ----- import confirmation -----
  if (pendingImport) {
    const n = pendingImport.slots.filter(Boolean).length;
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "8px", color: theme.title }, "Import saves?"));
    menu.appendChild(el("div", { marginBottom: "6px" },
      "The code has " + n + " slot save" + (n === 1 ? "" : "s") + (pendingImport.auto ? " and an auto-save." : ".")));
    menu.appendChild(el("div", { color: "#ffb35a", fontSize: "12px", marginBottom: "8px" },
      "This replaces ALL your current saves, including the auto-save."));
    const btns = el("div", { display: "flex", gap: "8px" });
    btns.appendChild(button("Yes (Y)", "#b00000", confirmYes, { flex: "1" }));
    btns.appendChild(button("No (N)", "#444", cancelConfirm, { flex: "1" }));
    menu.appendChild(btns);
    document.body.appendChild(menu);
    return;
  }

  // ----- export code screen -----
  if (view === "export") {
    const code = encodeSaves(slots, auto);
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "6px", color: theme.title }, "Your save code"));
    menu.appendChild(el("div", { fontSize: "12px", color: "#aaa", marginBottom: "8px" },
      "Copy it, then paste it into \"Import code\" on another device. It holds your auto-save and slots 1-" + SLOTS + "."));
    const ta = codeBox(code, true);
    menu.appendChild(ta);
    if (message) menu.appendChild(el("div", { marginTop: "6px", color: "#ffb35a", fontSize: "12px" }, message));
    const btns = el("div", { display: "flex", gap: "8px", marginTop: "8px" });
    btns.appendChild(button("Copy", theme.border, () => {
      copyText(code, ta, (ok) => refresh(ok ? "Copied \u2714" : "Couldn't copy. Select the code and copy it manually."));
    }, { flex: "1" }));
    btns.appendChild(button("Back", "#444", () => { view = null; refresh(); }, { flex: "1" }));
    menu.appendChild(btns);
    document.body.appendChild(menu);
    return;
  }

  // ----- import code screen -----
  if (view === "import") {
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "6px", color: theme.title }, "Import a save code"));
    menu.appendChild(el("div", { fontSize: "12px", color: "#aaa", marginBottom: "8px" },
      "Paste a code you exported from this script."));
    const ta = codeBox(importDraft, false);
    ta.placeholder = CODE_PREFIX + "...";
    ta.addEventListener("input", () => { importDraft = ta.value; });
    menu.appendChild(ta);
    if (message) menu.appendChild(el("div", { marginTop: "6px", color: "#ffb35a", fontSize: "12px" }, message));
    const btns = el("div", { display: "flex", gap: "8px", marginTop: "8px" });
    btns.appendChild(button("Import", theme.border, () => {
      importDraft = ta.value;
      const data = decodeSaves(importDraft);
      if (!data) { refresh("That code isn't valid. Make sure it was copied completely."); return; }
      pendingImport = data;
      refresh();
    }, { flex: "1" }));
    btns.appendChild(button("Back", "#444", () => { view = null; refresh(); }, { flex: "1" }));
    menu.appendChild(btns);
    document.body.appendChild(menu);
    if (!IS_TOUCH) ta.focus();
    return;
  }

  // ----- top bar: Save / Load tabs + close -----
  const bar = el("div", { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" });
  ["save", "load"].forEach((m) => {
    const active = m === mode;
    const disabled = m === "save" && !canSave();
    const tab = el("div", {
      padding: "4px 14px", borderRadius: "14px", cursor: disabled ? "default" : "pointer", fontWeight: "bold",
      background: active ? THEMES[m].border : "rgba(255,255,255,0.08)",
      color: active ? "#fff" : "#aaa", opacity: disabled ? "0.35" : "1"
    }, m === "save" ? "Save" : "Load");
    if (disabled) tab.title = "Saving is disabled on the main menu";
    tab.addEventListener("click", () => {
      if (disabled || m === mode) return;
      mode = m; pending = null; pendingImport = null; view = null;
      refresh();
    });
    bar.appendChild(tab);
  });
  bar.appendChild(el("div", { flex: "1" }));
  const x = el("div", { cursor: "pointer", padding: "2px 8px", fontSize: "18px", color: "#aaa" }, "\u2715");
  x.addEventListener("click", closeMenu);
  bar.appendChild(x);
  menu.appendChild(bar);

  menu.appendChild(el("div", { color: theme.title, fontSize: "12px", marginBottom: "8px" },
    mode === "save"
      ? "Press 1-" + SLOTS + " or tap a slot to save"
      : "Press 0-" + SLOTS + " or tap a slot to load"));

  // ----- table -----
  const head = el("div", {
    display: "grid", gridTemplateColumns: COLS, gap: "8px", padding: "0 6px 4px",
    color: "#888", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px"
  });
  ["#", "Route", "Scene", "Part", "Page"].forEach((h) => head.appendChild(el("span", {}, h)));
  menu.appendChild(head);

  if (mode === "load") {
    menu.appendChild(el("div", {
      color: AUTO_COLOR, fontSize: "11px", textTransform: "uppercase",
      letterSpacing: "0.5px", margin: "4px 6px 5px"
    }, "Auto-save (press 0)"));
    menu.appendChild(makeRow("0", auto, {
      outline: "2px solid " + AUTO_COLOR, outlineOffset: "0px",
      background: "rgba(193,60,255,0.16)", marginBottom: "10px"
    }, chooseAuto));
  }

  slots.forEach((slot, i) => menu.appendChild(makeRow(String(i + 1), slot, null, () => chooseSlot(i))));

  if (mode === "save" && slots.every(Boolean)) {
    menu.appendChild(el("div", { marginTop: "6px", color: "#ffb35a", fontSize: "12px" },
      "All slots are full. The slot you pick will be replaced and its old save deleted."));
  }
  if (message) {
    menu.appendChild(el("div", { marginTop: "6px", color: "#ffb35a", fontSize: "12px" }, message));
  }

  // ----- footer buttons (click only) -----
  const foot = el("div", { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" });
  const chip = { flex: "1 1 45%", fontWeight: "normal", fontSize: "12px", padding: "7px 4px" };
  const chipBg = "rgba(255,255,255,0.12)";
  foot.appendChild(button("Export code", chipBg, () => { view = "export"; refresh(); }, chip));
  foot.appendChild(button("Import code", chipBg, () => { view = "import"; importDraft = ""; refresh(); }, chip));
  foot.appendChild(button(guideHidden ? "Show guide" : "Hide guide", chipBg, () => { toggleGuide(true); refresh(); }, chip));
  foot.appendChild(button(hudHidden ? "Show position" : "Hide position", chipBg, () => { toggleHud(); refresh(); }, chip));
  menu.appendChild(foot);
  if (!IS_TOUCH) {
    menu.appendChild(el("div", { marginTop: "8px", color: "#888", fontSize: "11px" }, "Esc to close"));
  }
  document.body.appendChild(menu);
}

// ---------- save / load actions ----------
function doSave(slots, i) {
  if (!canSave()) {
    closeMenu();
    toast("Saving is disabled on the main menu.");
    return;
  }
  slots[i] = { url: location.href, time: Date.now() };
  store.set("fsnSlots", slots);
  closeMenu();
  toast("Saved to slot " + (i + 1) + " \u2714");
}

function loadFrom(slot, label) {
  if (!slot || !isSafeUrl(slot.url)) {
    refresh(label + " can't be loaded.");
    return;
  }
  closeMenu();
  toast("Loading " + label + "\u2026");
  location.href = slot.url;
}

function chooseSlot(i) {
  getData((slots) => {
    if (mode === "save") {
      if (slots[i]) {
        pending = i;
        renderMenu(slots, null);
        return;
      }
      doSave(slots, i);
    } else if (mode === "load") {
      if (!slots[i]) {
        refresh("Slot " + (i + 1) + " is empty.");
        return;
      }
      loadFrom(slots[i], "slot " + (i + 1));
    }
  });
}

function chooseAuto() {
  getData((slots, auto) => {
    if (mode !== "load") return;
    if (!auto) {
      refresh("No auto-save yet.");
      return;
    }
    loadFrom(auto, "auto-save");
  });
}

function confirmYes() {
  if (pendingImport) { applyImport(); return; }
  if (pending === null) return;
  const i = pending;
  getData((slots) => doSave(slots, i));
}

function cancelConfirm() {
  pending = null;
  pendingImport = null;
  refresh();
}

// ---------- save codes (export / import) ----------
// A code looks like FSN1-<scrambled text>. It holds the auto-save + slots 1..SLOTS as
// compact numbers (route, day, part, page), plus a checksum so typos/half-copies are rejected.
// Only the part of each link after the domain is stored; the site's own address is added on import.
const CODE_PREFIX = "FSN1-";
const ENC = new TextEncoder();
const DEC = new TextDecoder("utf-8", { fatal: true });

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable.push(c >>> 0);
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function ordinalDay(n) {
  const r = n % 100;
  const suffix = r >= 11 && r <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return n + suffix + "-day";
}

function pushVarint(out, n) {
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
}

function pushString(out, str) {
  const b = ENC.encode(str);
  pushVarint(out, b.length);
  for (let i = 0; i < b.length; i++) out.push(b[i]);
}

function plainNumber(str) {
  const n = parseInt(str, 10);
  return String(n) === str && n < 268435456 ? n : null;
}

function encodeEntry(out, url) {
  const u = new URL(url);
  const path = u.pathname + u.search + u.hash;
  const m = path.match(/^\/([^\/#?]+)\/([^\/#?]+)\/(\d+)#page(\d+)$/);
  const part = m ? plainNumber(m[3]) : null;
  const page = m ? plainNumber(m[4]) : null;
  if (m && part !== null && page !== null) {
    const route = m[1], scene = m[2];
    const dm = scene.match(/^(\d+)(?:st|nd|rd|th)-day$/);
    const dayNum = dm ? plainNumber(dm[1]) : null;
    const day = dayNum !== null && ordinalDay(dayNum) === scene ? dayNum : null;
    let flags = 0;
    if (route !== "fate") flags |= 2;
    if (day === null) flags |= 4;
    out.push(flags);
    if (flags & 2) pushString(out, route);
    if (day === null) pushString(out, scene); else pushVarint(out, day);
    pushVarint(out, part);
    pushVarint(out, page);
  } else {
    out.push(1);
    pushString(out, path);
  }
}

function toB64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(str) {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = [];
  for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i));
  return bytes;
}

function encodeSaves(slots, auto) {
  const entries = [auto];
  for (let i = 0; i < SLOTS; i++) entries.push(slots[i] || null);
  const mask = new Array(Math.ceil(entries.length / 8)).fill(0);
  const body = [];
  entries.forEach((e, i) => {
    if (e && isSafeUrl(e.url)) {
      mask[i >> 3] |= 1 << (i & 7);
      encodeEntry(body, e.url);
    }
  });
  const payload = mask.concat(body);
  const c = crc32(payload);
  return CODE_PREFIX + toB64Url(payload.concat([c & 255, (c >>> 8) & 255, (c >>> 16) & 255]));
}

// Returns { slots, auto } or null if the code is damaged or not a save code.
function decodeSaves(text) {
  try {
    const t = String(text).replace(/\s+/g, "");
    if (!t.startsWith(CODE_PREFIX)) return null;
    const bytes = fromB64Url(t.slice(CODE_PREFIX.length));
    const maskBytes = Math.ceil((SLOTS + 1) / 8);
    if (!bytes || bytes.length < maskBytes + 3) return null;
    const payload = bytes.slice(0, bytes.length - 3);
    const n = bytes.length;
    const got = bytes[n - 3] | (bytes[n - 2] << 8) | (bytes[n - 1] << 16);
    if ((crc32(payload) & 0xffffff) !== got) return null;

    let pos = maskBytes;
    const readByte = () => {
      if (pos >= payload.length) throw new Error("end");
      return payload[pos++];
    };
    const readVarint = () => {
      let v = 0, mul = 1, b;
      do {
        b = readByte();
        v += (b & 127) * mul;
        mul *= 128;
        if (mul > 34359738368) throw new Error("big");
      } while (b & 128);
      return v;
    };
    const readString = () => {
      const len = readVarint();
      if (pos + len > payload.length) throw new Error("end");
      const str = DEC.decode(Uint8Array.from(payload.slice(pos, pos + len)));
      pos += len;
      return str;
    };

    for (let i = SLOTS + 1; i < maskBytes * 8; i++) {
      if (payload[i >> 3] & (1 << (i & 7))) return null;
    }
    const out = [];
    for (let i = 0; i <= SLOTS; i++) {
      if (!(payload[i >> 3] & (1 << (i & 7)))) { out.push(null); continue; }
      const f = readByte();
      if (f & ~7) return null;
      let path;
      if (f & 1) {
        path = readString();
      } else {
        const route = f & 2 ? readString() : "fate";
        const scene = f & 4 ? readString() : ordinalDay(readVarint());
        const part = readVarint();
        const page = readVarint();
        path = "/" + route + "/" + scene + "/" + part + "#page" + page;
      }
      if (path[0] !== "/") return null;
      const url = ORIGIN + path;
      if (!isSafeUrl(url)) return null;
      out.push({ url, time: 0 });
    }
    if (pos !== payload.length) return null;
    return { auto: out[0], slots: out.slice(1) };
  } catch { return null; }
}

function codeBox(value, readOnly) {
  const ta = el("textarea", {
    width: "100%", boxSizing: "border-box", height: "92px", resize: "none",
    background: "#111", color: "#fff", border: "1px solid #555", borderRadius: "4px",
    padding: "6px", font: "13px monospace"
  });
  ta.value = value;
  ta.readOnly = !!readOnly;
  ta.spellcheck = false;
  ta.autocapitalize = "off";
  ta.setAttribute("autocomplete", "off");
  // typing in the box must not trigger the game's own key shortcuts
  ["keydown", "keyup", "keypress"].forEach((t) => ta.addEventListener(t, (ev) => ev.stopPropagation()));
  if (readOnly) ta.addEventListener("focus", () => ta.select());
  return ta;
}

function copyText(text, ta, done) {
  const fallback = () => {
    try {
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      done(!!document.execCommand("copy"));
    } catch { done(false); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), fallback);
  } else {
    fallback();
  }
}

function applyImport() {
  if (!pendingImport) return;
  const d = pendingImport;
  store.set("fsnSlots", d.slots);
  store.set("fsnAuto", d.auto);
  const n = d.slots.filter(Boolean).length + (d.auto ? 1 : 0);
  closeMenu();
  toast("Imported " + n + " save" + (n === 1 ? "" : "s") + " \u2714");
}

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const key = e.key.toLowerCase();
  const swallow = () => { e.preventDefault(); e.stopPropagation(); };

  if (videoBox) {
    // while the intro video is open, keys don't reach the game; Esc closes it
    swallow();
    if (key === "escape") closeVideo();
    return;
  }

  if (menu) {
    if (view && pending === null && !pendingImport) {
      // on the save-code screens, typing goes to the text box; Esc goes back
      if (key === "escape") { swallow(); view = null; refresh(); }
      return;
    }
    if (pending !== null || pendingImport) {
      if (key === "y" || key === "enter") { swallow(); confirmYes(); }
      else if (key === "n" || key === "escape") { swallow(); cancelConfirm(); }
      else if (/^[0-9]$/.test(key) || key === SAVE_KEY || key === LOAD_KEY) swallow();
      return;
    }
    const n = parseInt(key, 10);
    if (n >= 1 && n <= SLOTS) {
      swallow();
      chooseSlot(n - 1);
    } else if (key === "0" && mode === "load") {
      swallow();
      chooseAuto();
    } else if (key === "escape") {
      swallow();
      closeMenu();
    } else if (key === SAVE_KEY || key === LOAD_KEY) {
      swallow();
      const wanted = key === SAVE_KEY ? "save" : "load";
      if (wanted === mode) closeMenu(); else openMenu(wanted);
    }
    return;
  }

  if (isTyping(e)) return;
  if (key === SAVE_KEY) openMenu("save");
  else if (key === LOAD_KEY) openMenu("load");
  else if (key === GUIDE_KEY) toggleGuide(false);
}, true);

// ---------- phone/tablet: small button to open the menu (no S/L keys there) ----------
if (IS_TOUCH && document.body) {
  const fab = el("div", {
    position: "fixed", left: "16px", bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
    zIndex: 2147483645, width: "40px", height: "40px", borderRadius: "50%",
    background: "rgba(15,15,15,0.7)", color: "#fff", font: "18px sans-serif",
    display: "flex", alignItems: "center", justifyContent: "center",
    border: "1px solid rgba(255,255,255,0.3)", opacity: "0.6", cursor: "pointer"
  }, "\u2630");
  swallowEvents(fab);
  fab.addEventListener("click", () => { if (menu) closeMenu(); else openMenu("load"); });
  document.body.appendChild(fab);
}

// ================= Auto-save =================
// Saves automatically when the part changes (e.g. 3rd day part 0 -> part 1, or 3rd day -> 4th day).
// Page changes inside a part don't count. It never runs on page load, so loading an old save doesn't overwrite the auto-save.
let lastScene = sceneKey();

function watchScene() {
  const key = sceneKey();
  if (key === lastScene) return;
  lastScene = key;
  if (!key) return;
  setTimeout(() => {
    if (sceneKey() === key) {
      store.set("fsnAuto", { url: location.href, time: Date.now() });
    }
  }, 500);
}

// ================= Intro video =================
// If the page stays unchanged for a while (25 s the first time, 40 s once a video was
// watched), a big window plays the intro video of the current route (the main page plays
// the Fate one). The countdown restarts after the window closes. No controls: just an X (or Esc) to close it.
// ----- silence the VN's own music while a video plays -----
// Mutes <audio>/<video> elements of the page (including ones the page created with
// new Audio() and played after this script loaded) and Howler.js if the page uses it.
const PAGE_WIN = (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : window;
const knownMedia = new Set(); // media elements the page has played
let duckedMedia = new Map();  // element -> its muted state before we silenced it
let howlerWasMuted = null;

try {
  const proto = PAGE_WIN.HTMLMediaElement && PAGE_WIN.HTMLMediaElement.prototype;
  if (proto && !proto.__vnqsHooked) {
    const origPlay = proto.play;
    proto.play = function () {
      try { knownMedia.add(this); } catch (err) { /* ignore */ }
      return origPlay.apply(this, arguments);
    };
    proto.__vnqsHooked = true;
  }
} catch (err) { /* ignore */ }

function duckPageAudio() {
  let media = 0;
  const all = new Set(knownMedia);
  document.querySelectorAll("audio, video").forEach((m) => all.add(m));
  all.forEach((m) => {
    if (m === videoEl || duckedMedia.has(m)) return;
    try { duckedMedia.set(m, m.muted); m.muted = true; media++; } catch (err) { /* ignore */ }
  });
  let howler = false;
  try {
    const H = PAGE_WIN.Howler;
    if (H && typeof H.mute === "function") {
      howler = true;
      if (howlerWasMuted === null) { howlerWasMuted = !!H._muted; H.mute(true); }
    }
  } catch (err) { /* ignore */ }
  return { media, howler };
}

function restorePageAudio() {
  duckedMedia.forEach((was, m) => { try { m.muted = was; } catch (err) { /* ignore */ } });
  duckedMedia = new Map();
  try {
    if (howlerWasMuted !== null) PAGE_WIN.Howler.mute(howlerWasMuted);
  } catch (err) { /* ignore */ }
  howlerWasMuted = null;
}

let videoBox = null;     // full-screen backdrop while a video is open
let videoInner = null;   // the video window itself
let videoEl = null;
let videoRatio = 16 / 9;
let seenRoutes = {};
const failedRoutes = {};
let idleKey = null;
let idleSince = Date.now();

store.get("fsnVideosSeen", {}, (v) => {
  seenRoutes = v && typeof v === "object" ? v : {};
});

// Which route's video belongs to the current page: "fate", "ubw", "hf" or null.
function routeKind() {
  const seg = location.pathname.split("/").filter(Boolean);
  if (seg.length === 0) return "fate"; // the main page plays the Fate intro
  if (seg.length < 2) return null;
  const r = seg[0].toLowerCase();
  if (r === "fate") return "fate";
  if (/ubw|unlimited|blade/.test(r)) return "ubw";
  if (/heaven|hf|feel/.test(r)) return "hf";
  return null;
}

function layoutVideo() {
  if (!videoBox) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rotate = IS_TOUCH && vh > vw; // phone held upright: show the video sideways
  const availW = (rotate ? vh : vw) * 0.94;
  const availH = (rotate ? vw : vh) * 0.94;
  let w = availW, h = w / videoRatio;
  if (h > availH) { h = availH; w = h * videoRatio; }
  Object.assign(videoInner.style, {
    width: Math.round(w) + "px", height: Math.round(h) + "px",
    transform: "translate(-50%, -50%)" + (rotate ? " rotate(90deg)" : "")
  });
}

function closeVideo() {
  if (!videoBox) return;
  try { videoEl.pause(); videoEl.removeAttribute("src"); videoEl.load(); } catch (err) { /* ignore */ }
  videoBox.remove();
  videoBox = null; videoInner = null; videoEl = null;
  restorePageAudio();     // the VN's music comes back
  idleSince = Date.now(); // the countdown starts over after the window closes
}

function openVideo(kind) {
  const url = VIDEOS[kind];
  if (!url || videoBox) return;

  videoBox = el("div", {
    position: "fixed", top: "0", left: "0", right: "0", bottom: "0",
    zIndex: 2147483647, background: "rgba(0,0,0,0.6)"
  });
  swallowEvents(videoBox);
  videoInner = el("div", {
    position: "absolute", top: "50%", left: "50%", background: "#000",
    borderRadius: "8px", overflow: "hidden"
  });

  const v = document.createElement("video");
  videoEl = v;
  Object.assign(v.style, { width: "100%", height: "100%", display: "block", objectFit: "contain", background: "#000" });
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("webkit-playsinline", "");
  v.controls = false;
  v.disablePictureInPicture = true;
  v.preload = "auto";
  v.addEventListener("contextmenu", (ev) => ev.preventDefault());
  videoRatio = 16 / 9;

  v.addEventListener("loadedmetadata", () => {
    if (v.videoWidth && v.videoHeight) videoRatio = v.videoWidth / v.videoHeight;
    layoutVideo();
  });
  v.addEventListener("playing", () => {
    if (!seenRoutes[kind]) {
      seenRoutes[kind] = true;
      store.set("fsnVideosSeen", seenRoutes);
    }
  });
  v.addEventListener("ended", () => { if (CLOSE_WHEN_ENDED && videoEl === v) closeVideo(); });
  v.addEventListener("error", () => {
    if (videoEl !== v) return;
    failedRoutes[kind] = true;
    closeVideo();
    toast("Intro video couldn't be loaded.");
  });

  // the X button
  const x = el("div", {
    position: "absolute", top: "8px", right: "8px", width: "36px", height: "36px",
    borderRadius: "50%", background: "rgba(0,0,0,0.55)", color: "#fff", font: "18px sans-serif",
    display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 2
  }, "\u2715");
  x.addEventListener("click", closeVideo);

  videoInner.appendChild(v);
  videoInner.appendChild(x);
  videoBox.appendChild(videoInner);
  document.body.appendChild(videoBox);
  layoutVideo();

  const ducked = duckPageAudio();
  console.log("[VN script] page audio silenced: " + ducked.media + " media element(s), Howler " + (ducked.howler ? "found" : "not found"));

  v.src = url;
  const started = v.play();
  if (started && started.catch) {
    // sound autoplay can be blocked (mostly on phones): start muted, tap the video for sound
    started.catch(() => {
      if (videoEl !== v) return;
      v.muted = true;
      const again = v.play();
      if (again && again.catch) again.catch(() => {});
      const hint = el("div", {
        position: "absolute", bottom: "8px", left: "50%", transform: "translateX(-50%)",
        background: "rgba(0,0,0,0.55)", color: "#fff", font: "12px sans-serif",
        padding: "4px 10px", borderRadius: "10px", pointerEvents: "none"
      }, "Tap for sound");
      videoInner.appendChild(hint);
      v.addEventListener("click", () => {
        v.muted = false;
        hint.remove();
        if (v.paused) v.play().catch(() => {});
      });
    });
  }
}

function tickIdle() {
  const key = location.pathname + location.hash;
  if (key !== idleKey) {          // the page changed: restart the countdown
    idleKey = key;
    idleSince = Date.now();
    if (videoBox) closeVideo();
    return;
  }
  if (videoBox) { duckPageAudio(); return; } // also silences music that starts during the video
  if (menu || document.visibilityState !== "visible") { idleSince = Date.now(); return; }
  const kind = routeKind();
  if (!kind || failedRoutes[kind]) return;
  const wait = seenRoutes[kind] ? IDLE_REPEAT_MS : IDLE_FIRST_MS;
  if (Date.now() - idleSince < wait) return;
  openVideo(kind);
}

window.addEventListener("resize", layoutVideo);
window.addEventListener("orientationchange", layoutVideo);
document.addEventListener("visibilitychange", () => { idleSince = Date.now(); });

// ================= Position display (top left) =================
// A faint, always-visible box that shows Route / Scene / Part / Page and updates as you move.
// Computers: top left, with the route guide under it. Phones: bottom right (the menu button is
// bottom left), with the route guide stacked above it.
const HUD_FONT_PX = IS_TOUCH ? 13 : 17;  // size of the position display (bigger on computers)
const HUD_LABEL_PX = IS_TOUCH ? 10 : 12; // size of the small Route/Scene/Part/Page labels
let stackBox = null;
let hudBox = null;
let hudHidden = false;
let hudReady = false;
let lastHudKey = null;

function getStack() {
  if (!stackBox || !stackBox.isConnected) {
    stackBox = el("div", Object.assign({
      position: "fixed", zIndex: 2147483646, display: "flex", gap: "12px",
      maxWidth: "calc(100vw - 32px)", pointerEvents: "none"
    }, IS_TOUCH
      ? { right: "16px", bottom: "calc(16px + env(safe-area-inset-bottom, 0px))", flexDirection: "column-reverse", alignItems: "flex-end" }
      : { top: "16px", left: "16px", flexDirection: "column", alignItems: "flex-start" }));
    document.body.appendChild(stackBox);
  }
  return stackBox;
}

function fillHud() {
  hudBox.textContent = "";
  const segs = location.pathname.split("/").filter(Boolean);
  if (segs.length === 0) {
    hudBox.appendChild(el("span", { fontWeight: "bold" }, "Main menu"));
  } else {
    const p = parseUrl(location.href);
    const grid = el("div", {
      display: "grid", gridTemplateColumns: "auto auto auto auto",
      columnGap: Math.round(HUD_FONT_PX * 0.9) + "px", rowGap: "2px"
    });
    ["Route", "Scene", "Part", "Page"].forEach((h) => grid.appendChild(el("span", {
      fontSize: HUD_LABEL_PX + "px", textTransform: "uppercase", letterSpacing: "0.5px", color: "rgba(255,255,255,0.6)"
    }, h)));
    [p.route, p.scene, p.part, p.page].forEach((v) => grid.appendChild(el("span", {}, v)));
    hudBox.appendChild(grid);
  }
  const x = el("span", {
    cursor: "pointer", padding: "4px 6px", fontSize: HUD_FONT_PX + "px", color: "rgba(255,255,255,0.7)",
    pointerEvents: "auto", alignSelf: "flex-start"
  }, "\u2715");
  x.addEventListener("click", () => toggleHud());
  hudBox.appendChild(x);
}

function updateHud(force) {
  if (!hudReady || !document.body) return;
  if (hudHidden) {
    if (hudBox) { hudBox.remove(); hudBox = null; }
    lastHudKey = null;
    return;
  }
  if (hudBox && !hudBox.isConnected) hudBox = null;
  const key = location.pathname + location.hash;
  if (!force && key === lastHudKey && hudBox) return;
  lastHudKey = key;
  if (!hudBox) {
    hudBox = el("div", {
      display: "flex", alignItems: "center", gap: "8px", background: "rgba(0,0,0,0.28)",
      color: "#fff", padding: Math.round(HUD_FONT_PX * 0.5) + "px 6px " + Math.round(HUD_FONT_PX * 0.5) + "px " + Math.round(HUD_FONT_PX * 0.8) + "px",
      borderRadius: "6px", font: HUD_FONT_PX + "px sans-serif", textShadow: "0 0 3px rgba(0,0,0,0.8)", pointerEvents: "none"
    });
    swallowEvents(hudBox);
    const stack = getStack();
    stack.insertBefore(hudBox, stack.firstChild);
  }
  fillHud();
}

function toggleHud() {
  hudHidden = !hudHidden;
  store.set("fsnHudHidden", hudHidden);
  updateHud(true);
}

store.get("fsnHudHidden", false, (v) => {
  hudHidden = !!v;
  hudReady = true;
  updateHud(true);
});

// ================= Route guide =================
// Key = path + #hash of the page where a choice appears.
const GUIDES = {
  "/fate/3rd-day/0#page91": {
    title: "Choice",
    rows: [
      ["Stop her", "UBW route"],
      ["Don't stop her", "Fate route"]
    ],
    note: "Ignore the two Continue buttons: they lead to the same route as \"Don't stop her\" (Fate)."
  },
  "/fate/3rd-day/7#page13": {
    title: "Route choice",
    rows: [
      ["Top Continue", "Heaven's Feel"],
      ["Bottom Continue", "Fate"]
    ]
  },
  "/fate/4th-day/4#page23": {
    title: "Choice",
    rows: [
      ["All right. Let's cooperate", "Fate route"],
      ["I'm sorry but I can't", "UBW route"]
    ],
    note: "Going to UBW from here means you will have missed the Day 3 UBW events."
  }
};

let guideBox = null;
let guideHidden = false;
let lastGuideKey = null;

function currentGuideKey() {
  return location.pathname.replace(/\/+$/, "") + location.hash;
}

function updateGuide(force) {
  const key = currentGuideKey();
  if (!force && key === lastGuideKey) return;
  lastGuideKey = key;
  if (guideBox) { guideBox.remove(); guideBox = null; }

  const g = GUIDES[key];
  if (!g || guideHidden || !document.body) return;

  guideBox = el("div", {
    background: "rgba(15,15,15,0.94)", color: "#fff", padding: "12px 14px",
    font: "16px sans-serif", maxWidth: "min(300px, 80vw)", boxSizing: "border-box",
    borderRadius: "8px", boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
    border: "1px solid #e0a800", pointerEvents: "none"
  });
  guideBox.appendChild(el("div", { fontWeight: "bold", fontSize: "18px", marginBottom: "8px", color: "#ffd24d" }, g.title));
  g.rows.forEach(([label, route]) => {
    const row = el("div", { marginBottom: "4px" });
    row.appendChild(el("span", { fontWeight: "bold" }, label));
    row.appendChild(el("span", { color: "#ffd24d" }, "  \u2192  " + route));
    guideBox.appendChild(row);
  });
  if (g.note) {
    guideBox.appendChild(el("div", { marginTop: "8px", color: "#ffb35a", fontSize: "13px" }, g.note));
  }
  if (!IS_TOUCH) {
    guideBox.appendChild(el("div", { marginTop: "8px", color: "#888", fontSize: "12px" },
      GUIDE_KEY.toUpperCase() + " to hide the guide"));
  }
  getStack().appendChild(guideBox); // under the position display (computers) / above it (phones)
}

function toggleGuide(silent) {
  guideHidden = !guideHidden;
  store.set("fsnGuideHidden", guideHidden);
  updateGuide(true);
  if (!silent) toast(guideHidden ? "Guide hidden" : "Guide shown");
}

store.get("fsnGuideHidden", false, (v) => {
  guideHidden = !!v;
  updateGuide(true);
});

function tick() {
  updateHud(false);
  updateGuide(false); // the site is a single-page app, so we poll for changes
  watchScene();
  tickIdle();
}
window.addEventListener("hashchange", tick);
window.addEventListener("popstate", tick);
setInterval(tick, 300);
