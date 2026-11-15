// trwm browser demo: a small dwm-style tiling WM mock-up.
// Everything lives in this file: layouts, bar, launcher, locker, config hot-reload.

const $ = id => document.getElementById(id);
const wm = $("wm");
const frame = $("frame");
const tagsEl = $("tags");
const layoutEl = $("layout");
const titleEl = $("title");
const statusEl = $("status");
const emptyEl = $("empty");

const TAGS = 9;
const BAR_H = 22;
const PASSWORD = "trwm";
const LAYOUTS = { spiral: "S", dwindle: "D", tile: "[]=", bstack: "TTT", grid: "###", deck: "[D]", monocle: "[M]" };
const SPLIT = new Set(["spiral", "dwindle"]);
const LAYOUT_NAMES = Object.keys(LAYOUTS);

const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- config

const DEFAULT_CONFIG = `-- trwm config: edit me, it reloads as you type.
-- Try a typo to see how errors are handled.

trwm.layout    = "spiral" -- spiral dwindle tile bstack grid deck monocle
trwm.gaps      = 8
trwm.smartgaps = true
trwm.border    = 2
trwm.mfact     = 0.55
trwm.nmaster   = 1

trwm.bar_top   = true
trwm.accent    = "#a78bfa"
trwm.bar_bg    = "#2a2140"
trwm.bar_fg    = "#d8cff0"
trwm.wallpaper = "#15111f"
`;

const OPTIONS = {
  layout: { type: "string", oneOf: LAYOUT_NAMES, def: "spiral" },
  gaps: { type: "number", min: 0, max: 40, def: 8 },
  smartgaps: { type: "boolean", def: true },
  border: { type: "number", min: 0, max: 8, def: 2 },
  mfact: { type: "number", min: 0.1, max: 0.9, def: 0.55 },
  nmaster: { type: "number", min: 0, max: 5, int: true, def: 1 },
  bar_top: { type: "boolean", def: true },
  accent: { type: "color", def: "#a78bfa" },
  bar_bg: { type: "color", def: "#2a2140" },
  bar_fg: { type: "color", def: "#d8cff0" },
  wallpaper: { type: "color", def: "#15111f" },
};

// A tiny parser for `trwm.key = value` lines, with Lua-ish error messages.
function parseConfig(text) {
  const cfg = Object.fromEntries(Object.entries(OPTIONS).map(([k, o]) => [k, o.def]));
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const where = `config.lua:${i + 1}:`;
    const line = lines[i].replace(/--.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^trwm\.(\w+)\s*=\s*(.+?)\s*,?$/);
    if (!m) return { error: `${where} syntax error near '${line.split(/\s+/)[0]}'` };
    const [, key, raw] = m;
    const opt = OPTIONS[key];
    if (!opt) return { error: `${where} unknown option 'trwm.${key}'` };

    let val;
    if (/^-?\d+(\.\d+)?$/.test(raw)) val = Number(raw);
    else if (raw === "true" || raw === "false") val = raw === "true";
    else if (/^"[^"]*"$|^'[^']*'$/.test(raw)) val = raw.slice(1, -1);
    else return { error: `${where} unexpected symbol near '${raw}'` };

    const t = opt.type === "color" ? "string" : opt.type;
    if (typeof val !== t) return { error: `${where} trwm.${key} expects a ${opt.type}` };
    if (opt.type === "number") {
      if (opt.int && !Number.isInteger(val)) return { error: `${where} trwm.${key} must be a whole number` };
      if (val < opt.min || val > opt.max) return { error: `${where} trwm.${key} must be ${opt.min}–${opt.max}` };
    }
    if (opt.type === "color" && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val)) return { error: `${where} trwm.${key}: bad colour '${val}'` };
    if (opt.oneOf && !opt.oneOf.includes(val)) return { error: `${where} trwm.${key}: unknown layout '${val}'` };
    cfg[key] = val;
  }
  return { cfg };
}

// ---------------------------------------------------------------- state

const S = {
  cfg: parseConfig(DEFAULT_CONFIG).cfg,
  configText: DEFAULT_CONFIG,
  error: null,
  layout: "spiral",
  prevLayout: "dwindle",
  gaps: 8,
  mfact: 0.55,
  nmaster: 1,
  tag: 0,
  prevTag: 0,
  clients: [], // stacking/tiling order, like dwm's client list
  focus: Array(TAGS).fill(null),
  trees: Array(TAGS).fill(null), // split tree per tag for spiral / dwindle
  pointer: null, // last mouse position inside the screen
  nextId: 1,
  mode: "normal", // normal | launcher | lock | help | msg
};
const els = new Map();

// ---------------------------------------------------------------- programs

