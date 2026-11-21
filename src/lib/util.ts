/** Quote a path for pasting into a POSIX shell. */
export function shellQuote(p: string, windows = !isMac && /^([A-Za-z]:\\|\\\\)/.test(p)) {
  if (windows) {
    if (/^[\w@%+=:,.\\/-]+$/.test(p)) return p;
    // "…" works in PowerShell, cmd and agents; PowerShell would expand $ and ` inside it, so use '…' then
    return /[$`]/.test(p) ? `'${p.replace(/'/g, "''")}'` : `"${p}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const NAMES: Record<string, string> = {
  "Background Color": "background",
  "Foreground Color": "foreground",
  "Cursor Color": "cursor",
  "Cursor Text Color": "cursorAccent",
  "Selection Color": "selectionBackground",
  "Selected Text Color": "selectionForeground",
};

const BRIGHT = ANSI.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`);
const ALL16 = [...ANSI, ...BRIGHT];
ALL16.forEach((n, i) => (NAMES[`Ansi ${i} Color`] = n));
const hex = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");

/** iTerm2 .itermcolors (XML plist). */
function itermColors(xml: string) {
  const theme: Record<string, string> = {};
  // Color entries are <key>Name</key><dict>…</dict> with no nested dicts, so a regex is enough.
  for (const [, key, body] of xml.matchAll(/<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const name = NAMES[key.trim()];
    if (!name) continue;
    const c = (k: string) => hex(parseFloat(body.match(new RegExp(`<key>${k} Component</key>\\s*<real>([^<]+)</real>`))?.[1] ?? "0"));
    theme[name] = `#${c("Red")}${c("Green")}${c("Blue")}`;
  }
  return theme;
}

/** macOS Terminal .terminal profile (Shell → Export Settings…): a plist whose colors are archived NSColor objects. */
function appleTerminalColors(xml: string) {
  const KEYS: Record<string, string> = { BackgroundColor: "background", TextColor: "foreground", CursorColor: "cursor", SelectionColor: "selectionBackground" };
  ALL16.forEach((n) => (KEYS[`ANSI${n[0].toUpperCase()}${n.slice(1)}Color`] = n));
  const theme: Record<string, string> = {};
  for (const [, key, b64] of xml.matchAll(/<key>(\w+)<\/key>\s*<data>([\s\S]*?)<\/data>/g)) {
    if (!KEYS[key]) continue;
    // ponytail: reads the "r g b" (or single gray) text NSColor stores, ignoring its color space, so shades
    // can be a touch off, and skips catalog colors; decode the archive properly if that matters.
    const n = atob(b64.replace(/\s/g, "")).match(/((?:[\d.]+ ?){1,4})\0/)?.[1].split(" ").map(parseFloat);
    if (n) theme[KEYS[key]] = "#" + (n.length < 3 ? [n[0], n[0], n[0]] : n.slice(0, 3)).map(hex).join("");
  }
  return theme;
}

