// ==UserScript==
// @updateURL    https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @downloadURL  https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @name         VN Quick Save + Route Guide (fatestaynight.vnovel.org)
// @namespace    https://github.com/YOUR-USERNAME/vn-quick-save
// @version      3.32
// @description  S = save menu, L = load menu (6 slots + auto-save), G = settings. Title screen on the main page (New Game / Continue / Settings / Flowchart, can be turned off in Settings), position display with a Main menu button, checkmarks on read scenes, tiger dojos hidden on the main menu until you reach them (red = started, green = read), hides the grayed-out text and reveals new text left to right, route guide on choice screens (H hides it), intro videos (when idle on the main menu once you have completed a route, and at key moments), blue check on completed routes in the flowchart choice.
// @match        https://fatestaynight.vnovel.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      dalavz.github.io
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
const SETTINGS_KEY = "g"; // opens the Settings tab
const SLOTS = 6;
const TITLE_SCREEN = true; // false = no title screen on the main page (it can also be turned off and on in Settings)

// Intro video (pops up when the page stays unchanged for a while)
const IDLE_FIRST_MS = 25000;  // page unchanged for this long -> a video's first showing
const IDLE_REPEAT_MS = 40000; // once a video was watched, this long before it shows again
const IDLE_ON_FLOWCHARTS = true; // idle openings also play on the flowchart pages (/fate, /ubw, /hf); false = only on the main menu
const CLOSE_WHEN_ENDED = true; // close the window by itself when the video finishes
const VIDEO_BASE = "https://dalavz.github.io/FSNBrowserPlus/videos/";
// The logo shown on the title screen. Upload a PNG (transparent background works best) to this address.
// If it can't be loaded the plain text title "Fate/stay night" is shown instead. "" = always text.
const TITLE_IMAGE = "https://dalavz.github.io/FSNBrowserPlus/images/title.png";
// The title screen's background picture. It is stretched to cover any screen (cropped, never squashed).
// If it can't be loaded the dark blue gradient is used. "" = always the gradient.
const TITLE_BACKGROUND = "https://dalavz.github.io/FSNBrowserPlus/images/ta_back_fate.webp";
const VIDEOS = {
  fate: VIDEO_BASE + "fate.mp4",
  ubw: VIDEO_BASE + "ubw.mp4",
  hf: VIDEO_BASE + "heavens-feel.mp4"
};
// A route counts as COMPLETED when every scene listed here has its green checkmark (fully read).
// Completed routes (1) get their opening played when you stay idle on the main menu and (2) get a blue check
// in the main menu's flowchart choice. Paths look like the page address without the domain.
// An empty list = that route can never count as completed.
const ROUTE_DONE = {
  fate: ["/prologue/1", "/prologue/2", "/prologue/3"],
  ubw: ["/fate/1st-day/0", "/fate/15th-day/11", "/fate/15th-day/13", "/fate/15th-day/17"],
  hf: ["/ubw/3rd-day/9", "/ubw/4th-day/3", "/ubw/14th-day/9", "/ubw/14th-day/12"]
};
// ----------------------------------------

const ORIGIN = location.origin;
const IS_TOUCH = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
const AUTO_COLOR = "#c13cff"; // bright purple for the auto-save slot
const COLS = "18px minmax(0, 1.5fr) minmax(0, 1fr) 36px 36px";
const THEMES = {
  save: { border: "#b00000", title: "#ff5a5a", row: "rgba(255,255,255,0.06)" },
  load: { border: "#1e6fff", title: "#6fb0ff", row: "rgba(60,130,255,0.14)" },
  settings: { border: "#5f6672", title: "#c4c8cf", row: "rgba(255,255,255,0.06)" }
};

let menu = null;
let mode = null;          // "save" | "load" | null
let pending = null;       // slot index waiting for overwrite confirmation
let pendingImport = null; // decoded save code waiting for import confirmation
let pendingReset = false; // asking whether to clear all checkmarks
let pendingDojos = false; // asking whether to really show the (spoiler) tiger dojos
let view = null;          // null | "export" | "import" (the save-code screens)
let importDraft = "";     // text typed or pasted in the import box

// ---------- small helpers ----------
function el(tag, styles, text) {
  const e = document.createElement(tag);
  e.setAttribute("data-vnqs", "1"); // marks our own UI
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

// Hover / press feedback that works on any background (even see-through ones): a light veil on hover,
// a dark veil and a slight shrink while pressed. Mouse hover only counts for real mice, so it never sticks on phones.
function addFeedback(node) {
  const baseShadow = node.style.boxShadow || "";
  const baseBorder = node.style.borderColor || "";
  const hasBorder = !!node.style.border;
  let hover = false, down = false;
  node.style.transition = "box-shadow .12s, transform .08s, border-color .12s";
  const apply = () => {
    const veil = down ? "inset 0 0 0 100px rgba(0,0,0,0.28)"
      : hover ? "inset 0 0 0 100px rgba(255,255,255,0.18)" : "";
    node.style.boxShadow = [veil, baseShadow].filter(Boolean).join(", ");
    node.style.transform = down ? "scale(0.97)" : "";
    if (hasBorder) node.style.borderColor = (hover || down) ? "rgba(255,255,255,0.65)" : baseBorder;
  };
  node.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") { hover = true; apply(); } });
  node.addEventListener("pointerleave", () => { hover = false; down = false; apply(); });
  node.addEventListener("pointerdown", () => { down = true; apply(); });
  node.addEventListener("pointerup", () => { down = false; apply(); });
  node.addEventListener("pointercancel", () => { down = false; hover = false; apply(); });
}

function button(label, bg, fn, extra) {
  const b = el("div", Object.assign({
    textAlign: "center", padding: "7px 10px", borderRadius: "4px",
    cursor: "pointer", background: bg, fontWeight: "bold"
  }, extra || {}), label);
  addFeedback(b);
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
  pendingReset = false;
  pendingDojos = false;
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
  pendingReset = false;
  pendingDojos = false;
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

  // ----- reset checkmarks confirmation -----
  if (pendingReset) {
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "8px", color: "#ff5a5a" }, "Reset all checkmarks?"));
    menu.appendChild(el("div", { marginBottom: "6px" },
      "Every green checkmark on the main menu and your reading progress in all scenes will be cleared."));
    menu.appendChild(el("div", { color: "#ffb35a", fontSize: "12px", marginBottom: "8px" }, "This can't be undone."));
    const btns = el("div", { display: "flex", gap: "8px" });
    btns.appendChild(button("Yes, reset (Y)", "#b00000", confirmYes, { flex: "1" }));
    btns.appendChild(button("No (N)", "#444", cancelConfirm, { flex: "1" }));
    menu.appendChild(btns);
    document.body.appendChild(menu);
    return;
  }

  // ----- show tiger dojos (spoiler) confirmation -----
  if (pendingDojos) {
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "8px", color: "#ffb35a" }, "\u26a0 Spoiler warning"));
    menu.appendChild(el("div", { marginBottom: "6px" },
      "Tiger dojos stay hidden on the flowcharts until you find them yourself, because where they are gives away what is coming."));
    menu.appendChild(el("div", { color: "#ffb35a", fontSize: "12px", marginBottom: "8px" }, "Show them anyway?"));
    const btns = el("div", { display: "flex", gap: "8px" });
    btns.appendChild(button("Yes, show (Y)", "#b00000", confirmYes, { flex: "1" }));
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
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "6px", color: theme.title }, "Export saves"));
    menu.appendChild(el("div", { fontSize: "12px", color: "#aaa", marginBottom: "8px" },
      "Copy it, then paste it into \"Import saves\" on another device. It holds your auto-save and slots 1-" + SLOTS + "."));
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
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "6px", color: theme.title }, "Import saves"));
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
  ["save", "load", "settings"].forEach((m) => {
    const active = m === mode;
    const disabled = m === "save" && !canSave();
    const tab = el("div", {
      padding: "4px 14px", borderRadius: "14px", cursor: disabled ? "default" : "pointer", fontWeight: "bold",
      background: active ? THEMES[m].border : "rgba(255,255,255,0.08)",
      color: active ? "#fff" : "#aaa", opacity: disabled ? "0.35" : "1"
    }, m === "save" ? "Save" : m === "load" ? "Load" : "Settings");
    if (disabled) tab.title = "Saving is disabled on the main menu";
    tab.addEventListener("click", () => {
      if (disabled || m === mode) return;
      mode = m; pending = null; pendingImport = null; pendingReset = false; pendingDojos = false; view = null;
      refresh();
    });
    bar.appendChild(tab);
  });
  bar.appendChild(el("div", { flex: "1" }));
  const x = el("div", { cursor: "pointer", padding: "2px 8px", fontSize: "18px", color: "#aaa" }, "\u2715");
  x.addEventListener("click", closeMenu);
  bar.appendChild(x);
  menu.appendChild(bar);

  if (mode === "settings") {
    renderSettingsPage(message);
    if (!IS_TOUCH) {
      menu.appendChild(el("div", { marginTop: "10px", color: "#888", fontSize: "11px" },
        SETTINGS_KEY.toUpperCase() + " or Esc to close"));
    }
    document.body.appendChild(menu);
    return;
  }

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

  if (!IS_TOUCH) {
    menu.appendChild(el("div", { marginTop: "8px", color: "#888", fontSize: "11px" }, "Esc to close"));
  }
  document.body.appendChild(menu);
}