const NEOFETCH = [
  ["   .-----.    ", "<span class=p>tuke</span>@<span class=p>gentoo</span>"],
  [" .`    _  `.  ", "<span class=d>-----------</span>"],
  [" `.   (_)   `.", "<span class=p>OS</span>: Gentoo Linux x86_64"],
  ["   `.        /", "<span class=p>Kernel</span>: 7.3.4-shark"],
  ["  .`       .` ", "<span class=p>WM</span>: trwm"],
  [" /       .`   ", "<span class=p>Shell</span>: bash 5.3"],
  [" \\____.-`     ", "<span class=p>Terminal</span>: kitty"],
  ["              ", "<span class=p>Editor</span>: nvim"],
];

const CRATES = ["libc", "bitflags", "x11-dl", "mlua", "lua-src", "pam-sys", "chrono", "serde", "toml", "trwm"];

const PROGRAMS = {
  kitty: {
    desc: "terminal",
    title: () => "kitty",
    init: () => `<span class=p>tuke@gentoo</span> <span class=d>~</span> $ <span class=cursor>█</span>`,
  },
  nvim: {
    desc: "editor",
    title: () => "nvim ~/.config/trwm/config.lua",
    init: () => S.configText.split("\n").map((l, i) =>
      `<span class=d>${String(i + 1).padStart(3)}</span> ${l.startsWith("--") ? `<span class=d>${esc(l)}</span>` : esc(l)}`
    ).join("\n"),
  },
  htop: {
    desc: "process viewer",
    title: () => "htop",
    every: 10,
    init: () => "",
    tick(c) {
      c.cpu = (c.cpu || [20, 10, 35, 5]).map(v => clamp(v + rand(-12, 12), 1, 98));
      const bar = (p, w = 18) => {
        const n = Math.round(p / 100 * w);
        return `<span class=g>${"|".repeat(n)}</span>${" ".repeat(w - n)}`;
      };
      const mem = 3.1 + Math.sin(Date.now() / 4000) * 0.2;
      const procs = [["trwm", 0.3], ["kitty", 1.2], ["nvim", 0.6], ["cava", 2.4], ["pipewire", 0.9], ["cargo", 0]]
        .map(([n, b]) => [n, b + rand(0, 2)]).sort((a, b) => b[1] - a[1]);
      return c.cpu.map((v, i) => `${i} [${bar(v)}${v.toFixed(1).padStart(5)}%]`).join("\n") +
        `\nMem[${bar(mem / 16 * 100)}${mem.toFixed(1)}G/16G]\n\n<span class=d>  PID  CPU% COMMAND</span>\n` +
        procs.map(([n, p], i) => `${String(1200 + i * 37).padStart(5)} ${p.toFixed(1).padStart(5)} ${n}`).join("\n");
    },
  },
  neofetch: {
    desc: "system info",
    title: () => "neofetch",
    init: () => NEOFETCH.map(([a, b]) => `<span class=p>${esc(a)}</span>  ${b}`).join("\n") +
      `\n\n${["#2a2140", "#a78bfa", "#7ee2a8", "#f3d27a", "#ff8a8a", "#8ec5ff"].map(c => `<span style="color:${c}">███</span>`).join("")}`,
  },
  cava: {
    desc: "audio visualiser",
    title: () => "cava",
    every: 1,
    init: () => `<div class="cava">${"<i></i>".repeat(28)}</div>`,
    tick(c, body) {
      const t = Date.now() / 300;
      body.querySelectorAll("i").forEach((b, i) => {
        const h = 15 + 40 * Math.abs(Math.sin(t + i * 0.45)) * Math.abs(Math.sin(t / 3 + i / 7)) + rand(0, 40);
        b.style.height = Math.min(100, h) + "%";
      });
      return null;
    },
  },
  cargo: {
    desc: "build trwm",
    title: () => "cargo build --release",
    every: 4,
    init: () => "",
    tick(c) {
      c.step = (c.step || 0) + 1;
      const n = Math.min(c.step, CRATES.length);
      let out = CRATES.slice(0, n).map(k => `   <span class=g>Compiling</span> ${k} v0.${(k.length * 7) % 10}.${k.length}`).join("\n");
      if (c.step > CRATES.length) {
        out += `\n    <span class=g>Finished</span> release [optimized] in ${(CRATES.length * 0.4).toFixed(1)}s` +
          `\n<span class=p>tuke@gentoo</span> <span class=d>~/trwm</span> $ <span class=cursor>█</span>`;
        c.done = true;
      }
      return out;
    },
  },
};

// ---------------------------------------------------------------- clients

const visible = () => S.clients.filter(c => c.tag === S.tag);
const tiledOf = list => list.filter(c => !c.floating && !c.fs);

function focused() {
  const vis = visible();
  return vis.find(c => c.id === S.focus[S.tag]) || vis[0] || null;
}

