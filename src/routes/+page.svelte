<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { listen } from "@tauri-apps/api/event";
  import { invoke } from "@tauri-apps/api/core";
  import Sidebar from "$lib/Sidebar.svelte";
  import Settings from "$lib/Settings.svelte";
  import { app, status, load, saveNow, activate, splitWith, closePane, focusPane, closeTab, moveTab, previousTab, cycleTab, zoom, nextAttention, addTerm, findTerm, allTerms, type Term } from "$lib/store.svelte";
  import { show, showGroup, fitVisible, focusActive, restart, paste, applySettings, defaultTheme, termForRun, snapshot, find, endFind, found } from "$lib/terms.svelte";
  import { dnd, draggable } from "$lib/dnd.svelte";
  import { update, startUpdateChecks, installAndRestart } from "$lib/update.svelte";
  import { shellQuote, renameInput, isMac, appKey, K } from "$lib/util";

  let host: HTMLDivElement;
  let strip: HTMLDivElement; // scrolling part of the tab bar
  let renamingTab = $state<string | null>(null); // double-click a tab to rename
  let park: HTMLDivElement; // hidden home for terminals that aren't in a pane
  const bodies = $state<Record<string, HTMLDivElement>>({}); // reactive: a new pane's box may bind after the effect first runs
  let ready = $state(false);
  let settingsOpen = $state(false);

  // ⌘Q / window close: warn if anything is still running
  type Running = { id: string; name: string; group: string; program: string };
  // one confirm dialog for quitting and for deleting terminals that are still running something
  let quitting = $state<{ quit: boolean; title: string; verb: string; button: string; list: Running[]; action: () => void } | null>(null);

  /** Terminals among `ids` that are running a program (or look busy where the OS can't tell). */
  async function runningIn(ids: string[]): Promise<Running[]> {
    const running = await invoke<{ id: string; program: string }[]>("pty_running").catch(() => []);
    const programs = new Map(running.map((r) => [termForRun(r.id), r.program]));
    return allTerms()
      .filter(({ t }) => ids.includes(t.id) && (programs.has(t.id) || status[t.id] === "busy"))
      .map(({ g, t }) => ({ id: t.id, name: t.name, group: g.name, program: programs.get(t.id) ?? "working" }));
  }

  /** Sidebar delete: ask first if something is running. Returns false when nothing is (caller proceeds its own way). */
  async function confirmDelete(ids: string[], what: "group" | "terminal", action: () => void) {
    const list = await runningIn(ids);
    if (!list.length) return false;
    const title = what === "group" ? `Close group “${findTerm(ids[0])?.g.name}”?` : `Close “${findTerm(ids[0])?.t.name}”?`;
    quitting = { quit: false, title, verb: "Closing", button: "Close anyway", list, action };
    return true;
  }
  // record where every terminal is and write it out before the processes die
  async function saveState() {
    await snapshot();
    await saveNow().catch(console.error);
  }
  async function quitApp() {
    await saveState();
    invoke("quit");
  }

  async function restartForUpdate() {
    const go = async () => (await saveState(), installAndRestart());
    const list = await runningIn(allTerms().map(({ t }) => t.id));
    if (!list.length) return go();
    quitting = { quit: true, title: `Restart to update to ${update.version}?`, verb: "Restarting", button: "Restart now", list, action: go };
  }

  async function requestQuit() {
    if (quitting?.quit) return quitApp(); // second ⌘Q confirms
    const list = await runningIn(allTerms().map(({ t }) => t.id));
    if (!list.length) return quitApp();
    quitting = { quit: true, title: "Quit TerminVox?", verb: "Quitting", button: "Quit anyway", list, action: quitApp };
  }

  // ⌘F find in the active terminal
  let finding = $state<string | null>(null);
  let findInput = $state<HTMLInputElement>();
  function openFind() {
    finding ??= "";
    queueMicrotask(() => findInput?.select());
  }
  function closeFind() {
    finding = null;
    endFind();
  }
  function onFindKey(e: KeyboardEvent) {
    if (e.key === "Escape") closeFind();
    else if (e.key === "Enter") find(finding ?? "", e.shiftKey ? -1 : 1);
    else return;
    e.preventDefault();
  }
  $effect(() => {
    app.active; // switching terminals closes the find bar
    untrack(() => finding !== null && closeFind());
  });

  // ⌘P quick open
  let quick = $state<{ q: string; i: number } | null>(null);
  const fuzzy = (q: string, s: string) => {
    let i = 0;
    for (const c of s.toLowerCase()) if (c === q[i]) i++;
    return i === q.length;
  };
  const matches = $derived(quick ? allTerms().filter(({ g, t }) => fuzzy(quick!.q.toLowerCase(), `${g.name} ${t.name}`)) : []);

  // ⌘R: search the shell's command history; Enter puts the command on the prompt (not run)
  let hist = $state<{ q: string; i: number; all: string[] } | null>(null);
  const openHistory = () => invoke<string[]>("shell_history").then((all) => (hist = { q: "", i: 0, all }), console.error);
  const histMatches = $derived.by(() => {
    if (!hist) return [];
    const words = hist.q.toLowerCase().split(/\s+/).filter(Boolean);
    const out: string[] = [];
    for (const c of hist.all) {
      const l = c.toLowerCase();
      if (words.every((w) => l.includes(w)) && out.push(c) === 50) break;
    }
    return out;
  });
  function pickHistory(cmd?: string) {
    hist = null;
    if (cmd && app.active) paste(app.active, cmd);
  }
  function onHistKey(e: KeyboardEvent) {
    if (!hist) return;
    if (e.key === "Escape") hist = null;
    else if (e.key === "ArrowDown") hist.i = Math.min(hist.i + 1, histMatches.length - 1);
    else if (e.key === "ArrowUp") hist.i = Math.max(hist.i - 1, 0);
    else if (e.key === "Enter") pickHistory(histMatches[hist.i]);
    else return;
    e.preventDefault();
  }

  // settings dialog
  let editing = $state<{ t: Term; name: string; cwd: string; command: string } | null>(null);
  const openEdit = (t: Term) => (editing = { t, name: t.name, cwd: t.cwd, command: t.command });
  function saveEdit(andRestart: boolean) {
    if (!editing) return;
    const { t, name, cwd, command } = editing;
    const newCwd = cwd.trim() || "~";
    if (newCwd !== t.cwd) t.lastCwd = undefined; // you picked a folder: use it, not the remembered one
    if (command !== t.command) t.resume = undefined;
    Object.assign(t, { name: name.trim() || t.name, cwd: newCwd, command });
    editing = null;
    if (andRestart) {
      activate(t.id);
      restart(t.id);
    }
  }

  onMount(() => {
    load().then(() => (ready = true));
    startUpdateChecks();
    const ro = new ResizeObserver(() => fitVisible());
    ro.observe(host);
    // Files dropped from Finder -> paste their quoted paths into the active terminal (Claude Code attaches images this way).
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "drop" && app.active && payload.paths.length) paste(app.active, payload.paths.map((p) => shellQuote(p)).join(" ") + " ");
    });
    const unlistenMenu = listen("open-settings", () => (settingsOpen = true)); // app menu → Settings…
    const unlistenQuit = listen("quit-requested", requestQuit);
    return () => (ro.disconnect(), [unlisten, unlistenMenu, unlistenQuit].forEach((u) => u.then((f) => f())));
  });

  $effect(() => {
    // re-run only when the panes, their boxes, or the focused one change
    const panes = app.panes.filter((id) => bodies[id]).map((id): [string, HTMLDivElement] => [id, bodies[id]]);
    const focused = app.active;
    if (ready) untrack(() => show(panes, focused, park));
  });

  $effect(() => {
    JSON.stringify(app.settings); // track every setting
    if (ready) untrack(applySettings);
  });

  // keep the active tab visible in the scrolling tab bar
  $effect(() => {
    app.active;
    app.open.length;
    strip?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  // dock badge = number of terminals waiting for you
  const waiting = $derived(Object.values(status).filter((s) => s === "attention").length);
  $effect(() => {
    const w = getCurrentWindow();
    if (isMac) w.setBadgeCount(waiting || undefined).catch(() => {});
    else w.setTitle(waiting ? `(${waiting}) TerminVox` : "TerminVox").catch(() => {}); // no badge on Windows: the taskbar shows the title
  });

  // give keyboard focus back to the terminal when a dialog closes
  $effect(() => {
    if (ready && !quick && !hist && !editing && !settingsOpen && !quitting && finding === null) untrack(focusActive);
  });

  const tabDrop = (id: string) => (target: string) => {
    const [kind, other] = target.split(":");
    if (kind === "tab") moveTab(id, other);
    if (kind === "tabs-end") moveTab(id, null);
  };

  function onKey(e: KeyboardEvent) {
    if (quick || hist || editing || settingsOpen || quitting) return;
    const run = (fn: () => void) => (e.preventDefault(), e.stopPropagation(), fn());
    const mod = isMac ? e.metaKey : e.ctrlKey; // for , = - 0
    const digit = /^Digit[1-9]$/.test(e.code) ? +e.code.slice(5) : 0; // e.code: ⌥/Shift change e.key
    if (mod && e.key === ",") return run(() => (settingsOpen = true));
    if (mod && (e.key === "=" || e.key === "+")) return run(() => zoom(1));
    if (mod && (e.key === "-" || e.key === "_")) return run(() => zoom(-1));
    if (mod && !e.shiftKey && e.code === "Digit0") return run(() => zoom("reset"));
    if (appKey(e, "F")) return run(openFind);
    if (finding && (isMac ? e.metaKey && e.code === "KeyG" : e.key === "F3")) return run(() => find(finding!, e.shiftKey ? -1 : 1));
    if (appKey(e, "P")) return run(() => (quick = { q: "", i: 0 }));
    if (appKey(e, "R")) return run(openHistory);
    if (appKey(e, "J")) return run(nextAttention);
    if (appKey(e, "T")) return run(() => addTerm());
    if (appKey(e, "D")) return run(() => addTerm(undefined, true));
    if (appKey(e, "W")) return run(() => app.active && closeTab(app.active));
    const paneMod = isMac ? e.metaKey && e.altKey : e.ctrlKey && e.altKey;
    if (paneMod && e.key === "ArrowLeft") return run(() => focusPane(-1));
    if (paneMod && e.key === "ArrowRight") return run(() => focusPane(1));
    if (isMac ? e.metaKey && e.shiftKey && e.code === "BracketLeft" : e.ctrlKey && e.key === "PageUp") return run(() => cycleTab(-1));
    if (isMac ? e.metaKey && e.shiftKey && e.code === "BracketRight" : e.ctrlKey && e.key === "PageDown") return run(() => cycleTab(1));
    if (e.ctrlKey && e.key === "Tab") return run(previousTab);
    // group N: ⌥⌘N / Ctrl+Alt+N;  tab N: ⌘N / Alt+N
    if (digit && (isMac ? e.metaKey && e.altKey : e.ctrlKey && e.altKey))
      return run(() => app.groups[digit - 1] && showGroup(app.groups[digit - 1].id));
    if (digit && (isMac ? e.metaKey && !e.altKey : e.altKey && !e.ctrlKey && !e.metaKey))
      return run(() => app.open[digit - 1] && activate(app.open[digit - 1]));
  }

  function onQuickKey(e: KeyboardEvent) {
    if (!quick) return;
    if (e.key === "Escape") quick = null;
    else if (e.key === "ArrowDown") quick.i = Math.min(quick.i + 1, matches.length - 1);
    else if (e.key === "ArrowUp") quick.i = Math.max(quick.i - 1, 0);
    else if (e.key === "Enter") {
      const m = matches[quick.i];
      quick = null;
      if (m) activate(m.t.id);
    } else return;
    e.preventDefault();
  }

  const focus = (n: HTMLElement) => n.focus();
</script>

<svelte:window onkeydowncapture={onKey} />

<main>
  <Sidebar onEdit={openEdit} {confirmDelete} />

  <section>
    <nav class="tabs">
      <div
        class="tab-strip"
        data-autoscroll="x"
        bind:this={strip}
        onwheel={(e) => Math.abs(e.deltaY) > Math.abs(e.deltaX) && (strip.scrollLeft += e.deltaY)}
      >
      {#each app.open as id, i (id)}
        {@const t = findTerm(id)?.t}
        {#if t}
          <div
            class="tab"
            class:active={app.active === id}
            class:shown={app.panes.length > 1 && app.panes.includes(id) && app.active !== id}
            class:over={dnd.dragging && dnd.over === `tab:${id}`}
            class:dragging={dnd.dragging === id}
            data-drop="tab:{id}"
            use:draggable={{ id, drop: tabDrop(id) }}
            role="tab"
            tabindex="-1"
            aria-selected={app.active === id}
            title={`${i < 9 ? `${K.tab(i + 1)} · ` : ""}${K.altClick}: open beside`}
            onclick={(e) => (e.altKey ? splitWith(id) : activate(id))}
            onauxclick={(e) => e.button === 1 && closeTab(id)}
            onkeydown={() => {}}
          >
            <span class="dot {status[id] ?? 'off'}"></span>
            {#if renamingTab === id}
              <input
                class="tab-rename"
                value={t.name}
                size={Math.max(t.name.length, 6)}
                use:renameInput={{ obj: t, done: () => ((renamingTab = null), focusActive()) }}
                onclick={(e) => e.stopPropagation()}
                onpointerdown={(e) => e.stopPropagation()}
              />
            {:else}
              <span role="none" ondblclick={(e) => (e.stopPropagation(), (renamingTab = id))}>{t.name}</span>
            {/if}
            <button title="Close tab ({K.app('W')}) — process keeps running" onclick={(e) => (e.stopPropagation(), closeTab(id))}>✕</button>
          </div>
        {/if}
      {/each}
      <button class="new" title="New terminal ({K.app('T')}) · split: {K.app('D')}" onclick={() => addTerm()}>＋</button>
      <div class="tabs-end" data-drop="tabs-end" class:over={dnd.dragging && dnd.over === "tabs-end"}></div>
      </div>
      {#if update.version}
        <button class="update-btn" title="Downloaded and verified — restarting reopens your terminals" onclick={restartForUpdate}
          >Restart to update · {update.version}</button
        >
      {/if}
      <button class="settings-btn" title="Search command history ({K.app('R')})" aria-label="Search command history" onclick={openHistory}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4M2.3 2v2.3h2.3M8 5v3.2l2 1.3" />
        </svg>
      </button>
      <button class="settings-btn" title="Settings ({K.settings})" aria-label="Settings" onclick={() => (settingsOpen = true)}>⚙</button>
    </nav>
    <div class="host" bind:this={host} style:background={(app.settings.theme ?? defaultTheme).background}>
      <div class="park" bind:this={park}></div>
      {#each app.panes as id (id)}
        {@const t = findTerm(id)?.t}
        <div class="pane" class:focused={app.panes.length > 1 && app.active === id}>
          {#if app.panes.length > 1 && t}
            <div class="pane-head" role="none" onclick={() => activate(id)}>
              <span class="dot {status[id] ?? 'off'}"></span>
              <span class="pane-name">{t.name}</span>
              <button title="Close pane — tab and process stay" aria-label="Close pane {t.name}" onclick={(e) => (e.stopPropagation(), closePane(id))}>✕</button>
            </div>
          {/if}
          <div class="pane-body" bind:this={bodies[id]}>
          {#if finding !== null && id === app.active}
            <div class="find" role="search">
              <input
                bind:this={findInput}
                bind:value={finding}
                placeholder="Find"
                aria-label="Find in terminal"
                oninput={() => find(finding ?? "", 0)}
                onkeydown={onFindKey}
              />
              <span class="count">{finding ? (found.count ? `${found.index + 1}/${found.count}` : "0/0") : ""}</span>
              <button title="Previous (⇧↩ / {K.findPrev})" aria-label="Previous match" onclick={() => find(finding ?? "", -1)}>↑</button>
              <button title="Next (↩ / {K.findNext})" aria-label="Next match" onclick={() => find(finding ?? "", 1)}>↓</button>
              <button title="Close (Esc)" aria-label="Close find" onclick={closeFind}>✕</button>
            </div>
          {/if}
          </div>
        </div>
      {/each}
      {#if ready && !app.active}
        <div class="empty">
          <p>No terminal open</p>
          <p><kbd>{K.app("P")}</kbd> open · <kbd>{K.app("T")}</kbd> new · <kbd>{K.app("J")}</kbd> next waiting</p>
        </div>
      {/if}
    </div>
  </section>
</main>

{#if quick}
  <div class="overlay" role="presentation" onclick={() => (quick = null)}>
    <div class="palette" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onQuickKey}>
      <input placeholder="Go to terminal…" bind:value={quick.q} oninput={() => quick && (quick.i = 0)} use:focus />
      {#each matches as { g, t }, i (t.id)}
        <div
          class="item"
          class:sel={i === quick.i}
          role="option"
          aria-selected={i === quick.i}
          tabindex="-1"
          onclick={() => ((quick = null), activate(t.id))}
          onkeydown={() => {}}
        >
          <span class="dot {status[t.id] ?? 'off'}"></span>
          {t.name} <span class="muted">{g.name}</span>
        </div>
      {:else}
        <div class="item muted">No matches</div>
      {/each}
    </div>
  </div>
{/if}

{#if hist}
  <div class="overlay" role="presentation" onclick={() => (hist = null)}>
    <div class="palette wide" role="dialog" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onHistKey}>
      <input placeholder="Search command history…  (Enter puts it on the prompt)" bind:value={hist.q} oninput={() => hist && (hist.i = 0)} use:focus />
      <div class="results">
        {#each histMatches as cmd, i (cmd)}
          <div class="item cmd" class:sel={i === hist.i} role="option" aria-selected={i === hist.i} tabindex="-1" onclick={() => pickHistory(cmd)} onkeydown={() => {}}>
            {cmd}
          </div>
        {:else}
          <div class="item muted">{hist.all.length ? "No matches" : "No shell history found"}</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if editing}
  <div class="overlay" role="presentation" onclick={() => (editing = null)}>
    <div
      class="dialog"
      role="dialog"
      aria-label="Terminal settings"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && (editing = null)}
    >
    <form onsubmit={(e) => (e.preventDefault(), saveEdit(false))}>
      <h3>Terminal settings</h3>
      <label>Name <input bind:value={editing.name} use:focus /></label>
      <label
          >Folder <input bind:value={editing.cwd} placeholder="~/work/project" />
          {#if editing.t.lastCwd && editing.t.lastCwd !== editing.cwd}<small>Last seen in <code>{editing.t.lastCwd}</code> — it reopens there. Change this field to start somewhere else.</small>{/if}
        </label>
      <label
        >Startup command <input bind:value={editing.command} placeholder="claude --continue" />
        <small>Runs when the terminal starts. Folder and command apply on next (re)start.</small>
      </label>
      <div class="buttons">
        <button type="button" onclick={() => (editing = null)}>Cancel</button>
        <button type="button" onclick={() => saveEdit(true)}>Save & restart</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
    </div>
  </div>
{/if}

{#if quitting}
  <div class="overlay" role="presentation" onclick={() => (quitting = null)}>
    <div
      class="dialog"
      role="alertdialog"
      aria-labelledby="quit-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === "Escape" && (quitting = null)}
    >
      <h3 id="quit-title">{quitting.title}</h3>
      <p class="muted">
        {quitting.list.length === 1 ? "This terminal is" : `These ${quitting.list.length} terminals are`} still running something. {quitting.verb} stops
        {quitting.list.length === 1 ? "it" : "them"}.
      </p>
      <ul class="running">
        {#each quitting.list as r (r.id)}
          <li>
            <span class="dot {status[r.id] ?? 'off'}"></span>
            <b>{r.name}</b> <span class="muted">{r.group}</span> <code>{r.program}</code>
          </li>
        {/each}
      </ul>
      {#if quitting.quit}<p class="muted hint">Claude Code and Codex keep their conversations: <code>claude --continue</code> / <code>codex resume</code>.</p>{/if}
      <div class="buttons">
        <button type="button" onclick={() => (quitting = null)}>Cancel</button>
        <button
          type="button"
          class="danger"
          use:focus
          onclick={() => {
            const { action } = quitting!;
            quitting = null;
            action();
          }}>{quitting.button}</button
        >
      </div>
    </div>
  </div>
{/if}

{#if settingsOpen}
  <Settings onClose={() => (settingsOpen = false)} />
{/if}

<style>
  :global(:root) {
    --bg: #1e1f22;
    --panel: #2b2d30;
    --border: #393b40;
    --hover: #35373b;
    --selected: #2e436e;
    --fg: #dfe1e5;
    --muted: #8c8f94;
    --accent: #3574f0;
    --ok: #5fb865;
    --busy: #6aa0f7;
    --attention: #f2c55c;
    color-scheme: dark;
  }
  :global(html, body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    display: flex;
    height: 100vh;
  }
  section {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .tabs {
    display: flex;
    height: 34px;
    flex-shrink: 0;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .tab-strip {
    flex: 1;
    min-width: 0;
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
  }
  /* scrolls with the wheel/trackpad, but never shows a scrollbar */
  .tab-strip {
    scrollbar-width: none;
  }
  .tab-strip::-webkit-scrollbar {
    display: none;
  }
  .tab {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 6px 0 12px;
    white-space: nowrap;
    color: var(--muted);
    border-right: 1px solid var(--border);
    cursor: default;
    -webkit-user-select: none; /* WebKit (macOS webview) ignores the unprefixed one */
    user-select: none;
  }
  .tab-rename {
    font: inherit;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 1px 4px;
    outline: none;
  }
  .tab.over {
    box-shadow: inset 2px 0 var(--accent);
  }
  .tab.dragging {
    opacity: 0.5;
  }
  .tabs-end {
    flex: 1;
    min-width: 20px;
  }
  .tabs-end.over {
    box-shadow: inset 2px 0 var(--accent);
  }
  .tab:hover {
    background: var(--hover);
  }
  .tab.shown {
    color: var(--fg);
    box-shadow: inset 0 -2px var(--muted);
  }
  .tab.active {
    color: var(--fg);
    background: var(--bg);
    box-shadow: inset 0 -2px var(--accent);
  }
  .tab button,
  .new {
    background: none;
    border: none;
    color: var(--muted);
    border-radius: 3px;
    padding: 2px 5px;
    cursor: pointer;
  }
  .tab button {
    visibility: hidden;
    font-size: 11px;
  }
  .tab:hover button,
  .tab.active button {
    visibility: visible;
  }
  .tab button:hover,
  .new:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .new {
    flex-shrink: 0;
    padding: 0 12px;
  }
  .update-btn {
    flex-shrink: 0;
    align-self: center;
    margin: 0 8px;
    padding: 4px 10px;
    font: inherit;
    font-size: 12px;
    color: #fff;
    background: var(--accent);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .settings-btn {
    flex-shrink: 0;
    width: 44px;
    font-size: 19px;
    line-height: 1;
    color: var(--muted);
    background: none;
    border: none;
    border-left: 1px solid var(--border);
    cursor: pointer;
  }
  .settings-btn:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .host {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .park {
    display: none;
  }
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .pane + .pane {
    border-left: 1px solid var(--border);
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 24px;
    flex-shrink: 0;
    padding: 0 4px 0 10px;
    font-size: 12px;
    color: var(--muted);
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    -webkit-user-select: none; /* WebKit (macOS webview) ignores the unprefixed one */
    user-select: none;
  }
  .pane.focused .pane-head {
    color: var(--fg);
    box-shadow: inset 0 -2px var(--accent);
  }
  .pane-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-head button {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 11px;
    border-radius: 3px;
    padding: 2px 5px;
    cursor: pointer;
  }
  .pane-head button:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .pane-body {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .pane-body :global(.term) {
    position: absolute;
    inset: 6px 0 0 10px;
  }
  .find {
    position: absolute;
    top: 8px;
    right: 18px;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.4);
  }
  .find input {
    width: 200px;
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 7px;
    outline: none;
  }
  .find input:focus {
    border-color: var(--accent);
  }
  .find .count {
    min-width: 44px;
    text-align: center;
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .find button {
    background: none;
    border: none;
    color: var(--muted);
    border-radius: 3px;
    padding: 3px 6px;
    cursor: pointer;
  }
  .find button:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .empty {
    flex: 1;
    display: grid;
    place-content: center;
    text-align: center;
    color: var(--muted);
  }
  kbd {
    font: inherit;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid var(--muted);
  }
  .dot.idle {
    background: var(--ok);
    border-color: var(--ok);
  }
  .dot.busy {
    background: var(--busy);
    border-color: var(--busy);
  }
  .dot.attention {
    background: var(--attention);
    border-color: var(--attention);
  }
  .dot.exited {
    border-color: #c4314b;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.35);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    z-index: 10;
  }
  .palette,
  .dialog {
    width: min(520px, 90vw);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.5);
    overflow: hidden;
  }
  .palette input,
  .dialog input {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 7px 9px;
    outline: none;
  }
  .palette input {
    border: none;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    padding: 11px 14px;
    font-size: 14px;
  }
  .dialog input:focus {
    border-color: var(--accent);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    cursor: default;
  }
  .palette.wide {
    width: min(760px, 92vw);
  }
  .results {
    max-height: 60vh;
    overflow-y: auto;
  }
  .item.cmd {
    display: block;
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item.sel {
    background: var(--selected);
  }
  .muted {
    color: var(--muted);
  }
  .dialog {
    padding: 16px 18px;
  }
  .dialog h3 {
    margin: 0 0 14px;
    font-size: 14px;
  }
  .dialog label {
    display: grid;
    gap: 5px;
    margin-bottom: 12px;
    color: var(--muted);
  }
  .dialog small {
    font-size: 11px;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .buttons button {
    font: inherit;
    color: var(--fg);
    background: var(--hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 12px;
    cursor: pointer;
  }
  .running {
    list-style: none;
    margin: 12px 0;
    padding: 0;
    max-height: 40vh;
    overflow-y: auto;
  }
  .running li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
  }
  .running code,
  .hint code {
    font-size: 12px;
    color: var(--fg);
    background: var(--bg);
    border-radius: 3px;
    padding: 1px 5px;
  }
  .running code {
    margin-left: auto;
  }
  .hint {
    font-size: 12px;
  }
  .buttons .danger {
    background: #c4314b;
    border-color: #c4314b;
  }
  .buttons .primary {
    background: var(--accent);
    border-color: var(--accent);
  }
</style>