// All the options live in the Settings tab (click only; the guide also has its own key, H).
function renderSettingsPage(message) {
  const chipBg = "rgba(255,255,255,0.12)";
  const chip = { flex: "1 1 45%", fontWeight: "normal", fontSize: "13px", padding: "9px 6px" };
  const section = (title) => menu.appendChild(el("div", {
    color: "#8a8f98", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px", margin: "12px 0 6px"
  }, title));
  const group = () => {
    const g = el("div", { display: "flex", flexWrap: "wrap", gap: "6px" });
    menu.appendChild(g);
    return g;
  };

  section("Display and text");
  let g = group();
  g.appendChild(button(guideHidden ? "Show guide" : "Hide guide", chipBg, () => { toggleGuide(true); refresh(); }, chip));
  g.appendChild(button(hudHidden ? "Show position" : "Hide position", chipBg, () => { toggleHud(); refresh(); }, chip));
  g.appendChild(button(grayHidden ? "Show gray text" : "Hide gray text", chipBg, () => { toggleGray(); refresh(); }, chip));
  g.appendChild(button(revealOn ? "Turn off reveal" : "Turn on reveal", chipBg, () => { toggleReveal(); refresh(); }, chip));
  g.appendChild(button(showDojos ? "Hide tiger dojos" : "\u26a0 Show tiger dojos (spoilers)", chipBg, () => {
    if (showDojos) { toggleDojos(); refresh(); } else { pendingDojos = true; refresh(); }
  }, showDojos ? chip : Object.assign({}, chip, { flex: "1 1 100%", color: "#ffd08a" })));

  section("Saves");
  g = group();
  g.appendChild(button("Export saves", chipBg, () => { view = "export"; refresh(); }, chip));
  g.appendChild(button("Import saves", chipBg, () => { view = "import"; importDraft = ""; refresh(); }, chip));

  if (TITLE_SCREEN) {
    section("Main menu");
    g = group();
    g.appendChild(button(titleEnabled ? "Turn off main menu" : "Turn on main menu", chipBg, () => {
      titleEnabled = !titleEnabled;
      store.set("fsnTitleOn", titleEnabled);
      if (!titleEnabled && titleBox) closeTitle();
      if (titleEnabled && currentPath() === "/") { updateTitle(); return; } // the title screen opens right away
      refresh(titleEnabled ? "Main menu turned on. It shows on the main page." : "Main menu turned off.");
    }, Object.assign({}, chip, { flex: "1 1 100%" })));
  }

  section("Progress");
  g = group();
  g.appendChild(button("Reset checkmarks", "#8a1010", () => { pendingReset = true; refresh(); },
    Object.assign({}, chip, { flex: "1 1 100%", color: "#fff" })));

  if (message) {
    menu.appendChild(el("div", { marginTop: "8px", color: "#ffb35a", fontSize: "12px" }, message));
  }
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
  if (pendingDojos) {
    pendingDojos = false;
    toggleDojos();
    refresh("Tiger dojos are now shown.");
    return;
  }
  if (pendingReset) {
    resetProgress();
    closeMenu();
    toast("Checkmarks reset.");
    return;
  }
  if (pendingImport) { applyImport(); return; }
  if (pending === null) return;
  const i = pending;
  getData((slots) => doSave(slots, i));
}

