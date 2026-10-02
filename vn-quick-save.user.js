// ==UserScript==
// @name         VN Quick Save + Route Guide (fatestaynight.vnovel.org)
// @namespace    https://github.com/YOUR-USERNAME/vn-quick-save
// @version      2.1
// @description  S = save menu, L = load menu (6 slots). Shows a route guide on choice screens (H hides it).
// @updateURL    https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @downloadURL  https://raw.githubusercontent.com/DaLavz/FSNBrowserPlus/main/vn-quick-save.user.js
// @match        https://fatestaynight.vnovel.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

// ---- Settings: change the keys here ----
const SAVE_KEY = "s";
const LOAD_KEY = "l";
const SLOTS = 6;
const GUIDE_KEY = "h"; // hides/shows the route guide
// ----------------------------------------

let menu = null;
let mode = null; // "save" | "load" | null
let pending = null; // slot index waiting for overwrite confirmation

function toast(msg) {
  const el = document.createElement("div");
  el.textContent = msg;
  Object.assign(el.style, {
    position: "fixed", top: "16px", right: "16px", zIndex: 2147483647,
    background: "rgba(0,0,0,0.85)", color: "#fff", padding: "10px 16px",
    borderRadius: "6px", font: "14px sans-serif", pointerEvents: "none"
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

// Shows only the part after the domain, e.g. /fate/1st-day/0
function shortPath(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search + u.hash) || "/";
  } catch {
    return url;
  }
}

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

const COLS = "18px 110px 70px 40px 40px";

function getSlots(cb) {
  let slots = GM_getValue("fsnSlots", null);
  if (!Array.isArray(slots)) slots = Array(SLOTS).fill(null);
  while (slots.length < SLOTS) slots.push(null);
  cb(slots);
}

function closeMenu() {
  if (menu) menu.remove();
  menu = null;
  mode = null;
  pending = null;
}

function el(tag, styles, text) {
  const e = document.createElement(tag);
  Object.assign(e.style, styles || {});
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderMenu(slots, message) {
  if (menu) menu.remove();
  const theme = mode === "load"
    ? { border: "#1e6fff", title: "#6fb0ff", row: "rgba(60,130,255,0.14)" }
    : { border: "#b00000", title: "#ff5a5a", row: "rgba(255,255,255,0.06)" };
  menu = el("div", {
    position: "fixed", top: "16px", right: "16px", zIndex: 2147483647,
    background: "rgba(15,15,15,0.94)", color: "#fff", padding: "12px 14px",
    borderRadius: "8px", font: "14px sans-serif", minWidth: "250px",
    boxShadow: "0 4px 18px rgba(0,0,0,0.5)", border: "1px solid " + theme.border
  });

  if (pending !== null && slots[pending]) {
    const i = pending;
    menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "8px", color: theme.title }, "Replace slot " + (i + 1) + "?"));
    menu.appendChild(el("div", { fontSize: "12px", color: "#aaa" }, "Current:"));
    menu.appendChild(el("div", { marginBottom: "6px" }, prettyLabel(slots[i].url)));
    menu.appendChild(el("div", { fontSize: "12px", color: "#aaa" }, "New:"));
    menu.appendChild(el("div", { marginBottom: "8px" }, prettyLabel(location.href)));
    menu.appendChild(el("div", { color: "#ffb35a", fontSize: "12px", marginBottom: "8px" }, "The old save will be deleted."));
    const btns = el("div", { display: "flex", gap: "8px" });
    const mk = (label, bg, fn) => {
      const b = el("div", {
        flex: "1", textAlign: "center", padding: "6px", borderRadius: "4px",
        cursor: "pointer", background: bg, fontWeight: "bold"
      }, label);
      b.addEventListener("click", fn);
      return b;
    };
    btns.appendChild(mk("Yes (Y)", "#b00000", confirmOverwrite));
    btns.appendChild(mk("No (N)", "#444", cancelConfirm));
    menu.appendChild(btns);
    document.body.appendChild(menu);
    return;
  }

  const title = (mode === "save" ? "Save" : "Load") + ": press 1-" + SLOTS;
  menu.appendChild(el("div", { fontWeight: "bold", marginBottom: "8px", color: theme.title }, title));

  const head = el("div", {
    display: "grid", gridTemplateColumns: COLS, gap: "8px", padding: "0 6px 4px",
    color: "#888", fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.5px"
  });
  ["#", "Route", "Scene", "Part", "Page"].forEach((h) => head.appendChild(el("span", {}, h)));
  menu.appendChild(head);

  slots.forEach((slot, i) => {
    const row = el("div", {
      display: "grid", gridTemplateColumns: COLS, gap: "8px", padding: "5px 6px",
      cursor: "pointer", borderRadius: "4px", background: theme.row, marginBottom: "4px"
    });
    row.appendChild(el("span", { fontWeight: "bold" }, String(i + 1)));
    if (slot) {
      const p = parseUrl(slot.url);
      row.appendChild(el("span", {}, p.route));
      row.appendChild(el("span", {}, p.scene));
      row.appendChild(el("span", {}, p.part));
      row.appendChild(el("span", {}, p.page));
    } else {
      row.appendChild(el("span", { color: "#888", gridColumn: "2 / 6" }, "Empty"));
    }
    row.addEventListener("click", () => chooseSlot(i));
    menu.appendChild(row);
  });

  if (mode === "save" && slots.every(Boolean)) {
    menu.appendChild(el("div", { marginTop: "6px", color: "#ffb35a", fontSize: "12px" },
      "All slots are full. The slot you pick will be replaced and its old save deleted."));
  }
  if (message) {
    menu.appendChild(el("div", { marginTop: "6px", color: "#ffb35a", fontSize: "12px" }, message));
  }
  menu.appendChild(el("div", { marginTop: "8px", color: "#888", fontSize: "11px" }, "Esc to close"));
  document.body.appendChild(menu);
}