function setFocus(c) {
  if (c) S.focus[c.tag] = c.id;
}

function spawn(prog, animate = true) {
  if (visible().length >= 10) return flashTitle("too many windows on this tag");
  const c = { id: S.nextId++, prog, tag: S.tag, floating: false, fs: false, splitOf: focused()?.id ?? null };
  S.clients.unshift(c); // new clients go to the top of the stack, like dwm
  setFocus(c);
  render(animate ? c.id : null);
}

function kill() {
  const c = focused();
  if (!c) return;
  const vis = visible();
  const i = vis.indexOf(c);
  S.clients.splice(S.clients.indexOf(c), 1);
  els.get(c.id)?.remove();
  els.delete(c.id);
  const rest = visible();
  S.focus[S.tag] = rest.length ? rest[Math.min(i, rest.length - 1)].id : null;
  render();
}

function focusDir(d) {
  const vis = visible();
  const c = focused();
  if (!c || vis.length < 2) return;
  setFocus(vis[(vis.indexOf(c) + d + vis.length) % vis.length]);
  render();
}

function moveToFront(c) {
  S.clients.splice(S.clients.indexOf(c), 1);
  S.clients.unshift(c);
}

function zoom() {
  const c = focused();
  const tiled = tiledOf(visible());
  if (!c || c.floating || tiled.length < 2) return;
  if (SPLIT.has(S.layout)) {
    // split layouts: swap places with the first window in the tree
    const t = S.trees[S.tag];
    const first = t && leaves(t)[0];
    if (t && first !== c.id) swapLeaves(t, c.id, first);
    return render();
  }
  const target = c === tiled[0] ? tiled[1] : c;
  moveToFront(target);
  setFocus(target);
  render();
}

function toggleFloat() {
  const c = focused();
  if (!c || c.fs) return;
  c.floating = !c.floating;
  if (c.floating) {
    const a = workArea();
    c.fw = Math.round(a.w * 0.5);
    c.fh = Math.round(a.h * 0.55);
    c.fx = Math.round(a.x + (a.w - c.fw) / 2 + (c.id % 4) * 14);
    c.fy = Math.round(a.y + (a.h - c.fh) / 2 + (c.id % 4) * 14);
  }
  render();
}

function toggleFullscreen() {
  const c = focused();
  if (!c) return;
  c.fs = !c.fs;
  render();
}

function view(n) {
  if (n === S.tag) n = S.prevTag; // pressing the current tag jumps back, like dwm's view toggle
  S.prevTag = S.tag;
  S.tag = n;
  render();
}

function moveToTag(n) {
  const c = focused();
  if (!c || n === S.tag) return;
  c.tag = n;
  c.splitOf = S.focus[n];
  S.focus[n] = c.id;
  const rest = visible();
  S.focus[S.tag] = rest[0]?.id ?? null;
  render();
}

function setLayout(name) {
  if (name !== S.layout) S.prevLayout = S.layout;
  S.layout = name;
  render();
}

const toggleLayout = (a, b) => setLayout(S.layout === a ? b : a);

// Mod+h / Mod+l: master size in dwm layouts, the split next to the window in split layouts
function resizeMaster(d) {
  const t = S.trees[S.tag];
  const c = focused();
  if (SPLIT.has(S.layout)) {
    if (t && c) resizeLeaf(t, c.id, d);
  } else {
    S.mfact = clamp(S.mfact + d, 0.1, 0.9);
  }
  render();
}

const cycleLayout = () => setLayout(LAYOUT_NAMES[(LAYOUT_NAMES.indexOf(S.layout) + 1) % LAYOUT_NAMES.length]);

// ---------------------------------------------------------------- layouts

function workArea() {
  const W = wm.clientWidth, H = wm.clientHeight;
  return { x: 0, y: S.cfg.bar_top ? BAR_H : 0, w: W, h: H - BAR_H };
}

// Split a rect into k parts along one axis, with gap g between them.
function split(x, y, w, h, k, vertical, g) {
  const out = [];
  for (let i = 0; i < k; i++) {
    if (vertical) {
      const sh = (h - g * (k - 1)) / k;
      out.push([x, y + i * (sh + g), w, sh]);
    } else {
      const sw = (w - g * (k - 1)) / k;
      out.push([x + i * (sw + g), y, sw, h]);
    }
  }
  return out;
}

// ---- split tree (a port of trwm's src/bsp.rs)
// A node is { leaf: id } or { ratio, a, b }.

function leaves(n, out = []) {
  if (n.leaf != null) out.push(n.leaf);
  else { leaves(n.a, out); leaves(n.b, out); }
  return out;
}

function depthOf(n, id) {
  if (n.leaf != null) return n.leaf === id ? 0 : null;
  const d = depthOf(n.a, id) ?? depthOf(n.b, id);
  return d == null ? null : d + 1;
}