function cancelConfirm() {
  pending = null;
  pendingImport = null;
  pendingReset = false;
  pendingDojos = false;
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

  // (while an intro video is open, blockKeysWhileVideo() below handles the keys first)

  if (menu) {
    if (view && pending === null && !pendingImport && !pendingReset && !pendingDojos) {
      // on the save-code screens, typing goes to the text box; Esc goes back
      if (key === "escape") { swallow(); view = null; refresh(); }
      return;
    }
    if (pending !== null || pendingImport || pendingReset || pendingDojos) {
      if (key === "y" || key === "enter") { swallow(); confirmYes(); }
      else if (key === "n" || key === "escape") { swallow(); cancelConfirm(); }
      else if (/^[0-9]$/.test(key) || key === SAVE_KEY || key === LOAD_KEY || key === SETTINGS_KEY) swallow();
      return;
    }
    const n = parseInt(key, 10);
    if (n >= 1 && n <= SLOTS && mode !== "settings") {
      swallow();
      chooseSlot(n - 1);
    } else if (key === "0" && mode === "load") {
      swallow();
      chooseAuto();
    } else if (key === "escape") {
      swallow();
      closeMenu();
    } else if (key === SAVE_KEY || key === LOAD_KEY || key === SETTINGS_KEY) {
      swallow();
      const wanted = key === SAVE_KEY ? "save" : key === LOAD_KEY ? "load" : "settings";
      if (wanted === mode) closeMenu(); else openMenu(wanted);
    }
    return;
  }

  if (isTyping(e)) return;
  if (key === SAVE_KEY) openMenu("save");
  else if (key === LOAD_KEY) openMenu("load");
  else if (key === SETTINGS_KEY) openMenu("settings");
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

// ---------- small "Settings" box in the top right (computers only) ----------
// On phones there is no such box: the menu button (bottom left) opens the menu, which has the
// Settings tab next to Save and Load.
if (document.body && !IS_TOUCH) {
  const settingsBox = el("div", {
    position: "fixed", top: "16px", right: "16px", zIndex: 2147483645,
    background: "rgba(0,0,0,0.35)", color: "#fff", padding: "5px 10px", borderRadius: "6px",
    font: "13px sans-serif", textAlign: "center", lineHeight: "1.25", cursor: "pointer",
    textShadow: "0 0 3px rgba(0,0,0,0.8)"
  });
  settingsBox.appendChild(el("div", { fontWeight: "bold" }, "Settings"));
  settingsBox.appendChild(el("div", { fontSize: "10px", color: "rgba(255,255,255,0.65)" },
    "press " + SETTINGS_KEY.toUpperCase()));
  swallowEvents(settingsBox);
  settingsBox.addEventListener("click", () => { if (menu && mode === "settings") closeMenu(); else openMenu("settings"); });
  document.body.appendChild(settingsBox);
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
// On the main menu pages (/, /fate, /ubw, /hf), if the page stays unchanged for a while (25 s the
// first time, 40 s once a video was watched), a big window plays the opening of a route you have completed
// (see ROUTE_DONE; nothing plays until a route is completed). Not inside scenes. The countdown restarts after
// the window closes. No controls: just an X (or Esc) to close it.
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

// The opening that plays when you stay idle on the main menu depends on which routes you have completed
// (see ROUTE_DONE at the top). Nothing plays idly until one route is completed. With several completed routes
// the openings take turns: each time one plays, the next completed route (Fate, then UBW, then HF) is next.
const IDLE_ORDER = ["fate", "ubw", "hf"];
let idleLast = null; // the route whose opening was shown last while idle
store.get("fsnIdleLast", null, (v) => { idleLast = IDLE_ORDER.includes(v) ? v : null; });

function pickIdleKind() {
  const ready = IDLE_ORDER.filter((k) => routeComplete(k) && !failedRoutes[k]);
  if (!ready.length) return null;
  const start = IDLE_ORDER.indexOf(idleLast) + 1; // 0 when nothing has played yet
  for (let i = 0; i < IDLE_ORDER.length; i++) {
    const k = IDLE_ORDER[(start + i) % IDLE_ORDER.length];
    if (ready.includes(k)) return k;
  }
  return null;
}

// Which route's video belongs to the current page: "fate", "ubw", "hf" or null.
// Works inside scenes (e.g. /ubw/4th-day/0) and on the main menu (/ = Fate, /fate, /ubw, /hf).
function routeKind() {
  const seg = location.pathname.split("/").filter(Boolean);
  if (seg.length === 0) return "fate"; // the plain main page plays the Fate intro
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

// ----- no scrolling or key presses reaching the game while a video is open -----
let scrollLock = null;

function lockScroll() {
  if (scrollLock || !document.body) return;
  const html = document.documentElement, body = document.body;
  const sbw = window.innerWidth - html.clientWidth; // width of a visible scrollbar, if any
  scrollLock = {
    htmlOverflow: html.style.overflow, htmlOverscroll: html.style.overscrollBehavior,
    bodyOverflow: body.style.overflow, bodyPadding: body.style.paddingRight
  };
  html.style.overflow = "hidden";
  html.style.overscrollBehavior = "none";
  body.style.overflow = "hidden";
  if (sbw > 0 && sbw < 60) { // keep the page from jumping sideways when the scrollbar disappears
    body.style.paddingRight = ((parseFloat(getComputedStyle(body).paddingRight) || 0) + sbw) + "px";
  }
}

function unlockScroll() {
  if (!scrollLock) return;
  const html = document.documentElement, body = document.body;
  html.style.overflow = scrollLock.htmlOverflow;
  html.style.overscrollBehavior = scrollLock.htmlOverscroll;
  body.style.overflow = scrollLock.bodyOverflow;
  body.style.paddingRight = scrollLock.bodyPadding;
  scrollLock = null;
}

// Mouse wheel / touch scrolling
function stopScrollWhileVideo(e) {
  if (videoBox) { e.preventDefault(); return; }
  if (titleBox && !inTitleScroll(e.target)) e.preventDefault(); // the title screen's lists may scroll
}
window.addEventListener("wheel", stopScrollWhileVideo, { passive: false, capture: true });
window.addEventListener("touchmove", stopScrollWhileVideo, { passive: false, capture: true });

// Keyboard: arrows, space, page keys, etc. never reach the game or scroll the page.
// Esc closes the video. Function keys (F5, F11, F12...) and Ctrl/Alt/Cmd shortcuts still work.
function blockKeysWhileVideo(e) {
  if (!videoBox) return;
  if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === "keydown" && e.key === "Escape") closeVideo();
}
["keydown", "keyup", "keypress"].forEach((t) => window.addEventListener(t, blockKeysWhileVideo, true));

function closeVideo() {
  if (!videoBox) return;
  try { videoEl.pause(); videoEl.removeAttribute("src"); videoEl.load(); } catch (err) { /* ignore */ }
  videoBox.remove();
  videoBox = null; videoInner = null; videoEl = null;
  if (!titleBox) {
    unlockScroll();
    restorePageAudio();   // the VN's music comes back
  }
  idleSince = Date.now(); // the countdown starts over after the window closes
}

// When an intro video can't be loaded, look at the file itself (first 512 KB) and say why.
// Uses Tampermonkey's request function, so it is not blocked by the VN site's own rules.
function diagnoseVideo(url, cb) {
  const name = url.split("/").pop();
  if (typeof GM_xmlhttpRequest !== "function") {
    cb("couldn't check the file (GM_xmlhttpRequest isn't available).", "GM_xmlhttpRequest is not available, so the file could not be inspected.");
    return;
  }
  const fail = (why) => cb(why, why + "\nAddress: " + url);
  GM_xmlhttpRequest({
    method: "GET", url, headers: { Range: "bytes=0-524287" }, responseType: "arraybuffer", timeout: 20000,
    onerror: () => fail("couldn't reach the video host (network error, blocked by an extension, or a wrong address)."),
    ontimeout: () => fail("the video host didn't answer in time."),
    onload: (r) => {
      const head = String(r.responseHeaders || "");
      const type = (/content-type:\s*([^\r\n;]+)/i.exec(head) || [])[1] || "unknown";
      const cr = /content-range:\s*bytes\s+\d+-\d+\/(\d+)/i.exec(head);
      const len = /content-length:\s*(\d+)/i.exec(head);
      const total = cr ? +cr[1] : (len && r.status === 200 ? +len[1] : 0);
      const mb = total ? (total / 1048576).toFixed(1) + " MB" : "unknown size";
      const info = "Address: " + url + "\nHTTP " + r.status + " | type " + type + " | " + mb;
      if (r.status === 404) return cb("file not found (404): " + name + " isn't at that address. Check the name and that the site finished deploying.", info);
      if (r.status >= 400) return cb("the video host answered HTTP " + r.status + ".", info);
      const u8 = new Uint8Array(r.response || new ArrayBuffer(0));
      let txt = "";
      for (let i = 0; i < u8.length; i += 8192) txt += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
      if (/^version https:\/\/git-lfs/.test(txt)) return cb(name + " is a Git LFS pointer, not a video. GitHub Pages can't serve LFS files.", info);
      if (/^\s*</.test(txt)) return cb("that address returns a web page, not a video.", info);
      if (txt.substr(4, 4) !== "ftyp") return cb("the file doesn't look like an MP4 video (type " + type + ", " + mb + ").", info);
      const has = (t) => txt.indexOf(t) !== -1;
      const codecs = ["hvc1", "hev1", "avc1", "avc3", "av01", "vp09", "apch", "apcn", "apco", "apcs", "ap4h"].filter(has);
      let short, detail = "Codecs found: " + (codecs.join(", ") || "none in the first 512 KB");
      const i = txt.indexOf("avcC");
      const profile = i !== -1 ? txt.charCodeAt(i + 5) : 0; // AVCProfileIndication
      if (has("hvc1") || has("hev1")) short = "it's HEVC / H.265, which most browsers can't play. Re-encode it to H.264 (8-bit, yuv420p).";
      else if (codecs.some((c) => /^ap/.test(c))) short = "it's ProRes, which browsers can't play. Re-encode it to H.264.";
      else if ([110, 122, 244].includes(profile)) { short = "H.264 but high-bit-depth / 4:2:2-4:4:4 (profile " + profile + "), which browsers can't play. Re-encode to 8-bit yuv420p."; }
      else if (has("avc1") || has("avc3")) short = "it looks like normal H.264 (profile " + (profile || "?") + "). Another cause: a damaged file, or the VN site blocking videos from other sites (see red messages in the console).";
      else short = "can't tell the codec (the file's index is probably at the end). Re-encode it with '-movflags +faststart'.";
      cb(short, info + "\n" + detail + (profile ? "\nH.264 profile: " + profile : "") + "\nResult: " + short);
    }
  });
}

function openVideo(kind) {
  const url = VIDEOS[kind];
  if (!url || videoBox) return;

  videoBox = el("div", {
    position: "fixed", top: "0", left: "0", right: "0", bottom: "0",
    zIndex: 2147483647, background: "rgba(0,0,0,0.6)"
  });
  swallowEvents(videoBox);
  videoBox.addEventListener("mousedown", (ev) => { if (ev.button === 1) ev.preventDefault(); }); // no middle-click autoscroll
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
    const code = v.error ? v.error.code : 0; // 1 aborted, 2 network, 3 decode, 4 not found / blocked / unsupported
    console.warn("[VN script] intro video failed to load:", url, "| MediaError code", code, v.error && v.error.message);
    closeVideo();
    diagnoseVideo(url, (short, full) => {
      console.warn("[VN script] video check:\n" + full);
      toast("Intro video couldn't be loaded: " + short);
    });
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
  lockScroll();
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
  if (titleBox) duckPageAudio();            // the title screen keeps the VN silent; the idle opening still plays over it
  if (menu || document.visibilityState !== "visible") { idleSince = Date.now(); return; }
  if (sceneKey() !== null) { idleSince = Date.now(); return; } // no idle openings inside scenes, only on the main menu pages
  const seg = location.pathname.split("/").filter(Boolean);
  if (seg.length > 0 && (!IDLE_ON_FLOWCHARTS || !routeKind())) return; // "/" = the main menu; /fate, /ubw, /hf = flowcharts
  const kind = pickIdleKind(); // only routes you have completed; null = nothing to play yet
  if (!kind) return;
  const wait = seenRoutes[kind] ? IDLE_REPEAT_MS : IDLE_FIRST_MS;
  if (Date.now() - idleSince < wait) return;
  idleLast = kind;
  store.set("fsnIdleLast", kind);
  openVideo(kind);
}

// ----- openings that play by themselves when you arrive at a certain page (like the real game) -----
// They play every time you get there, no matter how often. The page's #hash is ignored.
const AUTO_VIDEOS = [
  { path: "/fate/4th-day/0", kind: "fate" },
  { path: "/ubw/4th-day/0", kind: "ubw" },
  { path: "/hf/4th-day/11", kind: "hf" }
];
let lastPath = null;

function currentPath() {
  return location.pathname.replace(/\/+$/, "") || "/";
}

function checkArrival() {
  const path = currentPath();
  if (path === lastPath) return;
  const firstCheck = lastPath === null;
  lastPath = path;
  recordLastScene(path);
  const hit = AUTO_VIDEOS.find((a) => a.path === path);
  if (!hit) return;
  if (failedRoutes[hit.kind]) return;
  // opened straight into the middle of that part (e.g. loading a save): don't replay the opening
  if (firstCheck && location.hash) return;
  if (videoBox) closeVideo();
  openVideo(hit.kind);
}

window.addEventListener("resize", layoutVideo);
window.addEventListener("orientationchange", layoutVideo);
document.addEventListener("visibilitychange", () => { idleSince = Date.now(); });

// ================= Grayed-out text + left-to-right reveal =================
// The site shows all the text of a scene, with the part you are reading in white and everything
// before/after it grayed out. Two things happen here, both only inside scenes:
//  1) the grayed-out text fades out (it keeps its place, so scrolling and the site's triggers work);
//  2) lines that turn white are revealed line by line, from left to right, like in the novel.
// The "white" text is found by how it looks: a line counts as grayed out when it is clearly dimmer
// than the brightest text on the page. Menu buttons turn each feature off and on.
const DIM_RATIO = 0.8;          // dimmer than 80% of the brightest text = grayed out
const REVEAL_MS_PER_CHAR = 33;  // reveal speed: about 30 characters per second
const REVEAL_MIN_MS = 250;      // even a very short line takes at least this long
const REVEAL_PAUSE_MS = 120;    // short pause between two lines
const REVEAL_SETTLE_MS = 100;   // lines that turn white a moment apart are collected and revealed in order
const REVEAL_SETTLE_MAX_MS = 400;
const HIDDEN_CLIP = "inset(-0.3em 100% -0.3em 0)";
const SHOWN_CLIP = "inset(-0.3em -0.3em -0.3em 0)";
let grayHidden = true;
let revealOn = true;
const fadedSpans = new Set();
const fadedOrig = new WeakMap();
const revealing = new Map();    // line -> its running reveal animation
const pendingReveal = new Set(); // lines that just turned white and wait for their turn (kept transparent)
let pendingSince = 0;
let settleTimer = null;
let lastRevealActivity = 0;
let skipNextStart = false;      // after turning the reveal on, the text on screen is just left as it is
let prevActive = null;          // which lines were white at the last look (null = no starting point yet)
let textScheduled = false;
let lastTextPass = 0;

// ----- read progress and checkmarks on the main menu flowchart -----
// A scene counts as read when you have been through (nearly) all of its lines: at least 90% of
// the lines were white at some moment and the last line was reached. Progress is remembered between
// visits. Finished scenes get a green box with a checkmark on the main menu.
const READ_FRACTION = 0.9;
const DONE_BG = "rgba(34, 139, 58, 0.85)";
const DONE_RING = "0 0 0 2px #3fbf5f inset, 0 0 8px rgba(63, 191, 95, 0.6)";
let doneScenes = {};      // path -> true
let progressStore = {};   // path -> { n: number of lines, bits: hex string of the lines already seen }
let curScene = null;      // { path, n, visited: [bool] } for the scene on screen
let doneLoaded = false;
let progressLoaded = false;
let progressDirty = false;
let progressTimer = null;
const markOrig = new WeakMap();
// Tiger dojos on the flowchart: hidden until you open one, red while unfinished, green when read.
const PARTIAL_BG = "rgba(190, 40, 40, 0.85)";
const PARTIAL_RING = "0 0 0 2px #ff5a5a inset, 0 0 8px rgba(255, 90, 90, 0.6)";
let showDojos = false;    // Settings switch: show every tiger dojo on the flowchart

function normPath(p) {
  return (p || "").replace(/\/+$/, "") || "/";
}

function bitsToHex(bits) {
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) if (bits[i + k]) v |= 1 << k;
    out += v.toString(16);
  }
  return out;
}

function hexToBits(hex, n) {
  const bits = new Array(n).fill(false);
  for (let i = 0; i < hex.length; i++) {
    const v = parseInt(hex[i], 16) || 0;
    for (let k = 0; k < 4; k++) {
      const idx = i * 4 + k;
      if (idx < n && ((v >> k) & 1)) bits[idx] = true;
    }
  }
  return bits;
}

function flushProgress() {
  progressTimer = null;
  if (!progressDirty) return;
  progressDirty = false;
  if (curScene && !doneScenes[curScene.path]) {
    progressStore[curScene.path] = { n: curScene.n, bits: bitsToHex(curScene.visited) };
  }
  store.set("fsnProgress", progressStore);
}

function markDone(path) {
  doneScenes[path] = true;
  delete progressStore[path];
  curScene = null;
  store.set("fsnDone", Object.keys(doneScenes));
  progressDirty = true;
  flushProgress();
}

// Called on every look at a scene page with the lines (in reading order) and which of them are white.
function trackProgress(spans, activeSet) {
  if (!doneLoaded || !progressLoaded) return;
  const path = normPath(location.pathname);
  if (doneScenes[path]) return;
  const n = spans.length;
  if (!curScene || curScene.path !== path) {
    const saved = progressStore[path];
    const usable = saved && typeof saved.bits === "string" && saved.n <= n;
    curScene = { path, n, visited: usable ? hexToBits(saved.bits, n) : new Array(n).fill(false) };
  } else if (curScene.n !== n) {
    if (n > curScene.n) { while (curScene.visited.length < n) curScene.visited.push(false); }
    else curScene.visited = new Array(n).fill(false); // fewer lines than before: the text changed
    curScene.n = n;
  }
  let changed = false;
  spans.forEach((sp, i) => {
    if (activeSet.has(sp) && !curScene.visited[i]) { curScene.visited[i] = true; changed = true; }
  });
  if (!changed) return;
  progressDirty = true;
  if (!progressTimer) progressTimer = setTimeout(flushProgress, 1500);
  const seen = curScene.visited.filter(Boolean).length;
  const lastReached = curScene.visited[n - 1] || (n > 1 && curScene.visited[n - 2]);
  if (n >= 2 && seen / n >= READ_FRACTION && lastReached) markDone(path);
}

