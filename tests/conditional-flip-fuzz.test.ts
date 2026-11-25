/**
 * Property test for dom/sibling-align.ts: random page trees with conditional
 * slots at several depths, whitespace between elements, shared and unique
 * classes, ids and data-keys. Each update is applied twice in lockstep, with
 * sibling alignment on and off (off is main's behaviour), and checked against
 * a fresh render of the full state. Alignment may only ever be better than
 * main, so every invariant that holds without it must hold with it:
 *
 * 1. the page matches a fresh render;
 * 2. no update throws;
 * 3. an element with a data-key present before and after is the same node;
 * 4. an element main keeps (its signature unique among its siblings, same
 *    parent before and after) is not rebuilt.
 *
 * Seeds are fixed so a failure reproduces. FUZZ_SEEDS / FUZZ_SKIP_SEEDS run
 * more; FUZZ_KEYP raises how often elements carry a data-key.
 */
import { LiveTemplateClient } from "../livetemplate-client";

jest.mock("../dom/sibling-align", () => {
  const actual = jest.requireActual("../dom/sibling-align");
  return {
    ...actual,
    alignChildren: (...args: any[]) => ((globalThis as any).__alignOff ? undefined : actual.alignChildren(...args)),
  };
});

// ---------- model ----------
type ClsPart = string | { slot: string };
type ANode =
  | { t: "el"; tag: string; id?: string; cls?: ClsPart[]; key?: string; ignore?: boolean; kids: ANode[] }
  | { t: "text"; v: string }
  | { t: "comment"; v: string }
  | { t: "slot"; id: string };
interface Slot { kind: "el" | "text" | "attr"; branches: (ANode[] | string)[] }
interface Case {
  root: ANode[];
  slots: Record<string, Slot>;
  init: Record<string, number>;
  updates: Record<string, number>[];
  focusSelect?: boolean;
}
interface Opts { skip: boolean } // skip mode: lvt-ignore + focused <select>

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOID = new Set(["input"]);
const KEY_P = Number(process.env.FUZZ_KEYP || 0.25);

function toTree(forest: ANode[], c: Case, vals: Record<string, number>): any {
  const s: string[] = [];
  const dyn: any[] = [];
  let cur = "";
  const slotVal = (id: string): any => {
    const sl = c.slots[id];
    const v = vals[id] ?? -1;
    if (!sl || v < 0 || v >= sl.branches.length) return "";
    const b = sl.branches[v];
    return typeof b === "string" ? b : toTree(b, c, vals);
  };
  const flush = (id: string) => {
    s.push(cur);
    cur = "";
    dyn.push(slotVal(id));
  };
  const walk = (ns: ANode[]) => {
    for (const n of ns) {
      if (n.t === "text") cur += n.v;
      else if (n.t === "comment") cur += `<!--${n.v}-->`;
      else if (n.t === "slot") flush(n.id);
      else {
        cur += `<${n.tag}`;
        if (n.id) cur += ` id="${n.id}"`;
        if (n.cls) {
          cur += ` class="`;
          for (const p of n.cls) {
            if (typeof p === "string") cur += p;
            else flush(p.slot);
          }
          cur += `"`;
        }
        if (n.key) cur += ` data-key="${n.key}"`;
        if (n.ignore) cur += ` lvt-ignore`;
        cur += ">";
        if (!VOID.has(n.tag)) {
          walk(n.kids);
          cur += `</${n.tag}>`;
        }
      }
    }
  };
  walk(forest);
  s.push(cur);
  const tree: any = { s };
  dyn.forEach((d, i) => (tree[i] = d));
  return tree;
}

/** Slots reachable (rendered) under the current values. */
function visibleSlots(c: Case, vals: Record<string, number>): string[] {
  const out: string[] = [];
  const walk = (ns: ANode[]) => {
    for (const n of ns) {
      if (n.t === "slot") {
        out.push(n.id);
        const v = vals[n.id] ?? -1;
        const b = c.slots[n.id]?.branches[v];
        if (v >= 0 && b && typeof b !== "string") walk(b);
      } else if (n.t === "el") {
        for (const p of n.cls || []) if (typeof p !== "string") out.push(p.slot);
        walk(n.kids);
      }
    }
  };
  walk(c.root);
  return out;
}