function insertLeaf(n, target, id, first) {
  if (n.leaf != null) {
    if (n.leaf !== target) return false;
    const [a, b] = first ? [id, target] : [target, id];
    delete n.leaf;
    Object.assign(n, { ratio: 0.5, a: { leaf: a }, b: { leaf: b } });
    return true;
  }
  return insertLeaf(n.a, target, id, first) || insertLeaf(n.b, target, id, first);
}

// Remove a window; its sibling takes over the parent's space.
function removeLeaf(n, id) {
  if (n.leaf != null) return n.leaf === id ? null : n;
  const a = removeLeaf(n.a, id), b = removeLeaf(n.b, id);
  if (a && b) { n.a = a; n.b = b; return n; }
  return a || b;
}

function swapLeaves(n, x, y) {
  if (n.leaf != null) n.leaf = n.leaf === x ? y : n.leaf === y ? x : n.leaf;
  else { swapLeaves(n.a, x, y); swapLeaves(n.b, x, y); }
}

function resizeLeaf(n, id, d) {
  if (n.leaf != null) return false;
  if (resizeLeaf(n.a, id, d) || resizeLeaf(n.b, id, d)) return true; // deepest split wins
  const inA = n.a.leaf === id, inB = n.b.leaf === id;
  if (!inA && !inB) return false;
  n.ratio = clamp(n.ratio + (inA ? d : -d), 0.1, 0.9);
  return true;
}

// spiral: splits alternate side by side / top and bottom with depth;
// dwindle: wide spaces split side by side, tall ones top/bottom.
function layoutTree(n, [x, y, w, h], g, spiral, depth = 0, out = new Map()) {
  if (n.leaf != null) { out.set(n.leaf, [x, y, w, h]); return out; }
  if (spiral ? depth % 2 === 0 : w >= h) {
    const f = (w - g) * n.ratio;
    layoutTree(n.a, [x, y, f, h], g, spiral, depth + 1, out);
    layoutTree(n.b, [x + f + g, y, w - f - g, h], g, spiral, depth + 1, out);
  } else {
    const f = (h - g) * n.ratio;
    layoutTree(n.a, [x, y, w, f], g, spiral, depth + 1, out);
    layoutTree(n.b, [x, y + f + g, w, h - f - g], g, spiral, depth + 1, out);
  }
  return out;
}

// Bring the tag's tree in line with its tiled windows, then lay it out.
// New windows split the window under the mouse (or the one that had focus),
// like trwm: spiral puts them right, bottom, left, top, ...; dwindle uses
// the half of the window the mouse is on.
function arrangeSplit(tiled, a) {
  const g = S.cfg.smartgaps && tiled.length === 1 ? 0 : S.gaps;
  const area = [a.x + g, a.y + g, a.w - 2 * g, a.h - 2 * g];
  const spiral = S.layout === "spiral";
  const ids = new Set(tiled.map(c => c.id));
  let t = S.trees[S.tag];
  if (t) for (const id of leaves(t)) if (!ids.has(id)) t = removeLeaf(t, id);

  const old = t ? layoutTree(t, area, g, spiral) : new Map();
  const under = S.pointer && [...old].find(([, [x, y, w, h]]) =>
    S.pointer.x >= x && S.pointer.x < x + w && S.pointer.y >= y && S.pointer.y < y + h);

  for (const c of [...tiled].reverse()) { // oldest first
    if (!t) { t = { leaf: c.id }; continue; }
    const have = leaves(t);
    if (have.includes(c.id)) continue;
    const target = under && old.has(under[0]) ? under[0]
      : have.includes(c.splitOf) ? c.splitOf : have[have.length - 1];
    let first = false;
    if (spiral) first = depthOf(t, target) % 4 >= 2;
    else if (under && under[0] === target) {
      const [x, y, w, h] = under[1];
      first = w >= h ? S.pointer.x < x + w / 2 : S.pointer.y < y + h / 2;
    }
    insertLeaf(t, target, c.id, first);
  }
  S.trees[S.tag] = t;
  if (!t) return [];
  const rects = layoutTree(t, area, g, spiral);
  return tiled.map(c => rects.get(c.id));
}

