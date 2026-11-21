import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { app, findTerm, status, openGroup, activate } from "./store.svelte";
import { detectAgent, resumeFor, isMac } from "./util";

type Live = {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  run: string | null; // id of the current PTY process; changes on every restart
  gl?: WebglAddon;
  busySince: number;
  hooked?: boolean; // Claude Code reports its own state for this run: trust it, skip the timing guess
  quiet?: ReturnType<typeof setTimeout>;
};

const live = new Map<string, Live>();
let park: HTMLElement | null = null; // hidden holder for terminals not in a pane; set by show()
const runs = new Map<string, string>(); // pty run id -> terminal id

export const defaultTheme = {
  background: "#1e1f22",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  selectionBackground: "#3a4a6b",
};

const termOptions = (): ITerminalOptions => ({
  fontFamily: app.settings.fontFamily,
  fontSize: app.settings.fontSize || 13, // number input can be empty while typing
  lineHeight: app.settings.lineHeight || 1,
  macOptionIsMeta: app.settings.optionIsMeta,
  theme: app.settings.theme ?? defaultTheme,
});

/** Push current settings into every live terminal. */
export function applySettings() {
  const opts = termOptions();
  for (const l of live.values()) Object.assign(l.term.options, opts);
  fitVisible();
}

// ---- status ----
// Agents (Claude Code, Codex) redraw constantly while working and go silent when they need you.
// So: output => busy; a long busy stretch that goes quiet while you're not looking => attention.
// Bell / OSC 9 / OSC 777 notifications => attention right away.
// ponytail: timing heuristic, swap for Claude Code hooks if it misfires.
const QUIET_MS = 1500;
const MIN_BUSY_MS = 3000;

const watching = (id: string) => app.active === id && document.hasFocus();

const notifyAllowed = isPermissionGranted().then((ok) => ok || requestPermission().then((p) => p === "granted"));

function flagAttention(id: string) {
  if (watching(id) || status[id] === "attention") return;
  status[id] = "attention";
  if (!isMac && !document.hasFocus()) getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {}); // flash the taskbar button
  if (!app.settings.notify || document.hasFocus()) return;
  const f = findTerm(id);
  notifyAllowed.then((ok) => ok && f && sendNotification({ title: f.t.name, body: `${f.g.name} — waiting for you` }));
}

function onOutput(id: string, l: Live) {
  if (l.hooked) return; // the agent's own events drive the dot
  if (status[id] !== "busy") {
    l.busySince = Date.now();
    if (status[id] !== "attention") status[id] = "busy";
  }
  clearTimeout(l.quiet);
  l.quiet = setTimeout(() => {
    if (status[id] !== "busy") return;
    status[id] = "idle";
    if (!l.hooked && Date.now() - l.busySince - QUIET_MS >= MIN_BUSY_MS) flagAttention(id);
  }, QUIET_MS);
}

listen<{ id: string; code: number | null }>("pty-exit", ({ payload }) => {
  const id = runs.get(payload.id);
  runs.delete(payload.id);
  const l = id && live.get(id);
  if (!id || !l || l.run !== payload.id) return; // stale run (already restarted / disposed)
  l.run = null;
  clearTimeout(l.quiet);
  status[id] = "exited";
  const t = findTerm(id)?.t;
  if (t) t.agent = undefined;
  l.term.write(`\r\n\x1b[2m[process exited${payload.code ? ` with code ${payload.code}` : ""} — press Enter to restart]\x1b[0m\r\n`);
});

// Exact events from agent hooks (see src-tauri/src/hooks.rs). Claude: prompt / stop / notify
// (permission or input needed). Codex: done (turn finished; its approvals still use the guess).
listen<{ id: string; event: string }>("agent-event", ({ payload }) => {
  const id = runs.get(payload.id);
  const l = id && live.get(id);
  if (!id || !l || l.run !== payload.id) return;
  if (payload.event !== "done") l.hooked = true;
  if (payload.event === "prompt") {
    status[id] = "busy";
    l.busySince = Date.now();
  } else if (payload.event === "stop" || payload.event === "notify" || payload.event === "done") {
    clearTimeout(l.quiet);
    if (watching(id)) status[id] = "idle";
    else flagAttention(id);
  }
});

window.addEventListener("focus", () => {
  if (app.active && status[app.active] === "attention") status[app.active] = "idle";
});

