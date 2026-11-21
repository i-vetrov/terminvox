<script lang="ts">
  // Read-only pane: everything uncommitted in the focused terminal's repository, against the last commit.
  import { untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { app, status, findTerm } from "./store.svelte";
  import { snapshot } from "./terms.svelte";
  import { parseDiff, K, type DiffFile } from "./util";

  let { onClose }: { onClose: () => void } = $props();

  type Changes = { root: string; branch: string; diff: string; truncated: boolean };
  let data = $state<(Omit<Changes, "diff"> & { files: DiffFile[] }) | null>(null);
  let error = $state("");
  let loading = $state(false);
  const folded = $state<Record<string, boolean>>({}); // your choice per file; absent = the default below
  let seq = 0; // drops answers that arrive after you moved to another terminal

  async function refresh() {
    const id = app.active;
    const mine = ++seq;
    if (!id) return void ((data = null), (error = ""));
    loading = true;
    await snapshot(); // where the shell is right now
    const t = findTerm(id)?.t;
    try {
      const r = await invoke<Changes>("git_changes", { cwd: t?.lastCwd || t?.cwd || "~" });
      if (mine !== seq) return;
      data = { root: r.root, branch: r.branch, truncated: r.truncated, files: parseDiff(r.diff) };
      error = "";
    } catch (e) {
      if (mine !== seq) return;
      data = null;
      error = String(e);
    }
    loading = false;
  }

  // refresh when you switch terminals, and when the focused one stops working (an agent just finished editing)
  $effect(() => {
    const id = app.active;
    if (!id || status[id] !== "busy") untrack(refresh);
  });

  // ponytail: every line is a DOM row, no virtual list. Big files start folded and so does everything
  // past ~3000 changed lines; virtualize if people really read diffs that size here.
  const view = $derived.by(() => {
    let shown = 0;
    return (data?.files ?? []).map((f) => {
      const lines = f.added + f.deleted;
      const big = lines > 400 || shown > 3000;
      if (!big) shown += lines;
      return { f, big };
    });
  });
  const total = $derived((data?.files ?? []).reduce((s, f) => ({ a: s.a + f.added, d: s.d + f.deleted }), { a: 0, d: 0 }));
  const notRepo = $derived(/not a git repository/i.test(error));
  const SIGN = { add: "+", del: "−", ctx: " " };
</script>

<svelte:window onfocus={refresh} />

<aside class="diff" aria-label="Uncommitted changes">
  <header>
    <b>Changes</b>
    {#if data}
      {#if data.branch}<span class="branch" title={data.root}>{data.branch}</span>{/if}
      <span class="muted">{data.files.length} {data.files.length === 1 ? "file" : "files"}</span>
      <span class="add">+{total.a}</span>
      <span class="del">−{total.d}</span>
    {/if}
    <span class="grow"></span>
    <button title="Refresh" aria-label="Refresh" class:loading onclick={refresh}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4M13.7 2v2.3h-2.3" />
      </svg>
    </button>
    <button title="Close ({K.app('G')})" aria-label="Close changes" onclick={onClose}>✕</button>
  </header>
  <div class="scroll" style:font-family={app.settings.fontFamily} style:font-size="{Math.max(10, app.settings.fontSize - 1)}px">
    {#if error}
      <p class="note">{notRepo ? "This terminal's folder is not in a git repository." : error}</p>
    {:else if data && !data.files.length}
      <p class="note">No uncommitted changes.</p>
    {:else if data}
      {#each view as { f, big } (f.path)}
        {@const closed = folded[f.path] ?? big}
        <section>
          <button class="file" aria-expanded={!closed} onclick={() => (folded[f.path] = !closed)}>
            <span class="caret">{closed ? "▸" : "▾"}</span>
            <span class="path" title={f.path}>{f.from ? `${f.from} → ` : ""}{f.path}</span>
            {#if f.status !== "modified"}<span class="tag">{f.status}</span>{/if}
            <span class="stat"><span class="add">+{f.added}</span>{#if f.deleted}&nbsp;<span class="del">−{f.deleted}</span>{/if}</span>
          </button>
          {#if !closed}
            {#if f.binary}
              <p class="note">Binary or very large file: not shown.</p>
            {:else if !f.hunks.length}
              <p class="note">No content changes.</p>
            {:else}
              {#each f.hunks as h}
                <div class="hunk">{h.header}</div>
                {#each h.lines as l}
                  <div class="line {l.kind}"><span class="no">{l.new ?? l.old}</span><span class="sign">{SIGN[l.kind]}</span><span class="text">{l.text}</span></div>
                {/each}
              {/each}
            {/if}
          {/if}
        </section>
      {/each}
      {#if data.truncated}<p class="note">Too many changes to show them all. The rest is left out.</p>{/if}
    {/if}
  </div>
</aside>

<style>
  .diff {
    --add: #57ab5a;
    --del: #e5534b;
    flex: 1.2;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--fg);
    border-left: 1px solid var(--border);
  }
  :global(:root[data-mode="light"]) .diff {
    --add: #1a7f37;
    --del: #cf222e;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 24px;
    flex-shrink: 0;
    padding: 0 4px 0 10px;
    font-size: 12px;
    white-space: nowrap;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .branch {
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 7px;
    border: 1px solid var(--border);
    border-radius: 9px;
    color: var(--muted);
    font-size: 11px;
  }
  .muted {
    color: var(--muted);
  }
  .add {
    color: var(--add);
  }
  .del {
    color: var(--del);
  }
  .grow {
    flex: 1;
  }
  header button {
    display: grid;
    place-items: center;
    height: 20px;
    background: none;
    border: none;
    color: var(--muted);
    font-size: 12px;
    border-radius: 3px;
    padding: 2px 5px;
    cursor: pointer;
  }
  header button:hover {
    background: var(--hover);
    color: var(--fg);
  }
  header button.loading {
    opacity: 0.4;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    line-height: 1.5;
  }
  .note {
    margin: 0;
    padding: 12px;
    color: var(--muted);
    font: 12px/1.5 system-ui, sans-serif;
  }
  .file {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px 10px;
    font: inherit;
    text-align: left;
    color: var(--fg);
    background: var(--panel);
    border: none;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  section + section .file {
    border-top: 1px solid var(--border);
  }
  .file:hover {
    background: var(--hover);
  }
  .caret {
    width: 10px;
    color: var(--muted);
  }
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl; /* a long path keeps its end, the file name */
    unicode-bidi: plaintext;
  }
  .tag {
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: 9px;
    color: var(--muted);
    font: 10.5px system-ui, sans-serif;
  }
  .stat {
    margin-left: auto;
    white-space: nowrap;
  }
  .hunk {
    padding: 1px 10px 1px 54px;
    color: var(--muted);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line {
    display: flex;
    -webkit-user-select: text;
    user-select: text;
  }
  .line.add,
  .line.del {
    color: var(--fg); /* only the background and the sign are tinted, the code stays readable */
  }
  .line.add {
    background: color-mix(in srgb, var(--add) 18%, transparent);
  }
  .line.del {
    background: color-mix(in srgb, var(--del) 16%, transparent);
  }
  .no {
    flex: none;
    width: 40px;
    padding-right: 6px;
    text-align: right;
    color: var(--muted);
    opacity: 0.75;
    -webkit-user-select: none;
    user-select: none;
  }
  .sign {
    flex: none;
    width: 14px;
    -webkit-user-select: none;
    user-select: none;
  }
  .add .sign {
    color: var(--add);
  }
  .del .sign {
    color: var(--del);
  }
  .text {
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }
</style>