function arrange(name, n, a) {
  if (!n) return [];
  const g = S.cfg.smartgaps && n === 1 ? 0 : S.gaps;
  const x = a.x + g, y = a.y + g, W = a.w - 2 * g, H = a.h - 2 * g;
  if (name === "monocle") return Array.from({ length: n }, () => [x, y, W, H]);

  if (name === "grid") {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const out = [];
    split(x, y, W, H, rows, true, g).forEach(([rx, ry, rw, rh], r) => {
      const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
      out.push(...split(rx, ry, rw, rh, inRow, false, g));
    });
    return out;
  }

  const nm = Math.min(S.nmaster, n);
  const ns = n - nm;
  const vertical = name !== "bstack";
  const total = vertical ? W : H;
  const m = nm && ns ? Math.round((total - g) * S.mfact) : nm ? total : 0;
  const s = total - m - (nm && ns ? g : 0);

  let master = [], stack = [];
  if (vertical) {
    if (nm) master = split(x, y, m, H, nm, true, g);
    if (ns) {
      const sx = x + (nm ? m + g : 0);
      stack = name === "deck"
        ? Array.from({ length: ns }, () => [sx, y, s, H])
        : split(sx, y, s, H, ns, true, g);
    }
  } else {
    if (nm) master = split(x, y, W, m, nm, false, g);
    if (ns) stack = split(x, y + (nm ? m + g : 0), W, s, ns, false, g);
  }
  return [...master, ...stack];
}

// ---------------------------------------------------------------- rendering

function makeWindow(c) {
  const p = PROGRAMS[c.prog];
  const el = document.createElement("div");
  el.className = "win";
  el.innerHTML = `<div class="win-title"></div><div class="win-body"></div><div class="win-resize"></div>`;
  el.querySelector(".win-title").textContent = p.title();
  const body = el.querySelector(".win-body");
  body.innerHTML = p.init(c);
  if (p.tick) {
    const out = p.tick(c, body);
    if (out != null) body.innerHTML = out;
  }
  el.addEventListener("pointerdown", () => {
    if (S.mode !== "normal") return;
    setFocus(c);
    render();
  });
  el.querySelector(".win-title").addEventListener("pointerdown", e => startDrag(c, e, "move"));
  el.querySelector(".win-resize").addEventListener("pointerdown", e => startDrag(c, e, "resize"));
  wm.insertBefore(el, $("launcher"));
  els.set(c.id, el);
  return el;
}

function render(newId = null) {
  const W = wm.clientWidth, H = wm.clientHeight;
  const a = workArea();
  const vis = visible();
  const f = focused();
  const tiled = tiledOf(vis);
  const rects = SPLIT.has(S.layout) ? arrangeSplit(tiled, a) : arrange(S.layout, tiled.length, a);
  const nm = Math.min(S.nmaster, tiled.length);

  let monocleShown = null, deckShown = null;
  if (S.layout === "monocle") monocleShown = tiled.includes(f) ? f : tiled[0];
  if (S.layout === "deck") {
    const stack = tiled.slice(nm);
    deckShown = stack.includes(f) ? f : stack[0];
  }

  for (const c of S.clients) {
    const el = els.get(c.id) || makeWindow(c);
    if (c.tag !== S.tag) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "";
    let r, z = 1, hidden = false;
    if (c.fs) {
      r = [0, 0, W, H];
      z = 20;
    } else if (c.floating) {
      c.fw = clamp(c.fw, 140, W);
      c.fh = clamp(c.fh, 90, H);
      c.fx = clamp(c.fx, -c.fw + 40, W - 40);
      c.fy = clamp(c.fy, 0, H - 30);
      r = [c.fx, c.fy, c.fw, c.fh];
      z = 6;
    } else {
      const i = tiled.indexOf(c);
      r = rects[i];
      hidden = (monocleShown && c !== monocleShown) || (deckShown && i >= nm && c !== deckShown);
    }
    if (c === f) z += 1;
    Object.assign(el.style, {
      left: r[0] + "px", top: r[1] + "px",
      width: Math.max(0, r[2]) + "px", height: Math.max(0, r[3]) + "px",
      zIndex: z, visibility: hidden ? "hidden" : "",
    });
    el.classList.toggle("focus", c === f);
    el.classList.toggle("floating", c.floating && !c.fs);
    if (c.id === newId) {
      el.classList.add("new");
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("new")));
    }
  }

  emptyEl.hidden = vis.length > 0;
  renderBar(tiled.length);
}

let flashTimer;
function flashTitle(text) {
  titleEl.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => renderBar(), 1500);
}

function renderBar(nTiled = tiledOf(visible()).length) {
  tagsEl.replaceChildren(...Array.from({ length: TAGS }, (_, i) => {
    const s = document.createElement("span");
    s.textContent = i + 1;
    if (i === S.tag) s.classList.add("sel");
    if (S.clients.some(c => c.tag === i)) s.classList.add("used");
    s.addEventListener("pointerdown", e => {
      e.stopPropagation();
      if (S.mode === "normal") view(i);
    });
    return s;
  }));
  layoutEl.textContent = S.layout === "monocle" ? `[${nTiled}]` : LAYOUTS[S.layout];
  if (S.error) {
    titleEl.textContent = S.error;
    titleEl.classList.add("error");
  } else {
    const f = focused();
    titleEl.textContent = f ? PROGRAMS[f.prog].title() : "";
    titleEl.classList.remove("error");
  }
}