// A flowchart box is a tiger dojo when its label says so.
function isDojoLink(a) {
  return /tiger\s*dojo/i.test(a.textContent || "");
}

// True once at least one line of the scene has been seen.
function sceneStarted(path) {
  if (progressStore[path]) return true;
  return !!(curScene && curScene.path === path && curScene.visited.some(Boolean));
}

// True when every scene of the route's ROUTE_DONE list has its green checkmark.
function routeComplete(kind) {
  const list = ROUTE_DONE[kind];
  return !!(doneLoaded && list && list.length && list.every((p) => doneScenes[normPath(p)]));
}

// For troubleshooting: the scenes of a route that do not have their green checkmark yet.
function routeMissing(kind) {
  const list = ROUTE_DONE[kind] || [];
  return list.filter((p) => !doneScenes[normPath(p)]);
}

function restoreMark(a) {
  const o = markOrig.get(a) || {};
  [["background-color", o.bg], ["box-shadow", o.shadow], ["position", o.pos], ["display", o.display], ["visibility", o.vis], ["pointer-events", o.pe]].forEach(([prop, val]) => {
    if (val) a.style.setProperty(prop, val); else a.style.removeProperty(prop);
  });
  const badge = a.querySelector("[data-vnqs-badge]");
  if (badge) badge.remove();
  a.removeAttribute("data-vnqs-state");
}

function setMark(a, state) {
  markOrig.set(a, {
    bg: a.style.getPropertyValue("background-color"),
    shadow: a.style.getPropertyValue("box-shadow"),
    pos: a.style.getPropertyValue("position"),
    display: a.style.getPropertyValue("display"),
    vis: a.style.getPropertyValue("visibility"),
    pe: a.style.getPropertyValue("pointer-events")
  });
  if (state === "hidden") {
    // invisible and unclickable, but it keeps its place so the other boxes (and the site's arrows) don't move
    a.style.setProperty("visibility", "hidden", "important");
    a.style.setProperty("pointer-events", "none", "important");
  } else {
    const done = state === "done";
    a.style.setProperty("background-color", done ? DONE_BG : PARTIAL_BG, "important");
    a.style.setProperty("box-shadow", done ? DONE_RING : PARTIAL_RING, "important");
    if (getComputedStyle(a).position === "static") a.style.setProperty("position", "relative");
  }
  a.setAttribute("data-vnqs-state", state);
}

// Flowchart boxes: green + checkmark badge for finished scenes. Tiger dojos are hidden until you have
// opened one, then red while unfinished (green + check once read). The text is not changed.
function applyMenuMarks() {
  if (!doneLoaded || !progressLoaded) return;
  document.querySelectorAll("a.graph-item").forEach((a) => {
    let path;
    try { path = normPath(new URL(a.getAttribute("href") || "", location.href).pathname); } catch (err) { return; }
    let state = "";
    if (doneScenes[path]) state = "done";
    else if (isDojoLink(a)) state = sceneStarted(path) ? "partial" : (showDojos ? "" : "hidden");
    const cur = a.getAttribute("data-vnqs-state") || "";
    if (cur !== state) {
      if (cur) restoreMark(a);
      if (state) setMark(a, state);
    }
    if (state === "done" && !a.querySelector("[data-vnqs-badge]")) {
      const badge = document.createElement("span");
      badge.setAttribute("data-vnqs", "1");
      badge.setAttribute("data-vnqs-badge", "1");
      Object.assign(badge.style, {
        position: "absolute", top: "-9px", right: "-9px", width: "20px", height: "20px",
        borderRadius: "50%", background: "#2fa84f", color: "#fff", font: "bold 13px/20px sans-serif",
        textAlign: "center", pointerEvents: "none", boxShadow: "0 0 3px rgba(0,0,0,0.6)"
      });
      badge.textContent = "\u2713";
      a.appendChild(badge);
    }
  });
  syncDojoLines();
}

// The flowchart arrows are <line class="graph-svg-line"> elements the site draws from the boxes' positions
// (from the bottom centre of one box to the top centre of the next). Arrows that start or end at a hidden
// tiger dojo are hidden too, so nothing points at an empty gap. They come back when the dojo is revealed.
function svgPoint(line, x, y) {
  let m = null;
  try { m = line.getScreenCTM(); } catch (err) { /* not rendered */ }
  if (m) return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  const svg = line.ownerSVGElement || line.parentNode;
  const r = svg.getBoundingClientRect();
  return { x: r.left + x, y: r.top + y };
}