/** Windows Terminal: one color scheme object, or a settings.json (takes the default profile's scheme, else the first). */
function windowsTerminalColors(text: string) {
  const j = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  const scheme = j.background ? j : (j.schemes ?? []).find((x: any) => x.name === j.profiles?.defaults?.colorScheme) ?? j.schemes?.[0] ?? {};
  const RENAME: Record<string, string> = { purple: "magenta", brightPurple: "brightMagenta", cursorColor: "cursor" };
  const theme: Record<string, string> = {};
  for (const [k, v] of Object.entries(scheme)) {
    const name = RENAME[k] ?? k;
    if (typeof v === "string" && /^#[0-9a-f]{6}/i.test(v) && (ALL16.includes(name) || /^(background|foreground|cursor|selectionBackground)$/.test(name)))
      theme[name] = v.slice(0, 7).toLowerCase();
  }
  return theme;
}

const CONF: Record<string, string> = {
  background: "background",
  foreground: "foreground",
  cursor: "cursor", // kitty
  cursor_color: "cursor", // Ghostty
  cursor_text_color: "cursorAccent",
  cursor_text: "cursorAccent",
  selection_background: "selectionBackground",
  selection_foreground: "selectionForeground",
  // Alacritty sections
  "primary.background": "background",
  "primary.foreground": "foreground",
  "cursor.cursor": "cursor",
  "cursor.text": "cursorAccent",
  "selection.background": "selectionBackground",
  "selection.text": "selectionForeground",
};
ALL16.forEach((n, i) => {
  CONF[`color${i}`] = n; // kitty colorN, Ghostty palette = N=…
  CONF[`${i < 8 ? "normal" : "bright"}.${ANSI[i % 8]}`] = n;
});

/** Line-based configs: Ghostty (config or theme file), kitty (.conf), Alacritty (.toml). */
function confColors(text: string) {
  const theme: Record<string, string> = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = line.match(/^\[([\w.]+)\]$/);
    if (sec) {
      section = sec[1].replace(/^colors\.?/, "");
      continue;
    }
    const m = line.match(/^([\w-]+)\s*(?:=|\s)\s*(.+)$/);
    if (!m) continue;
    let key = m[1].replace(/-/g, "_");
    let val = m[2];
    const pal = key === "palette" && val.match(/^(\d+)\s*=\s*(.+)$/);
    if (pal) [key, val] = [`color${pal[1]}`, pal[2]];
    const name = CONF[section ? `${section}.${key}` : key];
    const color = val.match(/^["']?(?:#|0x)?([0-9a-f]{6})\b/i); // Ghostty allows a bare rrggbb
    if (name && color) theme[name] = `#${color[1].toLowerCase()}`;
  }
  return theme;
}

/** Is this #rrggbb closer to white than to black? Decides whether the window around a terminal theme is light or dark. */
export const isLight = (color: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
};

/** Turn another terminal's color file into an xterm.js theme: iTerm2, macOS Terminal, Windows Terminal, Ghostty, kitty, Alacritty. */
export function parseTheme(text: string): Record<string, string> {
  const t = text.trimStart();
  const theme = t.startsWith("{")
    ? windowsTerminalColors(t)
    : /<plist/.test(t)
      ? /<key>(Background|Ansi 0) Color<\/key>/.test(t)
        ? itermColors(t)
        : appleTerminalColors(t)
      : confColors(t);
  if (!theme.background || !theme.foreground) throw new Error("No colors found in this file (it needs at least a background and a foreground)");
  return theme;
}

export type Agent = { name: string; programs: string[]; resume: string };

const INTERPRETER = /^(node|nodejs|bun|bunx|deno|npx|pnpx|uv|uvx|python[\d.]*)$/;

/**
 * Which agent (if any) a foreground command line is. Looks at the executable, or at the script when
 * the executable is an interpreter (`node …/claude-code/cli.js`, `python …/bin/kimi`). Hyphenated
 * program names (package folders like `claude-code`) may also match a directory in the path.
 */
export function detectAgent(args: string | string[], agents: Agent[]): Agent | null {
  return match(args, agents)?.agent ?? null;
}

function match(args: string | string[], agents: Agent[]): { agent: Agent; rest: string[] } | null {
  const tokens = Array.isArray(args) ? args : args.trim().split(/\s+/);
  const parts = (p: string) => p.split(/[\\/]/); // Windows paths too
  const base = (p: string) => (parts(p).pop() ?? "").toLowerCase().replace(/\.(js|mjs|cjs|ts|py|exe|cmd)$/, "");
  const candidates = [tokens[0] ?? ""];
  if (INTERPRETER.test(base(candidates[0])) && tokens[1]) candidates.push(tokens[1]);
  for (const agent of agents) {
    for (const [i, c] of candidates.entries()) {
      const dirs = parts(c).slice(0, -1).map((d) => d.toLowerCase());
      if (agent.programs.includes(base(c)) || agent.programs.some((p) => p.includes("-") && dirs.includes(p)))
        return { agent, rest: tokens.slice(i + 1) };
    }
  }
  return null;
}

// Flags that would clash with the resume command, or make no sense on it.
const NOT_KEPT = new Set(["-c", "--continue", "-r", "--resume", "--last", "-p", "--print", "-h", "--help", "-v", "--version"]);

/**
 * Command that continues the agent session running as `args`, keeping its on/off flags
 * (`--dangerously-skip-permissions`, `--yolo`). Flags that take a value are dropped with their value:
 * argv can't tell `--model opus` from `--verbose prompt`, so a flag followed by a non-flag is skipped.
 */
export function resumeFor(args: string | string[], agents: Agent[], keepFlags = true): string | null {
  const m = match(args, agents);
  if (!m?.agent.resume) return null;
  if (!keepFlags) return m.agent.resume;
  const have = new Set(m.agent.resume.split(/\s+/));
  const flags: string[] = [];
  for (const [i, tok] of m.rest.entries()) {
    if (tok === "--") break; // everything after is positional
    const next = m.rest[i + 1];
    const standalone = next === undefined || next.startsWith("-");
    // strict shape: this text is typed into a shell
    if (standalone && /^--?[A-Za-z0-9][\w-]*$/.test(tok) && !NOT_KEPT.has(tok) && !have.has(tok) && !flags.includes(tok)) flags.push(tok);
  }
  return [m.agent.resume, ...flags].join(" ");
}

/** Svelte action: inline rename. Enter/blur saves (blank keeps the old name), Escape cancels. */
export function renameInput(node: HTMLInputElement, { obj, done }: { obj: { name: string }; done: () => void }) {
  const original = obj.name;
  let finished = false;
  node.select();
  const finish = (save: boolean) => {
    if (finished) return;
    finished = true;
    obj.name = save && node.value.trim() ? node.value.trim() : original;
    done();
  };
  node.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  node.onblur = () => finish(true);
}

// ---- platform & shortcuts ----
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || navigator.userAgent);

/** App shortcut on a letter key: ⌘X on macOS; Ctrl+Shift+X elsewhere (plain Ctrl+X belongs to the
 *  shell), like Windows Terminal. Matches the physical key, so it works in any keyboard layout. */
export const appKey = (e: KeyboardEvent, letter: string) =>
  e.code === `Key${letter}` && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey && !e.shiftKey : e.ctrlKey && e.shiftKey && !e.metaKey);

