<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { app, defaultSettings, zoom, FONT_MIN, FONT_MAX } from "./store.svelte";
  import { defaultTheme } from "./terms.svelte";
  import { parseTheme, isMac, K } from "./util";

  let { onClose }: { onClose: () => void } = $props();
  const s = app.settings;

  // ---- fonts ----
  let fonts = $state<{ name: string; mono: boolean }[] | null>(null);
  let query = $state("");
  let monoOnly = $state(true);

  // Canvas test: a real monospace font renders "iiii" and "MMMM" equally wide. Comparing against two
  // different fallbacks also weeds out names the webview can't load (they'd fall back and differ).
  const ctx = document.createElement("canvas").getContext("2d")!;
  const width = (font: string, text: string) => ((ctx.font = font), ctx.measureText(text).width);
  function isMono(family: string) {
    const f = `40px "${family.replace(/"/g, "")}"`;
    const narrow = width(`${f}, monospace`, "iiiiiiiiii");
    if (Math.abs(narrow - width(`${f}, serif`, "iiiiiiiiii")) > 0.5) return false;
    return Math.abs(narrow - width(`${f}, monospace`, "MMMMMMMMMM")) < 0.5;
  }

  invoke<string[]>("list_fonts")
    .then((names) => (fonts = names.map((name) => ({ name, mono: isMono(name) }))))
    .catch(() => (fonts = []));

  const cssFamily = (name: string) => `"${name}", monospace`;
  // first family in the stored CSS list, unquoted
  const current = $derived(s.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, ""));
  const shown = $derived((fonts ?? []).filter((f) => (!monoOnly || f.mono) && f.name.toLowerCase().includes(query.toLowerCase())));

  // ---- theme ----
  const theme = $derived(s.theme ?? defaultTheme) as Record<string, string>;
  const c = (k: string, fallback: string) => theme[k] ?? fallback;
  let themeError = $state("");
  async function importTheme(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      s.theme = parseTheme(await file.text());
      themeError = "";
    } catch (err) {
      themeError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- agent hooks ----
  type HookState = "on" | "off" | "missing" | "conflict";
  let hooks = $state<{ claude: HookState; codex: HookState } | null>(null);
  let hookError = $state("");
  invoke<typeof hooks>("hooks_status").then((h) => (hooks = h)).catch(() => {});
  async function setHook(agent: "claude" | "codex", install: boolean) {
    try {
      hooks = await invoke<typeof hooks>("hooks_set", { agent, install });
      hookError = "";
    } catch (e) {
      hookError = String(e);
    }
  }
  const hookRows = [
    { key: "claude", name: "Claude Code", file: "~/.claude/settings.json", what: "finished, needs permission, waiting for input" },
    { key: "codex", name: "Codex", file: "~/.codex/config.toml", what: "finished (approval prompts are still guessed)" },
  ] as const;

  const scrollIntoView = (n: HTMLElement, on: boolean) => {
    if (on) n.scrollIntoView({ block: "center" });
  };
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<div class="screen" role="dialog" aria-label="Settings">
  <header>
    <h2>Settings</h2>
    <button class="primary" onclick={onClose}>Done</button>
  </header>

  <div class="body">
    <section class="fonts">
      <h3>Font</h3>
      <input class="search" placeholder="Search fonts…" bind:value={query} />
      <label class="check"><input type="checkbox" bind:checked={monoOnly} /> Monospace only</label>
      <div class="list" role="listbox" aria-label="Fonts">
        {#if !fonts}
          <p class="muted">Loading fonts…</p>
        {:else}
          {#each shown as f (f.name)}
            <button
              role="option"
              aria-selected={f.name === current}
              class:sel={f.name === current}
              style:font-family={cssFamily(f.name)}
              use:scrollIntoView={f.name === current && !query}
              onclick={() => (s.fontFamily = cssFamily(f.name))}
            >
              {f.name}
            </button>
          {:else}
            <p class="muted">No fonts match.</p>
          {/each}
        {/if}
      </div>
    </section>

    <section class="right">
      <div class="row">
        <span class="label">Size</span>
        <div class="stepper">
          <button title="Smaller ({K.smaller})" disabled={s.fontSize <= FONT_MIN} onclick={() => zoom(-1)}>−</button>
          <span>{s.fontSize}px</span>
          <button title="Bigger ({K.bigger})" disabled={s.fontSize >= FONT_MAX} onclick={() => zoom(1)}>+</button>
        </div>
        <span class="label">Line height</span>
        <input type="range" min="1" max="1.6" step="0.05" bind:value={s.lineHeight} />
        <span class="num">{Number(s.lineHeight).toFixed(2)}</span>
      </div>

      <div
        class="preview"
        style:font-family={s.fontFamily}
        style:font-size="{s.fontSize}px"
        style:line-height={s.lineHeight * 1.2}
        style:background={c("background", "#1e1f22")}
        style:color={c("foreground", "#d4d4d4")}
      >
        <div><span style:color={c("green", "#5fb865")}>ivan@mac</span> <span style:color={c("blue", "#6aa0f7")}>~/work/project</span> $ git status</div>
        <div>On branch <span style:color={c("cyan", "#56b6c2")}>main</span> · <span style:color={c("red", "#e06c75")}>2 modified</span> · <span style:color={c("yellow", "#e5c07b")}>1 untracked</span></div>
        <div style:color={c("magenta", "#c678dd")}>fn main() {"{"} println!("Hello, {"{"}{"}"}!", name); {"}"}</div>
        <div>0O 1lI |{"{"}[()]{"}"} =&gt; != === -&gt; ┌─┬─┐ ✓ ✗ ● ★</div>
        <div><span class="cursor" style:background={c("cursor", "#d4d4d4")}>&nbsp;</span></div>
      </div>

      <h3>Behavior</h3>
      {#if isMac}<label class="check"><input type="checkbox" bind:checked={s.optionIsMeta} /> Use ⌥ Option as Meta key <small>(turn off to type accented characters with ⌥)</small></label>{/if}
      <label class="check"><input type="checkbox" bind:checked={s.copyOnSelect} /> Copy text on selection</label>
      <label class="check"><input type="checkbox" bind:checked={s.notify} /> Notify when a terminal needs me (app in background)</label>

      <h3>Shell</h3>
      <div class="row">
        <input
          class="shell"
          bind:value={s.shell}
          placeholder={isMac ? "Default: your login shell ($SHELL)" : "Default: PowerShell (pwsh.exe if installed)"}
          aria-label="Shell program"
        />
      </div>
      <small
        >For new and restarted terminals. {isMac
          ? "e.g. /bin/bash, /opt/homebrew/bin/fish"
          : "e.g. pwsh.exe, powershell.exe, cmd.exe, C:\\Program Files\\Git\\bin\\bash.exe, wsl.exe"}</small
      >

      <h3>Restore on restart</h3>
      <label class="check"><input type="checkbox" bind:checked={s.restoreFolders} /> Reopen each terminal in the folder it was last in</label>
      <label class="check"><input type="checkbox" bind:checked={s.resumeAgents} /> Restart coding agents that were running, continuing their session
        <small>(off: just a shell in that folder)</small></label>
      <label class="check sub" class:off={!s.resumeAgents}
        ><input type="checkbox" bind:checked={s.resumeFlags} disabled={!s.resumeAgents} /> Keep its on/off flags, e.g. <code>--dangerously-skip-permissions</code>
        <small>(flags with a value, like <code>--model opus</code>, are left out)</small></label
      >
      <small>Only the local folder is remembered — inside <code>ssh</code> it's the folder you connected from.</small>
      <table class="agents" class:off={!s.resumeAgents}>
        <thead><tr><th>Agent</th><th>Detected as</th><th>Resume with</th></tr></thead>
        <tbody>
          {#each s.agents as a (a.name)}
            <tr>
              <td>{a.name}</td>
              <td class="muted-cell">{a.programs[0]}</td>
              <td><input bind:value={a.resume} disabled={!s.resumeAgents} aria-label="Resume command for {a.name}" /></td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h3>Exact “waiting for you” status</h3>
      <small>Without this, a terminal is flagged when its output goes quiet — a guess. With it, the agent tells TerminVox itself. Adds a hook to the agent's config (a backup is kept next to it); it does nothing outside TerminVox.</small>
      <table class="agents hooks">
        <tbody>
          {#each hookRows as r (r.key)}
            {@const st = hooks?.[r.key]}
            <tr>
              <td>{r.name}<br /><small>{r.what}</small></td>
              <td class="muted-cell">{r.file}</td>
              <td class="hook-action">
                {#if !hooks}…
                {:else if st === "missing"}<span class="muted-cell">not installed</span>
                {:else if st === "conflict"}<span class="muted-cell" title="You already have your own notify command; TerminVox won't overwrite it">has its own notify</span>
                {:else if st === "on"}<span class="on">✓ on</span> <button onclick={() => setHook(r.key, false)}>Remove</button>
                {:else}<button class="primary" onclick={() => setHook(r.key, true)}>Install</button>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if hookError}<p class="error">{hookError}</p>{/if}
      <small>Takes effect for agent sessions started after installing.</small>

      <h3>Colors</h3>
      <div class="row">
        <span>Theme: <b>{s.theme ? "imported" : "built-in"}</b></span>
        <label class="file">Import from another terminal…<input type="file" onchange={importTheme} hidden /></label>
        {#if s.theme}<button onclick={() => (s.theme = null)}>Reset</button>{/if}
      </div>
      {#if themeError}<p class="error">{themeError}</p>{/if}
      <small>
        Pick the file that holds the colors: an iTerm2 <code>.itermcolors</code> (Profiles → Colors → Color Presets… → Export), a macOS Terminal
        <code>.terminal</code> (Shell → Export Settings…), a Windows Terminal <code>settings.json</code> or scheme, or a Ghostty, kitty or Alacritty
        config or theme file.{#if isMac} In the file dialog, <kbd>⌘⇧.</kbd> shows hidden folders like <code>~/.config</code>.{/if}
      </small>

      <div class="footer">
        <button onclick={() => Object.assign(s, defaultSettings)}>Restore defaults</button>
        <small>Changes apply immediately · <kbd>{K.bigger}</kbd> <kbd>{K.smaller}</kbd> <kbd>{K.resetSize}</kbd> change size anywhere</small>
      </div>
    </section>
  </div>
</div>

<style>
  .screen {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  h2 {
    margin: 0;
    font-size: 15px;
  }
  h3 {
    margin: 18px 0 8px;
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .fonts h3 {
    margin-top: 0;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(220px, 300px) 1fr;
  }
  section {
    padding: 18px 20px;
    min-height: 0;
  }
  .fonts {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
  }
  .right {
    overflow-y: auto;
  }
  .search {
    margin-bottom: 8px;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    margin-top: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
  }
  .list button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 0;
    padding: 7px 12px;
    font-size: 14px;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list button:hover {
    background: var(--hover);
  }
  .list button.sel {
    background: var(--selected);
  }
  .muted {
    color: var(--muted);
    padding: 8px 12px;
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .label {
    color: var(--muted);
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-right: 16px;
  }
  .stepper span {
    min-width: 48px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .stepper button {
    width: 28px;
    padding: 4px 0;
  }
  .num {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .preview {
    margin-top: 16px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: 6px;
    white-space: pre;
    overflow-x: auto;
  }
  .cursor {
    display: inline-block;
    width: 0.6em;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  input:not([type="checkbox"]):not([type="range"]) {
    font: inherit;
    color: inherit;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 7px 9px;
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
  }
  small {
    font-size: 11px;
    color: var(--muted);
  }
  .shell {
    flex: 1;
    max-width: 480px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .agents {
    width: 100%;
    margin-top: 10px;
    border-collapse: collapse;
  }
  .sub {
    margin-left: 24px;
  }
  .sub.off {
    opacity: 0.5;
  }
  .agents.off {
    opacity: 0.5;
  }
  .agents th {
    text-align: left;
    font-weight: 500;
    font-size: 11px;
    color: var(--muted);
    padding: 0 8px 6px 0;
  }
  .agents td {
    padding: 3px 8px 3px 0;
  }
  .agents td:last-child {
    width: 55%;
  }
  .agents input {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
    padding: 5px 8px;
  }
  .muted-cell {
    color: var(--muted);
    font-family: ui-monospace, Menlo, monospace;
    font-size: 12px;
  }
  .hooks td {
    vertical-align: top;
    padding: 6px 8px 6px 0;
  }
  .hooks td.hook-action {
    width: auto;
    text-align: right;
    white-space: nowrap;
  }
  .on {
    color: var(--ok);
  }
  .error {
    color: #e5677c;
    margin: 6px 0;
  }
  button,
  .file {
    font: inherit;
    color: var(--fg);
    background: var(--hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 12px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  kbd {
    font: inherit;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
  }
</style>