/** What the server would send: changed slots only, full subtree where statics change. */
function diff(o: any, n: any): any {
  if (typeof o !== "object" || typeof n !== "object") return o === n ? undefined : n;
  if (JSON.stringify(o.s) !== JSON.stringify(n.s)) return n;
  const out: any = {};
  for (const k of Object.keys(n)) {
    if (k === "s") continue;
    const d = diff(o[k], n[k]);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Our own merge of an update into the full state. */
function merge(e: any, u: any): any {
  if (typeof u !== "object" || u === null) return u;
  if (u.s || typeof e !== "object" || e === null) return u;
  const out = { ...e };
  for (const k of Object.keys(u)) out[k] = merge(e[k], u[k]);
  return out;
}

// ---------- generator ----------
function gen(seed: number, opts: Opts): Case {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
  const chance = (p: number) => r() < p;
  const slots: Record<string, Slot> = {};
  const keyTag: Record<string, string> = {};
  let slotN = 0, uniq = 0, txt = 0;
  const MAX_SLOTS = 7;
  const KEYS = ["k0", "k1", "k2", "k3", "k4"];
  const SHARED = ["item", "row", "card", "box"];
  const MODS = ["is-open", "active", "mod"];
  const newSlot = (kind: Slot["kind"], branches: Slot["branches"]): string => {
    const id = "s" + slotN++;
    slots[id] = { kind, branches };
    return id;
  };
  const canSlot = () => slotN < MAX_SLOTS;

  type Ctx = "flow" | "phrasing" | "plain" | "list" | "select";
  const tagFor = (ctx: Ctx): string => {
    switch (ctx) {
      case "list": return "li";
      case "select": return "option";
      case "plain": return pick(["span", "span", "strong", "em"]);
      case "phrasing": return pick(["span", "span", "span", "strong", "em", "button", "a", "input"]);
      default:
        return pick(["div", "div", "div", "div", "section", "section", "p", "span", "ul", "ul", "button", "input",
          opts.skip ? "select" : "div"]);
    }
  };
  const kidCtx = (tag: string): Ctx =>
    tag === "ul" ? "list" : tag === "select" ? "select" :
    ["div", "section", "li"].includes(tag) ? "flow" :
    ["button", "a"].includes(tag) ? "plain" : "phrasing";
  const wsFor = (ctx: Ctx): string =>
    ctx === "list" || ctx === "select"
      ? pick(["", "", "\n", " ", "\n  "])
      : pick(["", "", "\n", " ", "\n  ", "\n    ", " t "]);

  const mkEl = (ctx: Ctx, depth: number): ANode => {
    const tag = tagFor(ctx);
    const el: ANode = { t: "el", tag, kids: [] };
    if (chance(0.15)) el.id = "i" + Math.floor(r() * 3);
    if (chance(0.75)) {
      let first = chance(0.65) ? pick(SHARED) : "u" + uniq++;
      if (chance(0.1)) first = pick(MODS) + " " + first;
      const parts: ClsPart[] = [first];
      if (chance(0.25)) parts.push(" " + pick(MODS));
      if (chance(0.15) && canSlot()) parts.push({ slot: newSlot("attr", [" is-open", " active"]) });
      el.cls = parts;
    }
    if (chance(KEY_P)) {
      const k = pick(KEYS);
      if (!keyTag[k] || keyTag[k] === tag) {
        keyTag[k] = tag;
        el.key = k;
      }
    }
    if (opts.skip && depth > 0 && chance(0.06)) el.ignore = true;
    if (VOID.has(tag)) return el;
    if (tag === "option") {
      el.kids = [{ t: "text", v: "o" + txt++ }];
      return el;
    }
    if (depth >= 4 || chance(0.25)) {
      if (chance(0.6)) el.kids = [{ t: "text", v: "t" + txt++ }];
    } else {
      el.kids = mkForest(kidCtx(tag), depth + 1);
    }
    return el;
  };

  const mkSlotNode = (ctx: Ctx, depth: number): ANode => {
    if ((ctx === "flow" || ctx === "phrasing") && chance(0.15)) {
      return { t: "slot", id: newSlot("text", pick([["hi"], ["hi", "x y"], [" note "]])) };
    }
    const id = newSlot("el", []);
    const nb = 1 + Math.floor(r() * 3);
    for (let i = 0; i < nb; i++) {
      if (ctx !== "list" && ctx !== "select" && chance(0.08)) slots[id].branches.push([{ t: "text", v: " note " }]);
      else slots[id].branches.push(mkForest(ctx, depth + 1, 1 + Math.floor(r() * 2)));
    }
    return { t: "slot", id };
  };

  const mkForest = (ctx: Ctx, depth: number, nEls?: number): ANode[] => {
    const out: ANode[] = [];
    const n = nEls ?? (depth === 0 ? 2 + Math.floor(r() * 4) : Math.floor(r() * 4));
    const gap = () => {
      const w = wsFor(ctx);
      if (w) out.push({ t: "text", v: w });
      if (chance(0.05)) out.push({ t: "comment", v: "c" });
    };
    gap();
    for (let i = 0; i < n; i++) {
      if (canSlot() && chance(depth === 0 ? 0.35 : 0.2)) {
        out.push(mkSlotNode(ctx, depth));
        gap();
      }
      out.push(mkEl(ctx, depth));
      gap();
    }
    if (canSlot() && chance(0.2)) {
      out.push(mkSlotNode(ctx, depth));
      gap();
    }
    return out;
  };

  let root = mkForest("flow", 0);
  if (slotN === 0) root = [...root, mkSlotNode("flow", 0)];
  const init: Record<string, number> = {};
  for (const id of Object.keys(slots)) init[id] = Math.floor(r() * (slots[id].branches.length + 1)) - 1;
  const c: Case = { root, slots, init, updates: [], focusSelect: opts.skip };
  const vals = { ...init };
  for (let step = 0; step < 8; step++) {
    const vis = Array.from(new Set(visibleSlots(c, vals)));
    if (!vis.length) break;
    const n = Math.min(vis.length, 1 + Math.floor(r() * 3));
    const u: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const id = vis.splice(Math.floor(r() * vis.length), 1)[0];
      const opts2: number[] = [];
      for (let v = -1; v < slots[id].branches.length; v++) if (v !== vals[id]) opts2.push(v);
      if (!opts2.length) continue;
      u[id] = pick(opts2);
      vals[id] = u[id];
    }
    c.updates.push(u);
  }
  return c;
}

// ---------- DOM checks ----------
function shape(n: Node): string {
  return Array.from(n.childNodes)
    .map((c) =>
      c.nodeType === 1 ? `${(c as Element).tagName}(${shape(c)})` :
      c.nodeType === 3 ? ((c as Text).data.length ? "T" : "T0") : "C")
    .join(",");
}
function canon(n: Node): string {
  return Array.from(n.childNodes)
    .map((c) => {
      if (c.nodeType === 3) return JSON.stringify((c as Text).data);
      if (c.nodeType === 8) return `<!--${(c as Comment).data}-->`;
      const e = c as Element;
      const at = Array.from(e.attributes).map((a) => `${a.name}=${a.value}`).sort().join(" ");
      return `<${e.tagName} ${at}>${canon(e)}</>`;
    })
    .join("");
}
const firstCls = (e: Element) => (e.getAttribute("class") || "").trim().split(/\s+/)[0] || "";
const sig = (e: Element) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (firstCls(e) ? "." + firstCls(e) : "");
const keyOf = (e: Element) => e.getAttribute("data-key") || "";
function pathOf(e: Element, root: Element): string {
  const parts: string[] = [];
  for (let p: Element | null = e; p && p !== root; p = p.parentElement) parts.unshift(sig(p) + (keyOf(p) ? `[${keyOf(p)}]` : ""));
  return parts.join(" > ") || "(root)";
}
function keyed(root: Element): Map<string, Element[]> {
  const m = new Map<string, Element[]>();
  root.querySelectorAll("[data-key]").forEach((el) => {
    const k = keyOf(el);
    if (!k) return;
    m.set(k, [...(m.get(k) || []), el]);
  });
  return m;
}
function nearestKeyAnc(el: Element, root: Element): string {
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (keyOf(p)) return keyOf(p);
  return "";
}
function uniqueKids(p: Element): Map<string, Element> {
  const m = new Map<string, Element | null>();
  for (const c of Array.from(p.children)) {
    if (keyOf(c)) continue;
    const s = sig(c);
    m.set(s, m.has(s) ? null : c);
  }
  const out = new Map<string, Element>();
  m.forEach((v, k) => v && out.set(k, v));
  return out;
}
function stabSnap(root: Element) {
  const m = new Map<Element, Map<string, Element>>();
  m.set(root, uniqueKids(root));
  root.querySelectorAll("*").forEach((e) => m.set(e, uniqueKids(e)));
  return m;
}
function stabViolations(root: Element, snap: Map<Element, Map<string, Element>>): string[] {
  const out: string[] = [];
  snap.forEach((before, p) => {
    if (p !== root && !root.contains(p)) return;
    const after = uniqueKids(p);
    before.forEach((oldEl, s) => {
      const ne = after.get(s);
      if (ne) cov.stabChecks++;
      if (ne && ne !== oldEl) out.push(pathOf(p, root) + " >> " + s);
    });
  });
  return out;
}
/** The paths of elements main kept: the same node before and after. */
function stabKept(root: Element, snap: Map<Element, Map<string, Element>>): Set<string> {
  const out = new Set<string>();
  snap.forEach((before, p) => {
    if (p !== root && !root.contains(p)) return;
    const after = uniqueKids(p);
    before.forEach((oldEl, s) => {
      if (after.get(s) === oldEl) out.add(pathOf(p, root) + " >> " + s);
    });
  });
  return out;
}
const cov = { identChecks: 0, keyedMoves: 0, stabChecks: 0 };
function identViolations(root: Element, before: Map<string, Element[]>, anc: Map<string, string>, where?: Map<string, string>): string[] {
  const after = keyed(root);
  const out: string[] = [];
  before.forEach((els, k) => {
    const a = after.get(k);
    if (els.length !== 1 || !a || a.length !== 1) return;
    if (nearestKeyAnc(a[0], root) !== anc.get(k)) return;
    if (where) {
      cov.identChecks++;
      if (where.get(k) !== placeOf(a[0], root)) cov.keyedMoves++;
    }
    if (a[0] !== els[0]) out.push(k);
  });
  return out;
}
/** Where a keyed element sits: its parent's path and its previous element sibling. */
function placeOf(e: Element, root: Element): string {
  const prev = e.previousElementSibling;
  return pathOf(e.parentElement!, root) + "|" + (prev ? sig(prev) + keyOf(prev) : "^");
}

// ---------- runner ----------
interface Failure { cls: string; step: number; detail: string }

let wid = 0;
function mkWrapper(): HTMLElement {
  const w = document.createElement("div");
  w.setAttribute("data-lvt-id", "audit-" + wid++);
  document.body.appendChild(w);
  return w;
}
function apply(client: LiveTemplateClient, w: HTMLElement, tree: any, off: boolean, focus: boolean): string | null {
  (globalThis as any).__alignOff = off;
  try {
    if (focus) (w.querySelector("select") as HTMLSelectElement | null)?.focus();
    client.updateDOM(w, tree);
    return null;
  } catch (e: any) {
    return String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
  } finally {
    (globalThis as any).__alignOff = false;
  }
}

function runCase(c: Case, stopAt?: string): Failure[] {
  const fails: Failure[] = [];
  const A = mkWrapper(), B = mkWrapper();
  const ca = new LiveTemplateClient(), cb = new LiveTemplateClient();
  const skip = !!c.focusSelect;
  try {
    const vals = { ...c.init };
    let full = toTree(c.root, c, vals);
    const ea = apply(ca, A, full, false, false);
    const eb = apply(cb, B, full, true, false);
    if (ea) return [{ cls: "inv2-throw" + (eb ? ":pre-existing" : ":regression"), step: -1, detail: ea }];
    for (let step = 0; step < c.updates.length; step++) {
      Object.assign(vals, c.updates[step]);
      const next = toTree(c.root, c, vals);
      const upd = diff(full, next) ?? {};
      if (JSON.stringify(merge(full, upd)) !== JSON.stringify(next)) throw new Error("harness merge mismatch");
      full = next;
      const kA = keyed(A), kB = keyed(B);
      const ancA = new Map<string, string>(), ancB = new Map<string, string>();
      const whereA = new Map<string, string>();
      kA.forEach((els, k) => {
        ancA.set(k, nearestKeyAnc(els[0], A));
        whereA.set(k, placeOf(els[0], A));
      });
      kB.forEach((els, k) => ancB.set(k, nearestKeyAnc(els[0], B)));
      const sA = stabSnap(A), sB = stabSnap(B);
      const htmlBefore = A.innerHTML;
      const htmlBeforeB = B.innerHTML;

      // In skip mode, whether each side's focused select survived its update.
      const selA = A.querySelector("select"), selB = B.querySelector("select");
      const errA = apply(ca, A, upd, false, skip);
      const focusA = !!selA && A.contains(selA) && document.activeElement === selA;
      const errB = apply(cb, B, upd, true, skip);
      const focusB = !!selB && B.contains(selB) && document.activeElement === selB;
      const ref = mkWrapper();
      apply(new LiveTemplateClient(), ref, full, true, false);
      const dupRe = /data-key="([^"]+)"[\s\S]*data-key="\1"/;
      const dup = dupRe.test(htmlBefore) || dupRe.test(ref.innerHTML);
      const push = (cls: string, detail: string) => {
        const [base, origin] = cls.split(":");
        fails.push({ cls: `${base}${dup ? "+dupkey" : ""}:${origin}`, step, detail });
      };
      if (errA) {
        fails.push({ cls: "inv2-throw" + (errB ? ":pre-existing" : ":regression"), step, detail: errA });
        break;
      }
      const target = skip ? B : ref;
      const label = skip ? "skip-divergence" : "inv1";
      let stop = false;
      if (A.innerHTML !== target.innerHTML) {
        const pre = !skip && B.innerHTML !== target.innerHTML;
        const attrOnly = canon(A) === canon(target);
        // In skip mode, alignment may match the fresh render where main doesn't,
        // or keep the focused select (which the client then leaves as it is)
        // where main rebuilt it and lost the focus: both are improvements.
        const better = skip && !attrOnly && canon(A) === canon(ref);
        const focusKept = skip && focusA && !focusB;
        push(`${label}${attrOnly ? "-attr-order" : ""}${better ? "-pairing-matches-fresh" : ""}${focusKept ? "-focus-kept" : ""}${pre ? ":pre-existing" : ":regression"}`,
          `before=${JSON.stringify(htmlBefore)}\nactual=${JSON.stringify(A.innerHTML)}\nexpect=${JSON.stringify(target.innerHTML)}`);
        stop = !attrOnly;
      } else if (shape(A) !== shape(target)) {
        const pre = !skip && shape(B) !== shape(target);
        push(`${skip ? "skip-shape" : "shape"}${pre ? ":pre-existing" : ":regression"}`,
          `actual=${shape(A)}\nexpect=${shape(target)}`);
        stop = true;
      }
      const iv = identViolations(A, kA, ancA, whereA);
      if (iv.length) {
        const ivB = new Set(identViolations(B, kB, ancB));
        for (const k of iv) push("inv3-identity" + (ivB.has(k) ? ":pre-existing" : ":regression"), `key=${k}`);
      }
      // With a repeated key alignment stays out entirely, so from the same page
      // the result must be exactly main's. (From pages that already differ, by
      // an earlier improvement, morphdom's duplicate-key handling can differ on
      // its own. Paths are ambiguous with duplicates, so stability isn't checked.)
      if (dup) {
        if (htmlBefore === htmlBeforeB && A.innerHTML !== B.innerHTML) push("dupkey-differs-from-main:regression", `actual=${JSON.stringify(A.innerHTML)}\nmain=${JSON.stringify(B.innerHTML)}`);
        ref.remove();
        if (stop) break;
        continue;
      }
      const sv = stabViolations(A, sA);
      if (sv.length) {
        // A regression only where main kept that element. Where main rebuilt
        // it, or its parent, alignment is no worse.
        const keptB = stabKept(B, sB);
        for (const p of sv) push("inv4-stability" + (keptB.has(p) ? ":regression" : ":pre-existing"), p);
      }
      ref.remove();
      if (stopAt && fails.some((f) => f.cls === stopAt)) break;
      if (stop) break;
    }
  } finally {
    A.remove();
    B.remove();
  }
  return fails;
}

