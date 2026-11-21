import { invoke } from "@tauri-apps/api/core";
import type { Agent } from "./util";

export type Term = {
  id: string;
  name: string;
  cwd: string; // starting folder you chose
  command: string; // startup command you chose
  lastCwd?: string; // where the shell actually was last time (tracked automatically)
  resume?: string; // agent was running last time: command that continues its session
  agent?: string; // short name of the agent running right now (e.g. "claude"), for the sidebar
};
export type Group = { id: string; name: string; collapsed: boolean; terms: Term[] };
export type Status = "off" | "busy" | "idle" | "attention" | "exited";

export type Theme = Record<string, string>; // xterm ITheme keys -> css colors
export type Settings = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  optionIsMeta: boolean;
  copyOnSelect: boolean;
  notify: boolean;
  theme: Theme | null; // null = built-in
  restoreFolders: boolean;
  resumeAgents: boolean;
  resumeFlags: boolean; // keep on/off flags like --dangerously-skip-permissions when resuming
  shell: string; // program to run in new terminals; "" = login shell ($SHELL) / PowerShell on Windows
  agents: Agent[];
};
export const defaultSettings: Settings = {
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, "Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1,
  optionIsMeta: true,
  copyOnSelect: true,
  notify: true,
  theme: null,
  restoreFolders: true,
  resumeAgents: true,
  resumeFlags: true,
  shell: "",
  agents: [
    { name: "Claude Code", programs: ["claude", "claude-code"], resume: "claude --continue" },
    { name: "Codex", programs: ["codex"], resume: "codex resume --last" },
    { name: "Gemini CLI", programs: ["gemini", "gemini-cli"], resume: "gemini --resume latest" },
    { name: "OpenCode", programs: ["opencode", "opencode-ai"], resume: "opencode --continue" },
    { name: "Pi", programs: ["pi", "pi-coding-agent"], resume: "pi --continue" },
    { name: "Kimi Code", programs: ["kimi", "kimi-cli", "kimi-code"], resume: "kimi --continue" },
  ],
};

type Saved = { groups: Group[]; open: string[]; panes: string[]; active: string | null; sidebarWidth: number; settings: Settings };

export const SIDEBAR_WIDTH = 260;
export const app = $state<Saved>({ groups: [], open: [], panes: [], active: null, sidebarWidth: SIDEBAR_WIDTH, settings: { ...defaultSettings } });
export const status = $state<Record<string, Status>>({});
let mru: string[] = []; // most-recent-first, for ⌃Tab

const uid = () => crypto.randomUUID().slice(0, 8);

export const findTerm = (id: string | null) => {
  for (const g of app.groups) for (const t of g.terms) if (t.id === id) return { g, t };
  return null;
};
export const allTerms = () => app.groups.flatMap((g) => g.terms.map((t) => ({ g, t })));

// ---- persistence ----
async function read(kind: "settings" | "layout") {
  try {
    return JSON.parse((await invoke<string>("load_json", { kind })) || "null");
  } catch (e) {
    console.error(`${kind}.json unreadable, using defaults`, e);
    return null;
  }
}

const snapshots = {
  settings: () => app.settings,
  layout: () => ({ groups: app.groups, open: app.open, panes: app.panes, active: app.active, sidebarWidth: app.sidebarWidth }),
};
const save = (kind: keyof typeof snapshots) => invoke("save_json", { kind, json: JSON.stringify(snapshots[kind](), null, 2) });

/** Write both files right now (autosave waits 300ms; quitting can't). */
export const saveNow = () => Promise.all([save("settings"), save("layout")]);

function autosave(kind: keyof typeof snapshots) {
  $effect.root(() => {
    let timer: ReturnType<typeof setTimeout>;
    $effect(() => {
      JSON.stringify(snapshots[kind]()); // tracks every field it touches
      clearTimeout(timer);
      timer = setTimeout(() => save(kind).catch(console.error), 300);
    });
  });
}

export async function load() {
  await invoke("pty_kill_all").catch(() => {}); // orphans from a previous page load
  const [layout, settingsRaw] = await Promise.all([read("layout"), read("settings")]);
  // before the split, settings lived inside the layout file (state.json) under `.settings`
  const settings = settingsRaw?.groups ? settingsRaw.settings : settingsRaw;
  app.settings = { ...defaultSettings, ...settings };

  app.sidebarWidth = layout?.sidebarWidth ?? SIDEBAR_WIDTH;
  if (layout?.groups?.length) {
    app.groups = layout.groups;
    app.open = (layout.open ?? []).filter((id: string) => findTerm(id));
    app.active = findTerm(layout.active) ? layout.active : (app.open[0] ?? null);
    app.panes = (layout.panes ?? []).filter((id: string) => app.open.includes(id));
    if (app.active && !app.panes.includes(app.active)) app.panes = [app.active];
  } else {
    const t: Term = { id: uid(), name: "Terminal 1", cwd: "~", command: "" };
    app.groups = [{ id: uid(), name: "Default", collapsed: false, terms: [t] }];
    app.open = [t.id];
    app.active = t.id;
    app.panes = [t.id];
  }
  if (app.active) mru = [app.active];

  autosave("settings");
  autosave("layout");
}

// ---- tabs & split panes ----
// `panes` = terminals shown side by side (usually one); `active` is the focused one and always among them.
export const MAX_PANES = 4;