// ---- keys ----
// Line-editing keys: in the normal screen (shell prompt, Claude Code, Codex input) send readline
// controls, which zsh/bash/Ink all understand. In the alternate screen (vim, less, htop) let xterm
// send the real key so full-screen apps behave normally.
function keyAction(e: KeyboardEvent, term: Terminal): string | (() => void) | null {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const normalScreen = term.buffer.active.type === "normal";
  const cmdOnly = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const altOnly = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;

  if (e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) return "\x1b\r"; // newline in agents
  if (e.key === "Insert" && e.shiftKey) return () => readText().then((t) => t && term.paste(t)).catch(() => {});
  if (e.key === "Insert" && e.ctrlKey) return () => term.hasSelection() && writeText(term.getSelection());
  if (normalScreen && ((plain && e.key === "Home") || (cmdOnly && e.key === "ArrowLeft"))) return "\x01";
  if (normalScreen && ((plain && e.key === "End") || (cmdOnly && e.key === "ArrowRight"))) return "\x05";
  if (normalScreen && altOnly && e.key === "ArrowLeft") return "\x1bb";
  if (normalScreen && altOnly && e.key === "ArrowRight") return "\x1bf";
  if (cmdOnly && e.key === "Backspace") return "\x15";
  if (!isMac) {
    // Windows/Linux copy & paste, as in Windows Terminal: Ctrl+Shift+C/V always; Ctrl+C copies only
    // when text is selected (otherwise it's the usual interrupt); Ctrl+V pastes.
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const copy = () => {
      writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
    };
    const paste = () => readText().then((t) => t && term.paste(t)).catch(() => {});
    if (ctrl && e.code === "KeyC" && (e.shiftKey || term.hasSelection())) return term.hasSelection() ? copy : () => {};
    if (ctrl && e.code === "KeyV") return paste;
  }
  return null;
}

// ---- lifecycle ----
function create(id: string, host: HTMLElement): Live {
  const el = document.createElement("div");
  el.className = "term";
  host.appendChild(el);

  const term = new Terminal({ allowProposedApi: true, cursorBlink: true, scrollback: 10000, ...termOptions() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (app.active === id) Object.assign(found, { index: resultIndex, count: resultCount });
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri)));
  term.open(el);
  // clicking into a split pane focuses it
  term.textarea?.addEventListener("focus", () => app.active !== id && app.panes.includes(id) && activate(id));

  const l: Live = { term, fit, search, el, run: null, busySince: 0 };

  term.onBell(() => flagAttention(id));
  term.parser.registerOscHandler(9, (data) => {
    const sub = /^(\d+);(.*)$/s.exec(data);
    if (!sub) flagAttention(id); // iTerm2-style notification: OSC 9 ; message
    else if (sub[1] === "9") reportedCwd(id, sub[2]); // ConEmu/Windows Terminal: current folder
    return true; // other ConEmu subcommands (9;4 progress bars…) are ignored, not "attention"
  });
  term.parser.registerOscHandler(777, () => (flagAttention(id), true)); // notify;title;body

  term.attachCustomKeyEventHandler((e) => {
    const action = keyAction(e, term);
    if (action) {
      if (e.type === "keydown") {
        e.preventDefault();
        typeof action === "string" ? write(id, action) : action();
      }
      return false;
    }
    return !e.metaKey; // other ⌘-shortcuts belong to the app/menu (⌘C/⌘V go through the Edit menu)
  });

  let copyTimer: ReturnType<typeof setTimeout>;
  term.onSelectionChange(() => {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      if (app.settings.copyOnSelect && term.hasSelection()) writeText(term.getSelection()).catch(() => {});
    }, 150);
  });

  term.onData((data) => {
    if (!l.run) {
      if (data === "\r") start(id);
      return;
    }
    write(id, data);
  });
  term.onResize(({ cols, rows }) => l.run && invoke("pty_resize", { id: l.run, cols, rows }));

  live.set(id, l);
  return l;
}

function write(id: string, data: string) {
  const run = live.get(id)?.run;
  if (run) invoke("pty_write", { id: run, data }).catch(console.error);
}

export const termForRun = (run: string) => runs.get(run);

// ---- remember folder + agent per terminal ----
/** Folder reported by the shell's prompt (Windows: PowerShell/cmd, set up in pty_spawn). Only local
 *  Windows paths count, so a remote shell over ssh can't overwrite it. On macOS/Linux the OS is asked. */
function reportedCwd(id: string, raw: string) {
  const path = raw.trim().replace(/^"(.*)"$/, "$1");
  const t = findTerm(id)?.t;
  if (!isMac && t && /^([A-Za-z]:\\|\\\\)/.test(path) && path !== t.lastCwd) t.lastCwd = path;
}

// Polled (not just on quit) so a crash or force-quit still has a recent snapshot.
type Snapshot = { id: string; cwd: string | null; program: string[] | null }; // program = argv

export async function snapshot() {
  const snaps = await invoke<Snapshot[]>("pty_snapshot").catch(() => [] as Snapshot[]);
  for (const s of snaps) {
    const t = findTerm(termForRun(s.id) ?? null)?.t;
    if (!t) continue;
    if (s.cwd && s.cwd !== t.lastCwd) t.lastCwd = s.cwd;
    const agent = s.program ? detectAgent(s.program, app.settings.agents) : null;
    const resume = (s.program && resumeFor(s.program, app.settings.agents, app.settings.resumeFlags)) || undefined;
    if (resume !== t.resume) t.resume = resume;
    if (agent?.programs[0] !== t.agent) t.agent = agent?.programs[0];
    const l = live.get(t.id);
    if (l && !agent) l.hooked = false; // agent quit: plain shell again, back to the timing guess
  }
}
setInterval(snapshot, 5000);