// ---------- shrinker ----------
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
function forests(c: Case): ANode[][] {
  const out: ANode[][] = [c.root];
  for (const id of Object.keys(c.slots)) for (const b of c.slots[id].branches) if (typeof b !== "string") out.push(b);
  const all: ANode[][] = [];
  const walk = (f: ANode[]) => {
    all.push(f);
    for (const n of f) if (n.t === "el") walk(n.kids);
  };
  out.forEach(walk);
  return all;
}
function* candidates(c: Case): Generator<Case> {
  for (let i = c.updates.length - 1; i >= 0; i--) {
    const d = clone(c);
    d.updates.splice(i, 1);
    yield d;
  }
  for (let i = 0; i < c.updates.length; i++) {
    const ks = Object.keys(c.updates[i]);
    if (ks.length > 1) for (const k of ks) {
      const d = clone(c);
      delete d.updates[i][k];
      yield d;
    }
  }
  for (const id of Object.keys(c.slots)) {
    if (c.init[id] >= 0) {
      const d = clone(c);
      d.init[id] = -1;
      yield d;
    }
    for (let b = 0; b < c.slots[id].branches.length; b++) {
      if (c.slots[id].branches.length < 2) break;
      const d = clone(c);
      d.slots[id].branches.splice(b, 1);
      const fix = (v: number) => (v === b ? -1 : v > b ? v - 1 : v);
      d.init[id] = fix(d.init[id]);
      d.updates.forEach((u) => {
        if (id in u) u[id] = fix(u[id]);
      });
      yield d;
    }
  }
  const fs = forests(c);
  for (let fi = 0; fi < fs.length; fi++) {
    for (let ni = 0; ni < fs[fi].length; ni++) {
      const n = fs[fi][ni];
      { const d = clone(c); forests(d)[fi].splice(ni, 1); yield d; }
      if (n.t === "el") {
        { const d = clone(c); const f = forests(d)[fi]; f.splice(ni, 1, ...(f[ni] as any).kids); yield d; }
        for (const a of ["id", "key", "ignore", "cls"] as const) {
          if ((n as any)[a] !== undefined) { const d = clone(c); delete (forests(d)[fi][ni] as any)[a]; yield d; }
        }
        if (n.cls && n.cls.length > 1) for (let p = 0; p < n.cls.length; p++) {
          const d = clone(c); (forests(d)[fi][ni] as any).cls.splice(p, 1); yield d;
        }
      }
      if (n.t === "text" && n.v.length > 1) {
        { const d = clone(c); (forests(d)[fi][ni] as any).v = n.v.trim() ? "x" : " "; yield d; }
      }
    }
  }
}
function shrink(c: Case, cls: string, budget = 2500): Case {
  let cur = c, runs = 0, improved = true;
  while (improved && runs < budget) {
    improved = false;
    for (const d of candidates(cur)) {
      if (++runs > budget) break;
      if (runCase(d, cls).some((f) => f.cls === cls)) {
        cur = d;
        improved = true;
        break;
      }
    }
  }
  return cur;
}
function repro(c: Case, cls: string): string {
  const vals = { ...c.init };
  let full = toTree(c.root, c, vals);
  const lines = [`const init = ${JSON.stringify(full)};`, `const updates: any[] = [`];
  for (const u of c.updates) {
    Object.assign(vals, u);
    const next = toTree(c.root, c, vals);
    lines.push(`  ${JSON.stringify(diff(full, next) ?? {})},`);
    full = next;
  }
  lines.push(`];`, `const finalState = ${JSON.stringify(full)};`);
  const f = runCase(c, cls).find((x) => x.cls === cls)!;
  return `// ${cls} at update #${f.step}${c.focusSelect ? " (focus <select> before each update)" : ""}\n// ${f.detail.replace(/\n/g, "\n// ")}\n` + lines.join("\n");
}