export function activate(id: string) {
  if (!findTerm(id)) return;
  if (!app.open.includes(id)) app.open.push(id);
  if (!app.panes.includes(id)) {
    const i = app.panes.indexOf(app.active ?? "");
    if (i < 0) app.panes = [id];
    else app.panes[i] = id; // show it in the focused pane
  }
  app.active = id;
  mru = [id, ...mru.filter((x) => x !== id)];
  if (status[id] === "attention") status[id] = "idle";
}

/** Show `id` in a new pane right of the focused one. */
export function splitWith(id: string) {
  if (app.panes.includes(id) || !app.active || app.panes.length >= MAX_PANES) return activate(id);
  if (!app.open.includes(id)) app.open.push(id);
  app.panes.splice(app.panes.indexOf(app.active) + 1, 0, id);
  activate(id);
}

/** Stop showing `id` side by side (its tab and process stay). */
export function closePane(id: string) {
  const p = app.panes.indexOf(id);
  if (p < 0 || app.panes.length < 2) return;
  app.panes.splice(p, 1);
  if (app.active === id) activate(app.panes[Math.max(0, p - 1)]);
}

export function focusPane(dir: 1 | -1) {
  const n = app.panes.length;
  const i = app.panes.indexOf(app.active ?? "");
  if (n > 1 && i >= 0) activate(app.panes[(i + dir + n) % n]);
}

export function closeTab(id: string) {
  const i = app.open.indexOf(id);
  if (i < 0) return;
  app.open.splice(i, 1);
  mru = mru.filter((x) => x !== id);
  if (app.panes.length > 1 && app.panes.includes(id)) return closePane(id);
  if (app.active !== id) return;
  app.panes = [];
  app.active = null;
  const next = mru.find((x) => app.open.includes(x)) ?? app.open[Math.min(i, app.open.length - 1)];
  if (next) activate(next);
}

export const FONT_MIN = 8;
export const FONT_MAX = 36;
export function zoom(delta: number | "reset") {
  const s = app.settings;
  s.fontSize = delta === "reset" ? defaultSettings.fontSize : Math.min(FONT_MAX, Math.max(FONT_MIN, (s.fontSize || 13) + delta));
}

export function moveTab(id: string, beforeId: string | null) {
  const from = app.open.indexOf(id);
  if (from < 0 || id === beforeId) return;
  app.open.splice(from, 1);
  const to = beforeId ? app.open.indexOf(beforeId) : -1;
  app.open.splice(to < 0 ? app.open.length : to, 0, id);
}

/** Replace the tab bar with all of group's terminals; reactivate the one used most recently. */
export function openGroup(groupId: string) {
  const g = app.groups.find((x) => x.id === groupId);
  if (!g?.terms.length) return;
  app.open = g.terms.map((t) => t.id);
  app.panes = app.panes.filter((id) => app.open.includes(id));
  if (!app.panes.includes(app.active ?? "")) app.active = app.panes[0] ?? null;
  activate(mru.find((id) => app.open.includes(id)) ?? app.open[0]);
}

export const isGroupOpen = (g: Group) => g.terms.length > 0 && app.open.length === g.terms.length && g.terms.every((t) => app.open.includes(t.id));

export function previousTab() {
  const prev = mru.find((x) => x !== app.active && app.open.includes(x));
  if (prev) activate(prev);
}

export function cycleTab(dir: 1 | -1) {
  const n = app.open.length;
  if (!n) return;
  const i = app.open.indexOf(app.active ?? "");
  activate(app.open[(i + dir + n) % n]);
}

export function nextAttention() {
  const ids = allTerms().map((x) => x.t.id);
  const start = ids.indexOf(app.active ?? "");
  for (let k = 1; k <= ids.length; k++) {
    const id = ids[(start + k + ids.length) % ids.length];
    if (status[id] === "attention") return activate(id);
  }
}

// ---- tree edits ----
export function addGroup() {
  const g: Group = { id: uid(), name: `Group ${app.groups.length + 1}`, collapsed: false, terms: [] };
  app.groups.push(g);
  return g;
}

export function addTerm(groupId?: string, split = false) {
  const g = app.groups.find((x) => x.id === groupId) ?? findTerm(app.active)?.g ?? app.groups[0] ?? addGroup();
  const t: Term = { id: uid(), name: `Terminal ${allTerms().length + 1}`, cwd: findTerm(app.active)?.t.cwd ?? "~", command: "" };
  g.terms.push(t);
  g.collapsed = false;
  if (split) splitWith(t.id);
  else activate(t.id);
  return t;
}

/** Caller is responsible for killing the PTY (see terms.ts `dispose`). */
export function removeTerm(id: string) {
  const f = findTerm(id);
  if (!f) return;
  closeTab(id);
  f.g.terms.splice(f.g.terms.indexOf(f.t), 1);
  delete status[id];
}

/** Move terminal `id` into group `groupId`, before terminal `beforeId` (or to the end). */
export function moveTerm(id: string, groupId: string, beforeId?: string) {
  const f = findTerm(id);
  const target = app.groups.find((g) => g.id === groupId);
  if (!f || !target || id === beforeId) return;
  f.g.terms.splice(f.g.terms.indexOf(f.t), 1);
  const i = target.terms.findIndex((t) => t.id === beforeId);
  target.terms.splice(i < 0 ? target.terms.length : i, 0, f.t);
}

export function moveGroup(id: string, beforeId: string) {
  const from = app.groups.findIndex((g) => g.id === id);
  if (from < 0 || id === beforeId) return;
  const [g] = app.groups.splice(from, 1);
  const to = app.groups.findIndex((x) => x.id === beforeId);
  app.groups.splice(to < 0 ? app.groups.length : to, 0, g);
}
