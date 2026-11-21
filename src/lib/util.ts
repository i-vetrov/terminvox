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
for (let i = 0; i < 16; i++) NAMES[`Ansi ${i} Color`] = i < 8 ? ANSI[i] : `bright${ANSI[i - 8][0].toUpperCase()}${ANSI[i - 8].slice(1)}`;

/** Parse an iTerm2 .itermcolors (XML plist) into an xterm.js theme. */
export function parseItermColors(xml: string): Record<string, string> {
  const theme: Record<string, string> = {};
  // Color entries are <key>Name</key><dict>…</dict> with no nested dicts, so a regex is enough.
  for (const [, key, body] of xml.matchAll(/<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const name = NAMES[key.trim()];
    if (!name) continue;
    const c = (k: string) => {
      const m = body.match(new RegExp(`<key>${k} Component</key>\\s*<real>([^<]+)</real>`));
      return Math.round(Math.min(1, Math.max(0, parseFloat(m?.[1] ?? "0"))) * 255)
        .toString(16)
        .padStart(2, "0");
    };
    theme[name] = `#${c("Red")}${c("Green")}${c("Blue")}`;
  }
  if (!theme.background || !theme.foreground) throw new Error("Not an .itermcolors file (no background/foreground)");
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