// ---- ⌘F search in the active terminal ----
export const found = $state({ index: -1, count: 0 });
const searchOpts = (incremental: boolean): ISearchOptions => ({
  incremental,
  decorations: {
    matchBackground: "#5c4a1a",
    activeMatchBackground: "#b8862b",
    matchOverviewRuler: "#f2c55c",
    activeMatchColorOverviewRuler: "#ffffff",
  },
});
/** dir 0 = as-you-type (stays on the current match), 1 = next, -1 = previous */
export function find(query: string, dir: 0 | 1 | -1) {
  const l = app.active ? live.get(app.active) : undefined;
  if (!l) return;
  if (!query) return endFind(false);
  if (dir < 0) l.search.findPrevious(query, searchOpts(false));
  else l.search.findNext(query, searchOpts(dir === 0));
}
export function endFind(refocus = true) {
  for (const l of live.values()) l.search.clearDecorations();
  Object.assign(found, { index: -1, count: 0 });
  if (refocus) focusActive();
}

/** Paste text into a terminal (uses bracketed paste when the app asked for it). */
export function paste(id: string, text: string) {
  const l = live.get(id);
  if (!l) return;
  l.term.paste(text);
  l.term.focus();
}

function start(id: string) {
  const l = live.get(id);
  const t = findTerm(id)?.t;
  if (!l || !t) return;
  const run = crypto.randomUUID();
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (buf) => {
    if (l.run !== run) return;
    l.term.write(new Uint8Array(buf));
    onOutput(id, l);
  };
  l.run = run;
  runs.set(run, id);
  status[id] = "idle";
  // Pick up where it was: last folder, and the agent session if one was running.
  const cwd = (app.settings.restoreFolders && t.lastCwd) || t.cwd;
  const command = (app.settings.resumeAgents && t.resume) || t.command;
  invoke("pty_spawn", { id: run, cwd, command, shell: app.settings.shell, cols: l.term.cols, rows: l.term.rows, onData }).catch((e) => {
    l.run = null;
    status[id] = "exited";
    l.term.write(`\r\n\x1b[31mFailed to start: ${e}\x1b[0m\r\n`);
  });
}

/** Start terminals in the background (hidden), sized like a visible one. */
export function startAll(ids: string[]) {
  if (!park) return;
  const visible = [...live.values()].find((l) => l.el.parentElement !== park)?.term;
  for (const id of ids) {
    if (live.has(id) || status[id] === "exited") continue;
    const l = create(id, park);
    if (visible) l.term.resize(visible.cols, visible.rows);
    start(id);
  }
}

/** Tabs = this group's terminals, all of them running. */
export function showGroup(groupId: string) {
  const g = app.groups.find((x) => x.id === groupId);
  if (!g) return;
  startAll(g.terms.map((t) => t.id)); // before openGroup, while the old terminal is still visible to size from
  openGroup(groupId);
}

/** Put each pane's terminal into its box (creating and starting it on first use); park the rest. */
export function show(panes: [string, HTMLElement][], focused: string | null, parkEl: HTMLElement) {
  park = parkEl;
  const shown = new Map(panes);
  for (const [k, l] of live) {
    if (shown.has(k)) continue;
    if (l.el.parentElement !== park) park.appendChild(l.el);
    // WebGL contexts are capped (~16 per page), so only visible terminals get one.
    l.gl?.dispose();
    l.gl = undefined;
  }
  for (const [id, box] of panes) {
    const l = live.get(id) ?? create(id, box);
    if (l.el.parentElement !== box) box.appendChild(l.el);
    if (!l.gl) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => {
          gl.dispose();
          l.gl = undefined;
        });
        l.term.loadAddon(gl);
        l.gl = gl;
      } catch {
        /* falls back to the DOM renderer */
      }
    }
  }
  fitVisible();
  for (const [id] of panes) if (!live.get(id)!.run && status[id] !== "exited") start(id);
  if (focused) live.get(focused)?.term.focus();
}

export function fitVisible() {
  for (const l of live.values()) if (l.el.parentElement && l.el.parentElement !== park) l.fit.fit();
}

export function focusActive() {
  if (app.active) live.get(app.active)?.term.focus();
}

export function restart(id: string) {
  const l = live.get(id);
  if (!l) return;
  if (l.run) invoke("pty_kill", { id: l.run });
  l.run = null;
  l.term.reset();
  start(id);
}

/** Kill the process and drop the xterm instance. */
export function dispose(id: string) {
  const l = live.get(id);
  if (!l) return;
  if (l.run) invoke("pty_kill", { id: l.run });
  clearTimeout(l.quiet);
  l.term.dispose();
  l.el.remove();
  live.delete(id);
}