/** Labels for tooltips and hints, per platform. */
export const K = isMac
  ? {
      app: (l: string) => `⌘${l}`,
      settings: "⌘,", bigger: "⌘+", smaller: "⌘−", resetSize: "⌘0",
      findNext: "⌘G", findPrev: "⇧⌘G",
      tab: (n: number) => `⌘${n}`, group: (n: number) => `⌥⌘${n}`,
      altClick: "⌥-click", panes: "⌥⌘← / ⌥⌘→", cycle: "⌘⇧[ / ⌘⇧]", recent: "⌃Tab",
    }
  : {
      app: (l: string) => `Ctrl+Shift+${l}`,
      settings: "Ctrl+,", bigger: "Ctrl+=", smaller: "Ctrl+−", resetSize: "Ctrl+0",
      findNext: "F3", findPrev: "Shift+F3",
      tab: (n: number) => `Alt+${n}`, group: (n: number) => `Ctrl+Alt+${n}`,
      altClick: "Alt+click", panes: "Ctrl+Alt+← / →", cycle: "Ctrl+PgUp / Ctrl+PgDn", recent: "Ctrl+Tab",
    };

// ---- unified diff (git diff output) for the changes pane ----
export type DiffLine = { kind: "add" | "del" | "ctx"; old?: number; new?: number; text: string };
export type DiffFile = {
  path: string;
  from?: string; // old path when renamed
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  added: number;
  deleted: number;
  hunks: { header: string; lines: DiffLine[] }[];
};

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | undefined;
  let h: DiffFile["hunks"][number] | undefined;
  let o = 0;
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // "a/PATH b/PATH": both halves are the same path except for renames, which name theirs below
      const rest = line.slice(11);
      f = { path: rest.slice(2, 2 + (rest.length - 5) / 2), status: "modified", binary: false, added: 0, deleted: 0, hunks: [] };
      files.push(f);
      h = undefined;
    } else if (!f) continue;
    else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (!m) continue;
      o = +m[1];
      n = +m[2];
      h = { header: line, lines: [] };
      f.hunks.push(h);
    } else if (!h) {
      // the file's header lines
      if (line.startsWith("new file")) f.status = "added";
      else if (line.startsWith("deleted file")) f.status = "deleted";
      else if (line.startsWith("rename from ")) (f.status = "renamed"), (f.from = line.slice(12));
      else if (line.startsWith("rename to ")) f.path = line.slice(10);
      else if (line.startsWith("+++ b/")) f.path = line.slice(6);
      else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) f.binary = true;
    } else if (line[0] === "+") {
      h.lines.push({ kind: "add", new: n++, text: line.slice(1) });
      f.added++;
    } else if (line[0] === "-") {
      h.lines.push({ kind: "del", old: o++, text: line.slice(1) });
      f.deleted++;
    } else if (line[0] === " ") h.lines.push({ kind: "ctx", old: o++, new: n++, text: line.slice(1) });
    // anything else ("\ No newline at end of file", the empty last line) is not content
  }
  return files;
}