function openMenu(newMode) {
  mode = newMode;
  getSlots((slots) => renderMenu(slots));
}

function doSave(slots, i) {
  slots[i] = { url: location.href, time: Date.now() };
  GM_setValue("fsnSlots", slots);
  closeMenu();
  toast("Saved to slot " + (i + 1) + " ✔");
}

function confirmOverwrite() {
  if (pending === null) return;
  const i = pending;
  getSlots((slots) => doSave(slots, i));
}

function cancelConfirm() {
  pending = null;
  getSlots((slots) => renderMenu(slots));
}

function chooseSlot(i) {
  getSlots((slots) => {
    if (mode === "save") {
      if (slots[i]) {
        pending = i;
        renderMenu(slots);
        return;
      }
      doSave(slots, i);
    } else if (mode === "load") {
      if (!slots[i]) {
        renderMenu(slots, "Slot " + (i + 1) + " is empty.");
        return;
      }
      const url = slots[i].url;
      closeMenu();
      toast("Loading slot " + (i + 1) + "…");
      location.href = url;
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const key = e.key.toLowerCase();

  if (menu) {
    const n = parseInt(key, 10);
    if (pending !== null) {
      if (key === "y" || key === "enter") {
        e.preventDefault(); e.stopPropagation();
        confirmOverwrite();
      } else if (key === "n" || key === "escape") {
        e.preventDefault(); e.stopPropagation();
        cancelConfirm();
      } else if ((n >= 1 && n <= SLOTS) || key === SAVE_KEY || key === LOAD_KEY) {
        e.preventDefault(); e.stopPropagation();
      }
      return;
    }
    if (n >= 1 && n <= SLOTS) {
      e.preventDefault(); e.stopPropagation();
      chooseSlot(n - 1);
    } else if (key === "escape") {
      e.preventDefault(); e.stopPropagation();
      closeMenu();
    } else if (key === SAVE_KEY || key === LOAD_KEY) {
      e.preventDefault(); e.stopPropagation();
      const wanted = key === SAVE_KEY ? "save" : "load";
      if (wanted === mode) closeMenu(); else openMenu(wanted);
    }
    return;
  }

  if (isTyping(e)) return;
  if (key === SAVE_KEY) openMenu("save");
  else if (key === LOAD_KEY) openMenu("load");
  else if (key === GUIDE_KEY) toggleGuide();
}, true);


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
    borderRadius: "8px", font: "16px sans-serif", maxWidth: "300px",
    boxShadow: "0 4px 18px rgba(0,0,0,0.5)", border: "1px solid #e0a800",
    pointerEvents: "none"
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
  guideBox.appendChild(el("div", { marginTop: "8px", color: "#888", fontSize: "12px" },
    GUIDE_KEY.toUpperCase() + " to hide the guide"));
  document.body.appendChild(guideBox);
}

function toggleGuide() {
  guideHidden = !guideHidden;
  GM_setValue("fsnGuideHidden", guideHidden);
  updateGuide(true);
  toast(guideHidden ? "Guide hidden" : "Guide shown");
}

guideHidden = !!GM_getValue("fsnGuideHidden", false);
updateGuide(true);
window.addEventListener("hashchange", () => updateGuide(false));
window.addEventListener("popstate", () => updateGuide(false));
setInterval(() => updateGuide(false), 300); // the site is a single-page app
