// ==UserScript==
// @updateURL    https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @downloadURL  https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @name         VN Quick Save + Route Guide (fatestaynight.vnovel.org)
// @namespace    https://github.com/YOUR-USERNAME/vn-quick-save
// @version      2.4
// @description  S = save menu, L = load menu (6 slots + auto-save). Shows a route guide on choice screens (H hides it).
// @match        https://fatestaynight.vnovel.org/*
// @grant        GM_getValue
// @grant        GM_setValue
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
let pendingImport = null; // parsed save file waiting for import confirmation

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
}

function openMenu(newMode) {
  mode = newMode;
  pending = null;
  pendingImport = null;
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
      "The file has " + n + " slot save" + (n === 1 ? "" : "s") + (pendingImport.auto ? " and an auto-save." : ".")));
    menu.appendChild(el("div", { color: "#ffb35a", fontSize: "12px", marginBottom: "8px" },
      "This replaces ALL your current saves, including the auto-save."));
    const btns = el("div", { display: "flex", gap: "8px" });
    btns.appendChild(button("Yes (Y)", "#b00000", confirmYes, { flex: "1" }));
    btns.appendChild(button("No (N)", "#444", cancelConfirm, { flex: "1" }));
    menu.appendChild(btns);
    document.body.appendChild(menu);
    return;
  }

  // ----- top bar: Save / Load tabs + close -----
  const bar = el("div", { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" });
  ["save", "load"].forEach((m) => {
    const active = m === mode;
    const tab = el("div", {
      padding: "4px 14px", borderRadius: "14px", cursor: "pointer", fontWeight: "bold",
      background: active ? THEMES[m].border : "rgba(255,255,255,0.08)",
      color: active ? "#fff" : "#aaa"
    }, m === "save" ? "Save" : "Load");
    tab.addEventListener("click", () => {
      if (m === mode) return;
      mode = m; pending = null; pendingImport = null;
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
  const foot = el("div", { display: "flex", gap: "6px", marginTop: "10px" });
  const chip = { flex: "1", fontWeight: "normal", fontSize: "12px", padding: "7px 4px" };
  const chipBg = "rgba(255,255,255,0.12)";
  foot.appendChild(button("Export", chipBg, exportSaves, chip));
  foot.appendChild(button("Import", chipBg, importSaves, chip));
  foot.appendChild(button(guideHidden ? "Show guide" : "Hide guide", chipBg, () => { toggleGuide(true); refresh(); }, chip));
  menu.appendChild(foot);
  if (!IS_TOUCH) {
    menu.appendChild(el("div", { marginTop: "8px", color: "#888", fontSize: "11px" }, "Esc to close"));
  }
  document.body.appendChild(menu);
}

// ---------- save / load actions ----------
function doSave(slots, i) {
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

// ---------- export / import ----------
function exportSaves() {
  getData((slots, auto) => {
    const data = {
      app: "fsn-quick-save", version: 2,
      exported: new Date().toISOString(), slots, auto
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const href = URL.createObjectURL(blob);
    a.href = href;
    a.download = "fsn-saves-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 5000);
    refresh("Saves exported. Check your downloads.");
  });
}

function parseSaveFile(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || d.app !== "fsn-quick-save" || !Array.isArray(d.slots)) return null;
  const clean = (s) => (s && typeof s.url === "string" && isSafeUrl(s.url))
    ? { url: s.url, time: Number(s.time) || 0 }
    : null;
  const slots = d.slots.slice(0, SLOTS).map(clean);
  while (slots.length < SLOTS) slots.push(null);
  return { slots, auto: clean(d.auto) };
}

function importSaves() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.style.display = "none";
  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    input.remove();
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = parseSaveFile(String(reader.result));
      if (!data) { refresh("That file isn't a valid save file."); return; }
      pendingImport = data;
      pending = null;
      refresh();
    };
    reader.onerror = () => refresh("Couldn't read that file.");
    reader.readAsText(f);
  });
  document.body.appendChild(input);
  input.click();
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

  if (menu) {
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
    position: "fixed", top: "16px", left: "16px", zIndex: 2147483646,
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
  document.body.appendChild(guideBox);
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
  updateGuide(false); // the site is a single-page app, so we poll for changes
  watchScene();
}
window.addEventListener("hashchange", tick);
window.addEventListener("popstate", tick);
setInterval(tick, 300);