// ---------- the run ----------
describe("sibling alignment: property test against main", () => {
  const silence: jest.SpyInstance[] = [];
  beforeAll(() => {
    for (const m of ["log", "warn", "error", "debug", "info"] as const) silence.push(jest.spyOn(console, m).mockImplementation(() => {}));
  });
  afterAll(() => silence.forEach((s) => s.mockRestore()));

  it("holds invariants over random trees and update sequences", () => {
    const SEEDS = Number(process.env.FUZZ_SEEDS || 150);
    const SKIP_SEEDS = Number(process.env.FUZZ_SKIP_SEEDS || 60);
    const byCls = new Map<string, { count: number; seeds: number[]; exs: Case[] }>();
    let updates = 0, cases = 0;
    const t0 = Date.now();
    const runMode = (n: number, skip: boolean, base: number) => {
      for (let i = 0; i < n; i++) {
        const seed = base + i;
        const c = gen(seed, { skip });
        cases++;
        updates += c.updates.length;
        const fs = runCase(c);
        for (const f of fs) {
          const e = byCls.get(f.cls) || { count: 0, seeds: [], exs: [] };
          e.count++;
          if (!e.seeds.includes(seed)) {
            e.seeds.push(seed);
            e.exs.push(c);
          }
          byCls.set(f.cls, e);
        }
      }
    };
    runMode(SEEDS, false, 1);
    runMode(SKIP_SEEDS, true, 100001);
    let report = `cases=${cases} updates=${updates} genTime=${Date.now() - t0}ms\n` +
      `coverage: ${JSON.stringify(cov)}\n`;
    for (const [cls, e] of Array.from(byCls.entries()).sort()) {
      report += `\n=== ${cls}: ${e.count} violations in ${e.seeds.length} seeds; first seeds ${e.seeds.slice(0, 8).join(",")}\n`;
      const nEx = 1;
      for (let x = 0; x < Math.min(nEx, e.exs.length); x++) {
        const small = shrink(e.exs[x], cls);
        report += `--- example seed ${e.seeds[x]}\n` + repro(small, cls) + "\n";
      }
    }
    report += `\ntotal ${Date.now() - t0}ms\n`;
    if (process.env.FUZZ_VERBOSE) process.stdout.write(report);
    // Any invariant broken with alignment on but kept without it is a
    // regression. Attribute order alone is not (morphdom keeps the live order).
    const hard = Array.from(byCls.keys()).filter(
      (k) => !/attr-order|pairing-matches-fresh|focus-kept/.test(k) && k.endsWith(":regression")
    );
    if (hard.length) process.stdout.write(report);
    expect(hard).toEqual([]);
  }, 1_800_000);
});