// ---------------------------------------------------------------- mouse: move / resize / snap

function startDrag(c, e, kind) {
  if (S.mode !== "normal" || c.fs || e.button > 0) return;
  e.preventDefault();
  e.stopPropagation();
  const el = els.get(c.id);
  if (!c.floating) {
    // Dragging a tiled window turns it floating at its current size, like dwm's movemouse
    c.floating = true;
    c.fx = el.offsetLeft; c.fy = el.offsetTop;
    c.fw = el.offsetWidth; c.fh = el.offsetHeight;
  }
  setFocus(c);
  wm.focus({ preventScroll: true });
  wm.classList.add("dragging");
  render();

  const sx = e.clientX, sy = e.clientY;
  const ox = c.fx, oy = c.fy, ow = c.fw, oh = c.fh;
  const SNAP = 14;
  const move = ev => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    const a = workArea();
    if (kind === "move") {
      let x = ox + dx, y = oy + dy;
      if (Math.abs(x - a.x) < SNAP) x = a.x;
      if (Math.abs(x + c.fw - (a.x + a.w)) < SNAP) x = a.x + a.w - c.fw;
      if (Math.abs(y - a.y) < SNAP) y = a.y;
      if (Math.abs(y + c.fh - (a.y + a.h)) < SNAP) y = a.y + a.h - c.fh;
      c.fx = x; c.fy = y;
    } else {
      c.fw = Math.max(140, ow + dx);
      c.fh = Math.max(90, oh + dy);
    }
    render();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    wm.classList.remove("dragging");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------- launcher (rofi-like)

const launcher = $("launcher");
const lInput = $("launcher-input");
const lList = $("launcher-list");
let lSel = 0;

function launcherMatches() {
  const q = lInput.value.trim().toLowerCase();
  return Object.keys(PROGRAMS).filter(n => n.includes(q) || PROGRAMS[n].desc.includes(q));
}

function drawLauncher() {
  const items = launcherMatches();
  lSel = clamp(lSel, 0, Math.max(0, items.length - 1));
  lList.replaceChildren(...items.map((n, i) => {
    const li = document.createElement("li");
    li.innerHTML = `${n}<span>${PROGRAMS[n].desc}</span>`;
    if (i === lSel) li.classList.add("sel");
    li.addEventListener("pointerdown", e => {
      e.preventDefault();
      closeLauncher();
      spawn(n);
    });
    return li;
  }));
}

function openLauncher() {
  S.mode = "launcher";
  launcher.hidden = false;
  lInput.value = "";
  lSel = 0;
  drawLauncher();
  lInput.focus({ preventScroll: true });
}

function closeLauncher() {
  S.mode = "normal";
  launcher.hidden = true;
  wm.focus({ preventScroll: true });
}

lInput.addEventListener("input", () => { lSel = 0; drawLauncher(); });

function launcherKey(e) {
  const items = launcherMatches();
  if (e.key === "Escape") closeLauncher();
  else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) { lSel = (lSel + 1) % Math.max(1, items.length); drawLauncher(); }
  else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) { lSel = (lSel - 1 + items.length) % Math.max(1, items.length); drawLauncher(); }
  else if (e.key === "Enter") {
    const n = items[lSel];
    closeLauncher();
    if (n) spawn(n);
  } else return false; // let the input handle normal typing
  return true;
}

// ---------------------------------------------------------------- screen locker (slock colours)

const lock = $("lock");
let lockBuf = "";

function lockScreen() {
  S.mode = "lock";
  lockBuf = "";
  lock.className = "overlay lock";
  lock.hidden = false;
  tickClock();
}

function lockKey(e) {
  if (e.key === "Enter") {
    if (lockBuf === PASSWORD) {
      lock.hidden = true;
      S.mode = "normal";
      return true;
    }
    lockBuf = "";
    lock.className = "overlay lock failed";
  } else if (e.key === "Escape") {
    lockBuf = "";
    lock.className = "overlay lock";
  } else if (e.key === "Backspace") {
    lockBuf = lockBuf.slice(0, -1);
    lock.className = lockBuf ? "overlay lock input" : "overlay lock";
  } else if (e.key.length === 1) {
    lockBuf += e.key;
    lock.className = "overlay lock input";
  }
  return true;
}

// ---------------------------------------------------------------- help, restart, quit