function syncDojoLines() {
  const lines = document.querySelectorAll("line.graph-svg-line");
  if (!lines.length) return;
  const spots = [];
  document.querySelectorAll('a.graph-item[data-vnqs-state="hidden"]').forEach((a) => {
    const r = a.getBoundingClientRect();
    if (r.width || r.height) spots.push({ cx: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  });
  const TX = 7, TY = 9; // tolerance in pixels
  lines.forEach((ln) => {
    let hide = false;
    if (spots.length) {
      const x1 = parseFloat(ln.getAttribute("x1")), y1 = parseFloat(ln.getAttribute("y1"));
      const x2 = parseFloat(ln.getAttribute("x2")), y2 = parseFloat(ln.getAttribute("y2"));
      if (![x1, y1, x2, y2].some(isNaN)) {
        const a = svgPoint(ln, x1, y1), b = svgPoint(ln, x2, y2);
        hide = spots.some((d) =>
          (Math.abs(b.x - d.cx) <= TX && Math.abs(b.y - d.top) <= TY) ||    // arrow ending at the dojo
          (Math.abs(a.x - d.cx) <= TX && Math.abs(a.y - d.bottom) <= TY));  // arrow starting at the dojo
      }
    }
    const was = ln.getAttribute("data-vnqs-hid") === "1";
    if (hide && !was) { ln.setAttribute("data-vnqs-hid", "1"); ln.style.setProperty("display", "none", "important"); }
    else if (!hide && was) { ln.removeAttribute("data-vnqs-hid"); ln.style.removeProperty("display"); }
  });
}

function toggleDojos() {
  showDojos = !showDojos;
  store.set("fsnShowDojos", showDojos);
  applyMenuMarks();
}

function resetProgress() {
  doneScenes = {};
  progressStore = {};
  curScene = null;
  progressDirty = false;
  store.set("fsnDone", []);
  store.set("fsnProgress", {});
  applyMenuMarks();
}

function colorBrightness(cs) {
  const m = (cs.color || "").match(/[\d.]+/g);
  if (!m || m.length < 3) return 1;
  const a = m.length > 3 ? parseFloat(m[3]) : 1;
  return a * (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255;
}

function effectiveOpacity(node, cache) {
  if (!node || node.nodeType !== 1) return 1;
  if (cache.has(node)) return cache.get(node);
  const o = parseFloat(getComputedStyle(node).opacity);
  const v = (isNaN(o) ? 1 : o) * effectiveOpacity(node.parentElement, cache);
  cache.set(node, v);
  return v;
}

function docOrder(a, b) {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function hideNow(sp) { sp.style.setProperty("clip-path", HIDDEN_CLIP, "important"); }
function unhideNow(sp) { sp.style.removeProperty("clip-path"); }

function setFaded(sp, faded, instant) {
  if (faded) {
    if (fadedSpans.has(sp)) return;
    fadedOrig.set(sp, { f: sp.style.getPropertyValue("filter"), t: sp.style.getPropertyValue("transition") });
    sp.style.setProperty("transition", "filter 0.25s", "important");
    sp.style.setProperty("filter", "opacity(0)", "important");
    fadedSpans.add(sp);
  } else {
    if (!fadedSpans.has(sp)) return;
    fadedSpans.delete(sp);
    const o = fadedOrig.get(sp) || { f: "", t: "" };
    if (instant) sp.style.setProperty("transition", "none", "important"); // the reveal does the showing
    if (o.f) sp.style.setProperty("filter", o.f); else sp.style.removeProperty("filter"); // fades back in
    setTimeout(() => { // then give the span its own transition setting back
      if (fadedSpans.has(sp)) return;
      if (o.t) sp.style.setProperty("transition", o.t); else sp.style.removeProperty("transition");
    }, 400);
  }
}

function restoreAllText() {
  Array.from(fadedSpans).forEach((sp) => setFaded(sp, false));
}

// Shows everything that is still waiting or being revealed, at once.
function finishReveals() {
  if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  pendingReveal.forEach(unhideNow);
  pendingReveal.clear();
  revealing.forEach((a) => { try { a.finish(); } catch (err) { /* ignore */ } });
  revealing.clear();
}

// When the lines that are still really being revealed will be done (so new lines queue up behind them).
// Worked out from the running animations every time, so nothing stale can be left over from lines
// that were finished, skipped or removed (a finished animation reports its "finish" a moment later).
function queueEndTime() {
  let end = 0;
  revealing.forEach((a, sp) => {
    if (!sp.isConnected || a.playState === "finished") return;
    if (a.vnqsEnd > end) end = a.vnqsEnd;
  });
  return end;
}

// Wipes one line in from left to right after `delay` ms (transparent until then, so the
// picture behind shows). Returns how long the wipe takes (0 if the browser can't animate it).
function startReveal(sp, delay) {
  if (typeof sp.animate !== "function") return 0;
  const len = sp.textContent.trim().length;
  const dur = Math.max(REVEAL_MIN_MS, len * REVEAL_MS_PER_CHAR);
  let anim;
  try {
    anim = sp.animate(
      [{ clipPath: HIDDEN_CLIP }, { clipPath: SHOWN_CLIP }],
      { duration: dur, delay: delay, easing: "linear", fill: "backwards" }
    );
  } catch (err) { return 0; }
  unhideNow(sp); // the animation keeps the line transparent until its turn
  revealing.set(sp, anim);
  anim.vnqsEnd = Date.now() + delay + dur;
  lastRevealActivity = Date.now();
  const done = () => {
    if (revealing.get(sp) === anim) revealing.delete(sp);
  };
  anim.onfinish = done;
  anim.oncancel = done;
  return dur;
}

// Starts the collected lines one after the other, in reading order, behind any line still running.
function flushReveals() {
  settleTimer = null;
  const list = Array.from(pendingReveal).filter((sp) => sp.isConnected).sort(docOrder);
  pendingReveal.clear();
  let t = Math.max(0, queueEndTime() - Date.now());
  if (t > 0) t += REVEAL_PAUSE_MS;
  list.forEach((sp) => {
    const d = startReveal(sp, t);
    if (d) t += d + REVEAL_PAUSE_MS; else unhideNow(sp);
  });
}

// Lines that just turned white are made transparent right away, then collected for a moment
// so that lines turning white a little apart still reveal in order.
function queueReveal(list) {
  if (!list.length) return;
  if (!pendingReveal.size) pendingSince = Date.now();
  list.forEach((sp) => { hideNow(sp); pendingReveal.add(sp); });
  lastRevealActivity = Date.now();
  if (settleTimer) clearTimeout(settleTimer);
  const wait = Math.max(0, Math.min(REVEAL_SETTLE_MS, pendingSince + REVEAL_SETTLE_MAX_MS - Date.now()));
  settleTimer = setTimeout(flushReveals, wait);
}

function applyTextFilter() {
  if (document.visibilityState !== "visible") return; // leave everything as it is while the tab is in the background
  lastTextPass = Date.now();
  applyMenuMarks();
  const inScene = sceneKey() !== null;
  const wantFilter = grayHidden && inScene;
  const wantReveal = revealOn && inScene;
  const reset = () => { restoreAllText(); finishReveals(); prevActive = null; };
  if (!inScene) { reset(); return; }

  const spans = [];
  document.querySelectorAll("span").forEach((sp) => {
    if (sp.children.length || !sp.textContent.trim()) return;
    if (sp.closest("[data-vnqs], button, a, select, [role='button']")) return; // our UI, choice buttons, links
    spans.push(sp);
  });
  if (spans.length < 2) { reset(); return; }

  const cache = new Map();
  const scores = spans.map((sp) => effectiveOpacity(sp, cache) * colorBrightness(getComputedStyle(sp)));
  let max = 0;
  scores.forEach((v) => { if (v > max) max = v; });
  const isDim = (i) => scores[i] < max * DIM_RATIO;
  const activeSet = new Set();
  spans.forEach((sp, i) => { if (!isDim(i)) activeSet.add(sp); });
  const real = activeSet.size < spans.length; // everything equally bright is not a real state yet
  if (real) trackProgress(spans, activeSet);

  // which lines just turned white? Those are revealed (text above what was white before shows instantly)
  const toReveal = [];
  const revealSet = new Set();
  if (wantReveal) {
    if (real) {
      if (prevActive === null) {
        // first real look after opening a page / entering a scene: reveal what is white now
        if (!skipNextStart) spans.forEach((sp) => { if (activeSet.has(sp)) toReveal.push(sp); });
        skipNextStart = false;
      } else {
        pendingReveal.forEach((sp) => { // a waiting line that is no longer white just shows
          if (!activeSet.has(sp)) { pendingReveal.delete(sp); unhideNow(sp); }
        });
        revealing.forEach((a, sp) => { // a running line that is no longer white: show its rest right away
          if (!activeSet.has(sp)) { try { a.finish(); } catch (err) { /* ignore */ } revealing.delete(sp); }
        });
        let lastPrev = null;
        prevActive.forEach((sp) => {
          if (sp.isConnected && (!lastPrev || (lastPrev.compareDocumentPosition(sp) & Node.DOCUMENT_POSITION_FOLLOWING))) lastPrev = sp;
        });
        spans.forEach((sp) => {
          if (!activeSet.has(sp) || prevActive.has(sp)) return;
          // going back (text above what was white before) shows instantly, forward is revealed
          if (!lastPrev || (lastPrev.compareDocumentPosition(sp) & Node.DOCUMENT_POSITION_FOLLOWING)) toReveal.push(sp);
        });
      }
      prevActive = activeSet;
    } else {
      prevActive = null;
    }
    toReveal.forEach((sp) => revealSet.add(sp));
    queueReveal(toReveal);
  } else {
    finishReveals();
    prevActive = null;
  }

  spans.forEach((sp, i) => {
    if (wantFilter && isDim(i)) setFaded(sp, true);
    else setFaded(sp, false, revealSet.has(sp));
  });
  Array.from(fadedSpans).forEach((sp) => { if (!sp.isConnected) fadedSpans.delete(sp); });
}

// looks again soon, but never more often than every 100 ms
function scheduleTextFilter() {
  if (textScheduled) return;
  textScheduled = true;
  const wait = Math.max(0, 100 - (Date.now() - lastTextPass));
  setTimeout(() => requestAnimationFrame(() => { textScheduled = false; applyTextFilter(); }), wait);
}

function toggleGray() {
  grayHidden = !grayHidden;
  store.set("fsnGrayHidden", grayHidden);
  applyTextFilter();
}

function toggleReveal() {
  revealOn = !revealOn;
  store.set("fsnReveal", revealOn);
  finishReveals();
  prevActive = null;
  skipNextStart = true; // the text on screen now just stays as it is
  applyTextFilter();
}

store.get("fsnDone", [], (arr) => {
  doneScenes = {};
  (Array.isArray(arr) ? arr : []).forEach((p) => { if (typeof p === "string") doneScenes[p] = true; });
  doneLoaded = true;
  applyMenuMarks();
});
store.get("fsnProgress", {}, (v) => {
  progressStore = v && typeof v === "object" ? v : {};
  progressLoaded = true;
});
window.addEventListener("pagehide", flushProgress);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushProgress(); });

store.get("fsnGrayHidden", true, (v) => {
  grayHidden = v !== false;
  applyTextFilter();
});
store.get("fsnShowDojos", false, (v) => {
  showDojos = !!v;
  applyMenuMarks();
});
store.get("fsnReveal", true, (v) => {
  revealOn = v !== false;
  applyTextFilter();
});

// the white part moves when you scroll, click or press keys, or when the page changes
window.addEventListener("scroll", scheduleTextFilter, { capture: true, passive: true });
["click", "keyup", "touchend", "wheel"].forEach((t) => window.addEventListener(t, scheduleTextFilter, { capture: true, passive: true }));
try {
  new MutationObserver((muts) => {
    if (muts.some((m) => !(m.target.closest && m.target.closest("[data-vnqs]")))) scheduleTextFilter();
  }).observe(document.body, { attributes: true, attributeFilter: ["class", "style"], subtree: true, childList: true });
} catch (err) { /* ignore */ }

// Only a click, a tap, or the Enter key shows the lines that are still waiting or being revealed at
// once. Scrolling (wheel, touch-drag) and the navigation keys (arrows, Page Up/Down, Home/End, Space)
// never skip, so you can scroll down a long page while the text keeps being revealed.
// (A tap is a click, so touch scrolling doesn't skip either. A click/tap right after new text started
// is just the end of the gesture that moved the page on, and the script's own keys, menu and windows
// don't count.)
function skipReveals(e) {
  if (e.type === "keydown") {
    if (e.key !== "Enter" || menu || videoBox) return;
  } else if (e.target && e.target.closest && e.target.closest("[data-vnqs]")) {
    return;
  }
  if (e.type === "click" && Date.now() - lastRevealActivity < 250) return;
  finishReveals();
}
["click", "keydown"].forEach((t) => window.addEventListener(t, skipReveals, { capture: true, passive: true }));

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
  if (segs.length < 2) {
    // main menu (the flowchart pages /, /fate, /ubw, /hf)
    hudBox.appendChild(el("span", { fontWeight: "bold" },
      segs.length === 0 ? "Main menu" : "Main menu \u00b7 " + titleCase(segs[0])));
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

// ================= Main menu button =================
// Sits right under the position display on computers. On phones the display is at the bottom, so the
// button goes at the very bottom with the display above it (inside the safe area, never cut off).
let menuBtn = null;

function updateMenuBtn() {
  if (!document.body) return;
  const onRoot = location.pathname.replace(/\/+$/, "") === "";
  if (onRoot) {
    if (menuBtn) { menuBtn.remove(); menuBtn = null; }
    return;
  }
  const stack = getStack();
  if (menuBtn && menuBtn.parentNode === stack) return;
  if (menuBtn) menuBtn.remove();
  const px = IS_TOUCH ? 13 : 15;
  menuBtn = el("div", {
    order: IS_TOUCH ? "-1" : "1", // phones: below the display (the stack grows upwards); computers: under it
    pointerEvents: "auto", cursor: "pointer", boxSizing: "border-box",
    background: "rgba(0,0,0,0.45)", color: "#fff", font: "bold " + px + "px sans-serif",
    padding: (IS_TOUCH ? 10 : 7) + "px " + (IS_TOUCH ? 16 : 14) + "px", borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.35)", textShadow: "0 0 3px rgba(0,0,0,0.8)",
    whiteSpace: "nowrap", maxWidth: "100%", userSelect: "none", webkitUserSelect: "none",
    touchAction: "manipulation"
  }, "\u2302 Main menu");
  swallowEvents(menuBtn);
  menuBtn.addEventListener("click", () => { location.href = ORIGIN + "/"; });
  stack.appendChild(menuBtn);
}

// ================= Main menu (title screen) =================
// A full-screen title screen over the plain main page (https://fatestaynight.vnovel.org/). It covers
// the whole page, silences the VN's music, blocks scrolling and ignores Esc and all shortcut keys.
// Buttons: Continue (big load screen), Settings (big settings screen) and Flowchart (Fate / UBW / HF).
// It goes away by itself as soon as you leave the main page (Continue, a flowchart, or any link).
let titleBox = null;
let titleView = "home"; // "home" | "load" | "settings" | "flow"
let titleSub = null;    // inside Settings: null | "export" | "import" | "importOk" | "reset"
let titleMsg = "";
let titleImport = null; // decoded save code waiting for confirmation
let titleDraft = "";    // text typed or pasted in the import box
let titleCompact = false; // short landscape screens (phones held sideways) get a tighter layout
let titleWide = false;    // big computer screens: the title picture is shown larger
let titleEnabled = true;  // Settings switch: false = no title screen at all (plain flowchart page)
store.get("fsnTitleOn", true, (v) => { titleEnabled = v !== false; });
const FLOW_ROUTES = [
  { label: "Prologue", path: "/fate", color: "#5f6672", glow: "#bfe6ff", jump: "prologue" }, // the Prologue square sits at the top of the Fate chart
  { label: "Fate", path: "/fate", color: "#2f6fdb", glow: "#4aa8ff", kind: "fate" },
  { label: "Unlimited Blade Works", path: "/ubw", color: "#c0392b", glow: "#ff5a5a", kind: "ubw" },
  { label: "Heaven's Feel", path: "/hf", color: "#8e3bd1", glow: "#c585ff", kind: "hf" }
];

function isCompactScreen() {
  return window.innerWidth > window.innerHeight && window.innerHeight < 520;
}

function isWideScreen() {
  return window.innerWidth >= 900 && !isCompactScreen();
}

function bigButton(label, bg, fn, extra) {
  const b = el("div", Object.assign({
    boxSizing: "border-box", width: "100%", textAlign: "center", cursor: "pointer",
    padding: titleCompact ? "9px 16px" : "16px 20px", borderRadius: titleCompact ? "8px" : "10px",
    background: bg, color: "#fff",
    fontWeight: "bold", fontSize: titleCompact ? "16px" : "clamp(17px, 4.6vw, 22px)", letterSpacing: "1px",
    border: "1px solid rgba(255,255,255,0.28)", boxShadow: "0 2px 10px rgba(0,0,0,0.45)",
    userSelect: "none", webkitUserSelect: "none", touchAction: "manipulation"
  }, extra || {}), label);
  addFeedback(b);
  b.addEventListener("click", fn);
  return b;
}

// Title screen menu entries: plain light text; when hovered or pressed they turn bright with a glowing line through them.
function menuButton(label, fn, glow, small, check) {
  const hot = glow || "#6fe9ff";
  const b = el("div", {
    boxSizing: "border-box", width: "100%", display: "flex", justifyContent: "center", alignItems: "center",
    padding: titleCompact ? (small ? "6px 0" : "8px 0") : (small ? "10px 0" : "13px 0"),
    cursor: "pointer", userSelect: "none", webkitUserSelect: "none", touchAction: "manipulation", flex: "0 0 auto",
    webkitTapHighlightColor: "transparent"
  });
  const word = el("span", {
    position: "relative", isolation: "isolate", display: "inline-block", padding: "0 6px", textAlign: "center",
    color: "#cdd7ee", fontFamily: "'Segoe UI Light', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif", fontWeight: "300",
    fontSize: small ? (titleCompact ? "16px" : "clamp(16px, 4.4vw, 20px)") : (titleCompact ? "20px" : "clamp(22px, 6vw, 30px)"),
    letterSpacing: "1px", transition: "color .18s, text-shadow .18s"
  }, label);
  const streak = el("span", {
    position: "absolute", left: "50%", top: "50%", zIndex: -1, pointerEvents: "none", opacity: "0",
    width: "calc(100% + min(90px, 16vw))", height: "2px", transform: "translate(-50%, -50%)",
    background: "linear-gradient(90deg, transparent 0%, " + hot + " 22%, #ffffff 50%, " + hot + " 78%, transparent 100%)",
    boxShadow: "0 0 8px 1px " + hot + ", 0 0 22px 4px " + hot + "66", transition: "opacity .18s"
  });
  word.appendChild(streak);
  if (check) { // a blue check right after the text (it hangs outside, so the text stays centred)
    const tick = el("span", {
      position: "absolute", left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: "10px",
      color: "#7fd0ff", fontWeight: "bold", fontSize: "0.95em", lineHeight: "1", zIndex: 2,
      textShadow: "0 0 3px #04163a, 0 0 3px #04163a, 0 0 10px rgba(110,200,255,0.95)", pointerEvents: "none"
    }, "\u2713");
    tick.title = "Route completed";
    word.appendChild(tick);
  }
  b.appendChild(word);
  const set = (on) => {
    word.style.color = on ? hot : "#cdd7ee";
    word.style.textShadow = on ? "0 0 10px " + hot + ", 0 0 24px " + hot + "99" : "none";
    streak.style.opacity = on ? "1" : "0";
  };
  b.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") set(true); });
  b.addEventListener("pointerleave", () => set(false));
  b.addEventListener("pointerdown", () => set(true));
  b.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") set(false); });
  b.addEventListener("pointercancel", () => set(false));
  // on a phone, let the glow show for a moment before the next screen replaces it
  b.addEventListener("click", () => { set(true); setTimeout(fn, IS_TOUCH ? 140 : 0); });
  return b;
}

function inTitleScroll(t) {
  return !!(t && t.closest && t.closest("[data-vnqs-scroll]"));
}

function openTitle() {
  if (titleBox || !document.body) return;
  if (menu) closeMenu();
  if (videoBox) closeVideo();
  titleView = "home"; titleSub = null; titleMsg = ""; titleImport = null; titleDraft = "";
  titleCompact = isCompactScreen();
  titleBox = el("div", {
    position: "fixed", top: "0", left: "0", right: "0", bottom: "0", zIndex: 2147483647,
    boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center",
    padding: "max(10px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(10px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))",
    background: TITLE_BASE_BG,
    color: "#fff", font: "16px sans-serif", overflow: "hidden", touchAction: "none"
  });
  swallowEvents(titleBox);
  titleBox.addEventListener("mousedown", (ev) => { if (ev.button === 1) ev.preventDefault(); }); // no middle-click autoscroll
  titleBox.addEventListener("contextmenu", (ev) => { if (!isTyping(ev)) ev.preventDefault(); });
  document.body.appendChild(titleBox);
  lockScroll();
  duckPageAudio();
  renderTitle();
  loadTitleBackground();
}

function closeTitle() {
  if (!titleBox) return;
  titleBox.remove();
  titleBox = null;
  titleImport = null;
  if (!videoBox) { unlockScroll(); restorePageAudio(); }
  idleSince = Date.now();
}

function setTitleView(v) {
  titleView = v; titleSub = null; titleMsg = ""; titleImport = null; titleDraft = "";
  renderTitle();
}

function titleHeader(wrap, text, color) {
  wrap.appendChild(el("div", {
    textAlign: "center", fontWeight: "bold", fontSize: titleCompact ? "20px" : "clamp(22px, 6vw, 32px)", letterSpacing: "1px",
    color: color || "#fff", margin: "0 0 2px", flex: "0 0 auto"
  }, text));
}

function titleBack(wrap, fn) {
  wrap.appendChild(menuButton("\u2190 Back", fn || (() => setTitleView("home")), "#6fe9ff", true));
}

let titleImgSrc = TITLE_IMAGE;      // the address that works (the plain one, or a data: copy of it)
let titleImgTriedData = false;
let titleImgFailed = false;

// Some pages refuse pictures from other sites. Tampermonkey can still download the file and hand it over as a data: address.
function fetchAsDataUrl(url, cb) {
  if (typeof GM_xmlhttpRequest !== "function") { cb(null); return; }
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  const mime = ext === "webp" ? "image/webp" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : "image/png";
  GM_xmlhttpRequest({
    method: "GET", url, responseType: "arraybuffer", timeout: 20000,
    onerror: () => cb(null), ontimeout: () => cb(null),
    onload: (r) => {
      if (r.status !== 200 || !r.response) { cb(null); return; }
      const u8 = new Uint8Array(r.response);
      let bin = "";
      for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
      cb("data:" + mime + ";base64," + btoa(bin));
    }
  });
}

// ---- background picture ----
const TITLE_BASE_BG = "radial-gradient(ellipse at 50% 20%, #1d2c52 0%, #0b1020 55%, #05070d 100%)";
let titleBgSrc = null;     // the address that works (plain, or a data: copy)
let titleBgFailed = false;

function setTitleBg(box, src) {
  // soft dark edges (keeps the text readable), then the picture covering the whole screen, then the gradient underneath
  box.style.backgroundImage = "radial-gradient(ellipse at 50% 55%, rgba(0,0,0,0) 35%, rgba(0,0,0,0.38) 100%), url(\"" + src + "\"), " + TITLE_BASE_BG;
  box.style.backgroundSize = "auto, cover, auto";
  box.style.backgroundPosition = "center, 50% 80%, center"; // keeps the bright glow at the bottom in view
  box.style.backgroundRepeat = "no-repeat";
}

function loadTitleBackground() {
  if (!TITLE_BACKGROUND || titleBgFailed) return;
  const apply = (src) => { titleBgSrc = src; if (titleBox) setTitleBg(titleBox, src); };
  if (titleBgSrc) { apply(titleBgSrc); return; }
  const probe = new Image();
  probe.onload = () => apply(TITLE_BACKGROUND);
  probe.onerror = () => {
    fetchAsDataUrl(TITLE_BACKGROUND, (d) => {
      if (!d) { titleBgFailed = true; return; }
      const p2 = new Image();
      p2.onload = () => apply(d);
      p2.onerror = () => { titleBgFailed = true; };
      p2.src = d;
    });
  };
  probe.src = TITLE_BACKGROUND;
}

// The title picture, or null (then the text title is used).
function titleLogo() {
  if (!TITLE_IMAGE || titleImgFailed) return null;
  const box = el("div", {
    display: "flex", justifyContent: "center", alignItems: "center", margin: titleCompact ? "0" : "0 0 18px"
  });
  const img = document.createElement("img");
  img.alt = "Fate/stay night";
  img.draggable = false;
  // Big computer screens: the picture fills up to 860 px of width (and up to ~46% of the height, always leaving
  // room for the four buttons). Phones and tablets keep a smaller picture that never gets wider than the screen.
  const big = titleWide && !titleCompact;
  Object.assign(img.style, {
    display: "block", width: big ? "100%" : "auto", height: "auto", objectFit: "contain", pointerEvents: "none", userSelect: "none",
    maxWidth: titleCompact ? "min(380px, 42vw)" : big ? "min(860px, 100%)" : "min(560px, 100%)",
    maxHeight: titleCompact ? "72vh" : big ? "max(120px, min(46vh, calc(100vh - 380px)))" : "30vh",
    filter: "drop-shadow(0 0 16px rgba(90,150,255,0.5))"
  });
  // phones: the visible height changes with the browser bar, so use it when the browser knows it (ignored otherwise)
  if (!titleCompact) img.style.maxHeight = big ? "max(120px, min(46dvh, calc(100dvh - 380px)))" : "30dvh";
  const useText = () => {
    titleImgFailed = true;
    if (titleBox && titleView === "home") renderTitle();
  };
  img.addEventListener("error", () => {
    if (!titleImgTriedData) {
      titleImgTriedData = true;
      fetchAsDataUrl(TITLE_IMAGE, (d) => { if (d) { titleImgSrc = d; img.src = d; } else useText(); });
    } else {
      useText();
    }
  });
  img.src = titleImgSrc;
  box.appendChild(img);
  return box;
}

function renderTitle() {
  if (!titleBox) return;
  titleWide = isWideScreen();
  titleBox.textContent = "";
  const wrap = el("div", {
    display: "flex", flexDirection: "column", alignItems: "stretch", gap: titleCompact ? "8px" : "14px",
    width: "100%", maxWidth: titleView === "home" || titleView === "flow" ? "440px" : "640px",
    maxHeight: "100%", minHeight: "0"
  });
  titleBox.appendChild(wrap);

  if (titleView === "home") {
    const textTitle = el("div", {
      textAlign: "center", fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: "bold",
      fontSize: titleCompact ? "clamp(28px, 6vw, 46px)" : "clamp(34px, 10vw, 64px)", lineHeight: "1.1", letterSpacing: "2px",
      textShadow: "0 0 22px rgba(90,150,255,0.65)", margin: titleCompact ? "0" : "0 0 18px"
    }, "Fate/stay night");
    const title = titleLogo() || textTitle;
    const btns = [
      menuButton("New Game", () => { location.href = ORIGIN + "/prologue/1"; }),
      menuButton("Continue", () => setTitleView("load")),
      menuButton("Settings", () => setTitleView("settings")),
      menuButton("Flowchart", () => setTitleView("flow"))
    ];
    if (titleCompact) {
      // phone held sideways: title on the left, buttons on the right, everything fits the short screen
      wrap.style.flexDirection = "row"; wrap.style.alignItems = "center"; wrap.style.gap = "28px"; wrap.style.maxWidth = "760px";
      title.style.flex = "1 1 0";
      const col = el("div", { display: "flex", flexDirection: "column", gap: "0", flex: "0 0 min(300px, 44vw)" });
      btns.forEach((b) => col.appendChild(b));
      wrap.appendChild(title);
      wrap.appendChild(col);
    } else {
      // the picture can use the full width; the buttons stay in a narrower column in the middle
      wrap.style.gap = "4px";
      wrap.style.maxWidth = "min(900px, 100%)";
      wrap.appendChild(title);
      const col = el("div", { display: "flex", flexDirection: "column", width: "100%", maxWidth: "440px", alignSelf: "center", flex: "0 0 auto" });
      btns.forEach((b) => col.appendChild(b));
      wrap.appendChild(col);
    }
    return;
  }

  if (titleView === "flow") {
    wrap.style.gap = titleCompact ? "0" : "2px";
    titleHeader(wrap, "Choose a route");
    FLOW_ROUTES.forEach((r) => {
      wrap.appendChild(menuButton(r.label, () => {
        if (r.jump) store.set("fsnJump", { type: r.jump, t: Date.now() }); // tells the flowchart page to open at the top
        location.href = ORIGIN + r.path;
      }, r.glow, false, !!r.kind && routeComplete(r.kind)));
    });
    try { // troubleshooting aid: press F12 and look at the Console to see what a route is still waiting for
      FLOW_ROUTES.forEach((r) => { if (r.kind) console.log("[vn-quick-save] " + r.label + ": " + (routeComplete(r.kind) ? "completed" : "missing " + (routeMissing(r.kind).join(", ") || "(no scenes listed)"))); });
    } catch (err) { /* ignore */ }
    titleBack(wrap);
    return;
  }

  if (titleView === "load") {
    titleHeader(wrap, "Continue", "#6fb0ff");
    const panel = el("div", {
      overflowY: "auto", overscrollBehavior: "contain", flex: "1 1 auto", minHeight: "0",
      display: "flex", flexDirection: "column", gap: "8px", paddingRight: "2px"
    });
    panel.setAttribute("data-vnqs-scroll", "1");
    wrap.appendChild(panel);
    const msg = el("div", { color: "#ffb35a", fontSize: "14px", textAlign: "center", minHeight: "18px", flex: "0 0 auto" }, titleMsg);
    wrap.appendChild(msg);
    titleBack(wrap);
    getData((slots, auto) => {
      if (!titleBox || titleView !== "load") return;
      const row = (label, slot, extra, name) => {
        const r = el("div", Object.assign({
          display: "flex", alignItems: "center", gap: "14px", padding: titleCompact ? "10px 14px" : "16px 18px", borderRadius: "10px",
          cursor: "pointer", background: "rgba(60,130,255,0.16)", fontSize: titleCompact ? "15px" : "clamp(15px, 4vw, 18px)",
          border: "1px solid rgba(255,255,255,0.14)", flex: "0 0 auto"
        }, extra || {}));
        r.appendChild(el("span", { fontWeight: "bold", minWidth: "62px", color: "#9cc6ff" }, label));
        r.appendChild(el("span", { flex: "1", color: slot ? "#fff" : "#8a8f98", overflowWrap: "anywhere" },
          slot ? prettyLabel(slot.url) : "Empty"));
        r.addEventListener("mouseenter", () => { r.style.filter = "brightness(1.25)"; });
        r.addEventListener("mouseleave", () => { r.style.filter = ""; });
        r.addEventListener("click", () => {
          if (!slot) { titleMsg = name + " is empty."; msg.textContent = titleMsg; return; }
          if (!isSafeUrl(slot.url)) { titleMsg = name + " can't be loaded."; msg.textContent = titleMsg; return; }
          toast("Loading " + name + "\u2026");
          location.href = slot.url;
        });
        panel.appendChild(r);
      };
      row("Auto", auto, { outline: "2px solid " + AUTO_COLOR, background: "rgba(193,60,255,0.18)" }, "the auto-save");
      slots.forEach((s, i) => row("Slot " + (i + 1), s, null, "slot " + (i + 1)));
    });
    return;
  }

  // ----- settings -----
  titleHeader(wrap, "Settings", "#c4c8cf");
  const panel = el("div", {
    overflowY: "auto", overscrollBehavior: "contain", flex: "1 1 auto", minHeight: "0",
    display: "flex", flexDirection: "column", gap: titleCompact ? "6px" : "10px", paddingRight: "2px"
  });
  panel.setAttribute("data-vnqs-scroll", "1");
  wrap.appendChild(panel);
  const chipBg = "rgba(255,255,255,0.12)";
  const chip = { fontWeight: "normal", fontSize: titleCompact ? "15px" : "clamp(15px, 4vw, 18px)", padding: titleCompact ? "9px 8px" : "14px 10px", letterSpacing: "0" };
  const section = (t) => panel.appendChild(el("div", {
    color: "#8a8f98", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.6px", margin: "8px 2px 0"
  }, t));
  const grid = () => {
    const g = el("div", { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "8px" });
    panel.appendChild(g);
    return g;
  };
  const note = (t, color) => panel.appendChild(el("div", { color: color || "#ffb35a", fontSize: "14px", textAlign: "center" }, t));
  const yesNo = (yesLabel, yesFn, noFn) => {
    const g = el("div", { display: "flex", gap: "10px" });
    g.appendChild(bigButton(yesLabel, "#b00000", yesFn, { flex: "1" }));
    g.appendChild(bigButton("No", "#444", noFn, { flex: "1" }));
    panel.appendChild(g);
  };
  const subBack = () => { titleSub = null; titleMsg = ""; titleImport = null; renderTitle(); };

  if (titleSub === "export") {
    section("Export saves");
    note("Copy it, then paste it into \"Import saves\" on another device. It holds your auto-save and slots 1-" + SLOTS + ".", "#aaa");
    const ta = codeBox("", true);
    Object.assign(ta.style, { height: titleCompact ? "84px" : "130px", fontSize: "14px" });
    panel.appendChild(ta);
    const m = el("div", { color: "#ffb35a", fontSize: "14px", textAlign: "center", minHeight: "18px" }, titleMsg);
    panel.appendChild(m);
    getData((slots, auto) => {
      const code = encodeSaves(slots, auto);
      ta.value = code;
      panel.insertBefore(bigButton("Copy", "#1e6fff", () => {
        copyText(code, ta, (ok) => { titleMsg = ok ? "Copied \u2714" : "Couldn't copy. Select the code and copy it manually."; m.textContent = titleMsg; });
      }, chip), m.nextSibling);
    });
    titleBack(wrap, subBack);
    return;
  }

  if (titleSub === "import") {
    section("Import saves");
    note("Paste a code you exported from this script.", "#aaa");
    const ta = codeBox(titleDraft, false);
    Object.assign(ta.style, { height: titleCompact ? "84px" : "130px", fontSize: "14px" });
    ta.placeholder = CODE_PREFIX + "...";
    ta.addEventListener("input", () => { titleDraft = ta.value; });
    panel.appendChild(ta);
    if (titleMsg) note(titleMsg);
    panel.appendChild(bigButton("Import", "#1e6fff", () => {
      titleDraft = ta.value;
      const data = decodeSaves(titleDraft);
      if (!data) { titleMsg = "That code isn't valid. Make sure it was copied completely."; renderTitle(); return; }
      titleImport = data; titleSub = "importOk"; titleMsg = ""; renderTitle();
    }, chip));
    titleBack(wrap, subBack);
    if (!IS_TOUCH) ta.focus();
    return;
  }

  if (titleSub === "importOk" && titleImport) {
    const n = titleImport.slots.filter(Boolean).length;
    section("Import saves?");
    note("The code has " + n + " slot save" + (n === 1 ? "" : "s") + (titleImport.auto ? " and an auto-save." : "."), "#fff");
    note("This replaces ALL your current saves, including the auto-save.");
    yesNo("Yes, import", () => {
      const d = titleImport;
      store.set("fsnSlots", d.slots);
      store.set("fsnAuto", d.auto);
      const c = d.slots.filter(Boolean).length + (d.auto ? 1 : 0);
      titleImport = null; titleSub = null; titleMsg = "Imported " + c + " save" + (c === 1 ? "" : "s") + " \u2714";
      renderTitle();
    }, subBack);
    return;
  }

  if (titleSub === "reset") {
    section("Reset all checkmarks?");
    note("Every green checkmark on the flowcharts and your reading progress in all scenes will be cleared.", "#fff");
    note("This can't be undone.");
    yesNo("Yes, reset", () => {
      resetProgress();
      titleSub = null; titleMsg = "Checkmarks reset \u2714";
      renderTitle();
    }, subBack);
    return;
  }

  if (titleSub === "dojos") {
    section("\u26a0 Spoiler warning");
    note("Tiger dojos stay hidden on the flowcharts until you find them yourself, because where they are gives away what is coming.", "#fff");
    note("Show them anyway?");
    yesNo("Yes, show them", () => {
      toggleDojos();
      titleSub = null; titleMsg = "Tiger dojos are now shown.";
      renderTitle();
    }, subBack);
    return;
  }

  if (titleSub === "menuOff") {
    section("Turn off the main menu?");
    note("This title screen will no longer appear. You will see the plain flowchart page instead.", "#fff");
    note("You can turn it back on any time in the small Settings menu (" +
      (IS_TOUCH ? "tap the \u2630 button, then Settings" : "press " + SETTINGS_KEY.toUpperCase() + " or click the Settings box in the top right") + ").");
    yesNo("Yes, turn off", () => {
      titleEnabled = false;
      store.set("fsnTitleOn", false);
      titleSub = null; titleMsg = "";
      closeTitle();
      toast("Main menu turned off. " + (IS_TOUCH ? "Tap \u2630, then Settings, to turn it on again." : "Press " + SETTINGS_KEY.toUpperCase() + " to open Settings and turn it on again."));
    }, subBack);
    return;
  }

  section("Display and text");
  let g = grid();
  g.appendChild(bigButton(guideHidden ? "Show guide" : "Hide guide", chipBg, () => { toggleGuide(true); renderTitle(); }, chip));
  g.appendChild(bigButton(hudHidden ? "Show position" : "Hide position", chipBg, () => { toggleHud(); renderTitle(); }, chip));
  g.appendChild(bigButton(grayHidden ? "Show gray text" : "Hide gray text", chipBg, () => { toggleGray(); renderTitle(); }, chip));
  g.appendChild(bigButton(revealOn ? "Turn off reveal" : "Turn on reveal", chipBg, () => { toggleReveal(); renderTitle(); }, chip));
  g.appendChild(bigButton(showDojos ? "Hide tiger dojos" : "\u26a0 Show tiger dojos (spoilers)", chipBg, () => {
    if (showDojos) { toggleDojos(); renderTitle(); } else { titleSub = "dojos"; titleMsg = ""; renderTitle(); }
  }, showDojos ? chip : Object.assign({}, chip, { color: "#ffd08a" })));
  section("Saves");
  g = grid();
  g.appendChild(bigButton("Export saves", chipBg, () => { titleSub = "export"; titleMsg = ""; renderTitle(); }, chip));
  g.appendChild(bigButton("Import saves", chipBg, () => { titleSub = "import"; titleMsg = ""; titleDraft = ""; renderTitle(); }, chip));
  section("Main menu");
  panel.appendChild(bigButton("Turn off main menu", chipBg, () => { titleSub = "menuOff"; titleMsg = ""; renderTitle(); }, chip));
  section("Progress");
  panel.appendChild(bigButton("Reset checkmarks", "#8a1010", () => { titleSub = "reset"; titleMsg = ""; renderTitle(); }, chip));
  if (titleMsg) note(titleMsg);
  titleBack(wrap);
}

// Esc, shortcut keys, arrows, space... never reach the game or our small menus while the title screen is open.
// (Typing inside the save-code box still works, and Ctrl/Alt/Cmd shortcuts and F-keys are left alone.)
function blockKeysWhileTitle(e) {
  if (!titleBox || videoBox) return;
  if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return;
  if (isTyping(e) && titleBox.contains(e.target)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}
["keydown", "keyup", "keypress"].forEach((t) => window.addEventListener(t, blockKeysWhileTitle, true));

function relayoutTitle() {
  if (!titleBox) return;
  const c = isCompactScreen();
  if (c !== titleCompact) { titleCompact = c; renderTitle(); }
  else if (isWideScreen() !== titleWide && titleView === "home") renderTitle(); // crossing the big-screen size: resize the picture
}
window.addEventListener("resize", relayoutTitle);
window.addEventListener("orientationchange", () => setTimeout(relayoutTitle, 150));

// Shown while you are on the plain main page ("/"); removed when you go anywhere else.
function updateTitle() {
  if (!TITLE_SCREEN) return;
  if (!titleEnabled) { if (titleBox) closeTitle(); return; } // turned off in Settings
  if (currentPath() === "/") openTitle();
  else if (titleBox) closeTitle();
}

// ================= Flowchart positioning =================
// The flowchart pages (/fate, /ubw, /hf) show one big chart made of day squares. When one of them opens
// the page scrolls to the right place by itself:
//   - the Prologue button: the Prologue square, centred on its middle box ("1 day ago - Prologue")
//   - a route page: the last scene you opened in that route, or else that route's first big square
// It runs once on arrival and stops as soon as you scroll, touch or press a key yourself.
const FLOW_PAGES = { "/fate": "fate", "/ubw": "ubw", "/hf": "hf" };
const FLOW_ROUTE_ATTR = { fate: "\u30bb", ubw: "\u51db", hf: "\u685c" }; // the squares' route="" values (Fate, UBW, HF)
const FLOW_PROLOGUE_ATTR = "\u30d7";
let lastScenes = {};
let flowPath = null, flowTimer = null, flowStop = null;
store.get("fsnLastScenes", {}, (v) => { lastScenes = v && typeof v === "object" ? v : {}; });

// Remember the last scene opened in each route (scene pages look like /ubw/3rd-day/9).
function recordLastScene(path) {
  const seg = path.split("/").filter(Boolean);
  if (seg.length < 3) return;
  const r = seg[0].toLowerCase();
  const route = r === "fate" ? "fate" : r === "ubw" ? "ubw" : r === "hf" ? "hf" : null;
  if (!route || lastScenes[route] === path) return;
  lastScenes[route] = path;
  store.set("fsnLastScenes", lastScenes);
}

function stopFlowJump() {
  if (flowTimer) { clearInterval(flowTimer); flowTimer = null; }
  if (flowStop) { flowStop(); flowStop = null; }
}

function flowTarget(route, mode) {
  if (mode === "top") { // Prologue button: centre the middle Prologue box ("1 day ago - Prologue"), so the whole square is in view
    const mid = document.querySelector('a.graph-item[href="/prologue/2"]');
    if (mid) return { el: mid, block: "center" };
    return { el: document.querySelector('.section-day[route="' + FLOW_PROLOGUE_ATTR + '"]') || document.querySelector(".section-day"), block: "top" };
  }
  const last = lastScenes[route];
  if (last) {
    const box = [...document.querySelectorAll("a.graph-item")].find((x) => {
      try { return normPath(new URL(x.getAttribute("href") || "", location.href).pathname) === last; } catch (err) { return false; }
    });
    if (box) return { el: box, block: "center" };
  }
  let sq = document.querySelector('.section-day[route="' + FLOW_ROUTE_ATTR[route] + '"]');
  if (!sq) {
    const a = document.querySelector('a.graph-item[href^="/' + route + '/"]');
    sq = a && (a.closest(".section-day") || a);
  }
  return sq ? { el: sq, block: "start" } : null;
}

function applyFlowJump(route, mode) {
  const t = flowTarget(route, mode);
  if (!t) return false;
  if (t.block === "top") {
    if (t.el) t.el.scrollIntoView({ block: "start", inline: "center", behavior: "auto" });
    window.scrollTo(window.scrollX, 0);
    return true;
  }
  t.el.scrollIntoView({ block: t.block, inline: "center", behavior: "auto" });
  if (t.block === "start") window.scrollBy(0, -16); // leave the square's title ("3rd Day") in view
  return true;
}

function startFlowJump(route, firstLoad) {
  stopFlowJump();
  let mode = null;
  store.get("fsnJump", null, (j) => {
    if (j && j.type === "prologue" && Date.now() - (j.t || 0) < 30000) mode = "top";
  });
  store.set("fsnJump", null);
  if (!mode && firstLoad) { // reload / back button: the browser puts you back where you were
    let nav = "";
    try { nav = (performance.getEntriesByType("navigation")[0] || {}).type || ""; } catch (err) { /* ignore */ }
    if (nav === "back_forward" || nav === "reload") return;
  }
  const events = ["wheel", "touchstart", "mousedown", "keydown"];
  const stop = () => stopFlowJump();
  events.forEach((ev) => window.addEventListener(ev, stop, { capture: true, passive: true }));
  flowStop = () => events.forEach((ev) => window.removeEventListener(ev, stop, true));
  const t0 = Date.now();
  let firstOk = 0, again = 0;
  flowTimer = setInterval(() => {
    if (!firstOk) { // the chart is built by the site after the page loads: wait for it
      if (applyFlowJump(route, mode)) firstOk = Date.now();
      else if (Date.now() - t0 > 10000) stopFlowJump();
      return;
    }
    const dt = Date.now() - firstOk; // apply again a little later, in case the layout was still settling
    if (dt > 500 && again === 0) { again = 1; applyFlowJump(route, mode); }
    else if (dt > 1500) { applyFlowJump(route, mode); stopFlowJump(); }
  }, 150);
}

function checkFlowPage() {
  const p = currentPath();
  if (p === flowPath) return;
  const first = flowPath === null;
  flowPath = p;
  if (FLOW_PAGES[p]) startFlowJump(FLOW_PAGES[p], first); else stopFlowJump();
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
    background: "rgba(15,15,15,0.94)", color: "#fff", padding: "12px 14px",
    font: "16px sans-serif", maxWidth: "min(300px, 80vw)", boxSizing: "border-box",
    borderRadius: "8px", boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
    border: "1px solid #e0a800", pointerEvents: "none", order: "2"
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
  updateTitle();
  checkFlowPage();
  updateHud(false);
  updateMenuBtn();
  applyTextFilter();
  updateGuide(false); // the site is a single-page app, so we poll for changes
  watchScene();
  tickIdle();
  checkArrival();
}
window.addEventListener("hashchange", tick);
window.addEventListener("popstate", tick);
setInterval(tick, 300);