const KEYS = [
  ["Enter", "open a terminal"],
  ["p", "launcher (rofi)"],
  ["j / k", "focus next / previous"],
  ["z", "swap with master / first window"],
  ["h / l", "shrink / grow master or split"],
  ["i / d", "more / fewer masters"],
  ["r", "spiral ↔ dwindle (split layouts)"],
  ["t b g e m", "tile, bstack, grid, deck, monocle"],
  ["space", "previous layout"],
  ["n", "next layout"],
  ["f", "toggle floating"],
  ["F", "toggle fullscreen"],
  ["1 – 9", "view tag"],
  ["Shift+1 – 9", "move window to tag"],
  ["= / -", "bigger / smaller gaps"],
  ["c", "close window"],
  ["L", "lock the screen"],
  ["R", "restart trwm in place"],
  ["Q", "quit trwm"],
  ["?", "show these keys"],
  ["mouse", "new windows split the window under it"],
  ["drag title", "move (window floats, snaps to edges)"],
  ["drag corner", "resize a floating window"],
];

const keyRow = ([k, d]) => `<div><b>${esc(k)}</b> ${esc(d)}</div>`;
$("help-keys").innerHTML = KEYS.map(keyRow).join("");
$("keys").innerHTML = KEYS.map(([k, d]) => `<div><span class="k">${esc(k)}</span><span>${esc(d)}</span></div>`).join("");

const help = $("help");
function openHelp() { S.mode = "help"; help.hidden = false; }
function closeHelp() { S.mode = "normal"; help.hidden = true; }
help.addEventListener("pointerdown", e => { e.stopPropagation(); closeHelp(); });

const msg = $("msg");
let quitNext = null;

function showMsg(html, then) {
  S.mode = "msg";
  msg.innerHTML = html;
  msg.hidden = false;
  quitNext = then;
}

function hideMsg() {
  msg.hidden = true;
  S.mode = "normal";
  const fn = quitNext;
  quitNext = null;
  fn?.();
}

function restart() {
  showMsg("restarting trwm…<br><span class=d>windows stay on their tags</span>", null);
  setTimeout(() => {
    hideMsg();
    reloadConfig(S.configText, true);
  }, 700);
}

function quit() {
  showMsg("trwm exited.<br><span class=d>press any key to run startx again</span>", () => {
    S.clients.forEach(c => els.get(c.id)?.remove());
    els.clear();
    S.clients = [];
    S.focus.fill(null);
    S.trees.fill(null);
    S.tag = 0;
    reloadConfig(S.configText, true);
  });
}
msg.addEventListener("pointerdown", () => { if (quitNext) hideMsg(); });

// ---------------------------------------------------------------- keyboard

function handleKey(e) {
  if (S.mode === "msg") { if (quitNext) hideMsg(); return true; }
  if (S.mode === "lock") return lockKey(e);
  if (S.mode === "launcher") return launcherKey(e);
  if (S.mode === "help") { closeHelp(); return true; }
  if (e.ctrlKey || e.metaKey) return false;

  const digit = (e.code || "").match(/^Digit([1-9])$/) || (/^[1-9]$/.test(e.key) ? [0, e.key] : null);
  if (digit) {
    const n = +digit[1] - 1;
    e.shiftKey ? moveToTag(n) : view(n);
    return true;
  }

  switch (e.key) {
    case "Enter": spawn("kitty"); break;
    case "p": openLauncher(); break;
    case "c": case "C": kill(); break;
    case "j": focusDir(1); break;
    case "k": focusDir(-1); break;
    case "h": resizeMaster(-0.05); break;
    case "l": resizeMaster(0.05); break;
    case "r": toggleLayout("spiral", "dwindle"); break;
    case "n": cycleLayout(); break;
    case "i": S.nmaster = Math.min(5, S.nmaster + 1); render(); break;
    case "d": S.nmaster = Math.max(0, S.nmaster - 1); render(); break;
    case "z": zoom(); break;
    case "t": setLayout("tile"); break;
    case "b": setLayout("bstack"); break;
    case "g": setLayout("grid"); break;
    case "e": setLayout("deck"); break;
    case "m": setLayout("monocle"); break;
    case " ": e.shiftKey ? toggleFloat() : setLayout(S.prevLayout); break;
    case "f": toggleFloat(); break;
    case "F": toggleFullscreen(); break;
    case "=": case "+": S.gaps = Math.min(40, S.gaps + 2); render(); break;
    case "-": case "_": S.gaps = Math.max(0, S.gaps - 2); render(); break;
    case "L": lockScreen(); break;
    case "R": restart(); break;
    case "Q": quit(); break;
    case "?": openHelp(); break;
    default: return false;
  }
  return true;
}

wm.addEventListener("keydown", e => {
  if (handleKey(e)) e.preventDefault();
});
wm.addEventListener("pointerdown", () => {
  if (S.mode !== "launcher") wm.focus({ preventScroll: true });
});
wm.addEventListener("pointermove", e => {
  if (e.pointerType !== "mouse") return;
  const r = wm.getBoundingClientRect();
  S.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
});
wm.addEventListener("pointerleave", () => { S.pointer = null; });

// On-screen buttons for touch devices
$("touch-keys").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  const key = b.dataset.key;
  handleKey({ key, code: "", shiftKey: false, ctrlKey: false, metaKey: false });
  // Typing on the lock screen needs a keyboard; on touch, unlock straight away.
  if (S.mode === "lock") {
    lockBuf = PASSWORD;
    lock.className = "overlay lock input";
    setTimeout(() => lockKey({ key: "Enter" }), 600);
  }
});

$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else frame.requestFullscreen?.().then(() => wm.focus({ preventScroll: true }));
});

// ---------------------------------------------------------------- config editor (hot reload)

const cfgArea = $("cfg");
const cfgStatus = $("cfg-status");

function reloadConfig(text, quiet = false) {
  const res = parseConfig(text);
  if (res.error) {
    // Like trwm: keep running with the old config and show the error in the bar
    S.error = res.error;
    cfgStatus.textContent = `✗ ${res.error} (kept the previous config)`;
    cfgStatus.className = "cfg-status err";
    renderBar();
    return;
  }
  const c = res.cfg;
  S.cfg = c;
  S.error = null;
  S.configText = text;
  if (c.layout !== S.layout) S.prevLayout = S.layout;
  S.layout = c.layout;
  S.gaps = c.gaps;
  S.mfact = c.mfact;
  S.nmaster = c.nmaster;
  wm.style.setProperty("--accent-wm", c.accent);
  wm.style.setProperty("--bar-bg", c.bar_bg);
  wm.style.setProperty("--bar-fg", c.bar_fg);
  wm.style.setProperty("--wall", c.wallpaper);
  wm.style.setProperty("--bw", c.border + "px");
  wm.classList.toggle("bar-bottom", !c.bar_top);

  // Any open nvim windows show the config, so refresh them
  S.clients.filter(cl => cl.prog === "nvim").forEach(cl => {
    const body = els.get(cl.id)?.querySelector(".win-body");
    if (body) body.innerHTML = PROGRAMS.nvim.init(cl);
  });

  if (!quiet) {
    cfgStatus.textContent = `✓ reloaded at ${new Date().toLocaleTimeString()}`;
    cfgStatus.className = "cfg-status ok";
  }
  render();
}

let cfgTimer;
cfgArea.addEventListener("input", () => {
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => reloadConfig(cfgArea.value), 250);
});
cfgArea.addEventListener("keydown", e => {
  if (e.key === "Tab") {
    e.preventDefault();
    cfgArea.setRangeText("  ", cfgArea.selectionStart, cfgArea.selectionEnd, "end");
    cfgArea.dispatchEvent(new Event("input"));
  }
});
$("cfg-reset").addEventListener("click", () => {
  cfgArea.value = DEFAULT_CONFIG;
  reloadConfig(DEFAULT_CONFIG);
});

// ---------------------------------------------------------------- status bar + program ticks

let cpu = 12;
let battery = null;
navigator.getBattery?.().then(b => {
  battery = b;
  b.addEventListener("levelchange", updateStatus);
}).catch(() => {});

function updateStatus() {
  cpu = clamp(cpu + rand(-6, 6), 2, 60);
  const mem = (3.1 + Math.sin(Date.now() / 4000) * 0.2).toFixed(1);
  const bat = battery ? Math.round(battery.level * 100) : 87;
  const d = new Date();
  const date = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  statusEl.textContent = `cpu ${String(Math.round(cpu)).padStart(2)}%  mem ${mem}G  bat ${bat}%  ${date} ${time}`;
}

function tickClock() {
  $("lock-clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

let tick = 0;
setInterval(() => {
  tick++;
  for (const c of S.clients) {
    const p = PROGRAMS[c.prog];
    if (!p.tick || c.done || c.tag !== S.tag || tick % p.every) continue;
    const body = els.get(c.id)?.querySelector(".win-body");
    if (!body) continue;
    const out = p.tick(c, body);
    if (out != null) body.innerHTML = out;
  }
  if (tick % 10 === 0) {
    updateStatus();
    if (S.mode === "lock") tickClock();
  }
}, 100);

// ---------------------------------------------------------------- start

cfgArea.value = DEFAULT_CONFIG;
reloadConfig(DEFAULT_CONFIG, true);
updateStatus();

// Desktop to start with: tag 1 has an editor setup, tag 2 has music, tag 3 is building trwm
spawn("htop", false);
spawn("neofetch", false);
spawn("nvim", false);
S.tag = 1;
spawn("kitty", false);
spawn("cava", false);
S.tag = 2;
spawn("cargo", false);
S.tag = 0;
S.prevTag = 0;
render();

new ResizeObserver(() => render()).observe(wm);
requestAnimationFrame(() => requestAnimationFrame(() => wm.classList.remove("loading")));
