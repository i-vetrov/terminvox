<script lang="ts">
  import { app, status, SIDEBAR_WIDTH, activate, splitWith, isGroupOpen, addGroup, removeTerm, moveTerm, moveGroup, type Term, type Group } from "./store.svelte";
  import { dispose, showGroup } from "./terms.svelte";
  import { dnd, draggable } from "./dnd.svelte";
  import { renameInput, K } from "./util";
  import { findTerm } from "./store.svelte";

  let {
    onAdd,
    onEdit,
    onEditGroup,
    confirmDelete,
  }: { onAdd: (groupId: string) => void; onEdit: (t: Term) => void; onEditGroup: (g: Group) => void; confirmDelete: (ids: string[], what: "group" | "terminal", action: () => void) => Promise<boolean> } = $props();

  let renaming = $state<string | null>(null);

  // Running something → confirm dialog; otherwise close right away.
  async function remove(ids: string[], what: "group" | "terminal", action: () => void) {
    if (ids.length && (await confirmDelete(ids, what, action))) return;
    action();
  }

  function deleteGroup(gid: string) {
    const g = app.groups.find((x) => x.id === gid)!;
    for (const t of [...g.terms]) {
      dispose(t.id);
      removeTerm(t.id);
    }
    app.groups.splice(app.groups.indexOf(g), 1);
  }

  function deleteTerm(id: string) {
    dispose(id);
    removeTerm(id);
  }

  const rename = (node: HTMLInputElement, obj: { name: string }) => renameInput(node, { obj, done: () => (renaming = null) });

  // target is "group:<id>" or "term:<id>"
  const parse = (target: string) => {
    const [kind, id] = target.split(":");
    return kind === "group" ? { groupId: id } : { groupId: findTerm(id)?.g.id, termId: id };
  };
  const dropTerm = (id: string) => (target: string) => {
    const { groupId, termId } = parse(target);
    if (groupId) moveTerm(id, groupId, termId);
  };
  const dropGroup = (id: string) => (target: string) => {
    const { groupId } = parse(target);
    if (groupId) moveGroup(id, groupId);
  };

  const groupIndex = (id: string) => app.groups.findIndex((g) => g.id === id);

  // drag the right edge to resize; double-click resets
  function resize(e: PointerEvent) {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = app.sidebarWidth;
    handle.onpointermove = (m) => (app.sidebarWidth = Math.round(Math.min(600, Math.max(160, startW + m.clientX - startX))));
    handle.onpointerup = () => (handle.onpointermove = handle.onpointerup = null);
  }

  const attentionCount = (terms: Term[]) => terms.filter((t) => status[t.id] === "attention").length;
</script>

<aside style:width="{app.sidebarWidth}px">
  <header>
    <span>TERMINALS</span>
    <button title="New group" onclick={() => (renaming = addGroup().id)}>＋</button>
  </header>

  <div class="tree" data-autoscroll="y">
    {#each app.groups as g (g.id)}
      <div
        class="row group"
        class:over={dnd.dragging && dnd.over === `group:${g.id}`}
        class:dragging={dnd.dragging === g.id}
        data-drop="group:{g.id}"
        use:draggable={{ id: g.id, drop: dropGroup(g.id) }}
        role="treeitem"
        aria-selected="false"
        aria-expanded={!g.collapsed}
        tabindex="-1"
        onclick={() => (g.collapsed = !g.collapsed)}
        onkeydown={() => {}}
      >
        <span class="chev">{g.collapsed ? "▸" : "▾"}</span>
        {#if renaming === g.id}
          <input value={g.name} use:rename={g} onclick={(e) => e.stopPropagation()} />
        {:else}
          <span class="name" ondblclick={(e) => (e.stopPropagation(), (renaming = g.id))} role="none">{g.name}</span>
        {/if}
        {#if attentionCount(g.terms)}<span class="badge">{attentionCount(g.terms)}</span>{/if}
        <span class="actions">
          <button title="New terminal" onclick={(e) => (e.stopPropagation(), onAdd(g.id))}>＋</button>
          <button title="Rename" onclick={(e) => (e.stopPropagation(), (renaming = g.id))}>✎</button>
          <button title="Startup script for new terminals in this group" onclick={(e) => (e.stopPropagation(), onEditGroup(g))}>⚙</button>
          <button
            title="Delete group"
            onclick={(e) => (e.stopPropagation(), remove(g.terms.map((t) => t.id), "group", () => deleteGroup(g.id)))}>✕</button
          >
        </span>
        <button
          class="open-group"
          class:current={isGroupOpen(g)}
          disabled={!g.terms.length}
          title={g.terms.length ? `Open this group's terminals as tabs${groupIndex(g.id) < 9 ? ` (${K.group(groupIndex(g.id) + 1)})` : ""}` : "Group is empty"}
          aria-label="Open group {g.name}"
          aria-pressed={isGroupOpen(g)}
          onclick={(e) => (e.stopPropagation(), showGroup(g.id))}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <rect x="1.5" y="4.5" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" />
            <path d="M1.5 6.5h13M3.5 2h4M9 2h3.5" stroke="currentColor" fill="none" />
          </svg>
        </button>
      </div>

      {#if !g.collapsed}
        {#each g.terms as t (t.id)}
          <div
            class="row term"
            class:active={app.active === t.id}
            class:over={dnd.dragging && dnd.over === `term:${t.id}`}
            class:dragging={dnd.dragging === t.id}
            data-drop="term:{t.id}"
            use:draggable={{ id: t.id, drop: dropTerm(t.id) }}
            role="treeitem"
            aria-selected={app.active === t.id}
            tabindex="-1"
            title="{t.lastCwd ?? t.cwd}
{K.altClick}: open beside"
            onclick={(e) => (e.altKey ? splitWith(t.id) : activate(t.id))}
            onkeydown={() => {}}
          >
            <span class="dot {status[t.id] ?? 'off'}" title={status[t.id] ?? "not started"}></span>
            {#if renaming === t.id}
              <input value={t.name} use:rename={t} onclick={(e) => e.stopPropagation()} />
            {:else}
              <span class="name" ondblclick={(e) => (e.stopPropagation(), (renaming = t.id))} role="none">{t.name}</span>
            {/if}
            {#if t.agent}<span class="agent">{t.agent}</span>{/if}
            <span class="actions">
              <button title="Settings" onclick={(e) => (e.stopPropagation(), onEdit(t))}>⚙</button>
              <button
                title="Delete terminal"
                onclick={(e) => (e.stopPropagation(), remove([t.id], "terminal", () => deleteTerm(t.id)))}>✕</button
              >
            </span>
          </div>
        {/each}
      {/if}
    {/each}
  </div>
  <div
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
    title="Drag to resize · double-click to reset"
    onpointerdown={resize}
    ondblclick={() => (app.sidebarWidth = SIDEBAR_WIDTH)}
  ></div>
</aside>

<style>
  aside {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-right: 1px solid var(--border);
    -webkit-user-select: none; /* WebKit (macOS webview) ignores the unprefixed one */
    user-select: none;
  }
  .resizer {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
  }
  .resizer:hover,
  .resizer:active {
    background: var(--accent);
    opacity: 0.6;
  }
  .agent {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    line-height: 14px;
  }
  .row:hover .agent {
    display: none; /* make room for the action buttons */
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 10px 6px 14px;
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .tree {
    overflow-y: auto;
    flex: 1;
    padding-bottom: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 6px 0 10px;
    cursor: default;
    border: 1px solid transparent;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.over {
    border-top-color: var(--accent);
  }
  .row.dragging {
    opacity: 0.5;
  }
  .group {
    font-weight: 600;
    margin-top: 4px;
  }
  .term {
    padding-left: 28px;
  }
  .term.active {
    background: var(--selected);
  }
  .chev {
    width: 12px;
    color: var(--muted);
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  input {
    flex: 1;
    min-width: 0;
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 1px 4px;
    outline: none;
  }
  .badge {
    background: var(--attention);
    color: #1e1f22;
    font-size: 10px;
    font-weight: 700;
    border-radius: 8px;
    padding: 0 6px;
  }
  .open-group {
    display: grid;
    place-items: center;
    padding: 3px;
  }
  .open-group:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .open-group.current {
    color: var(--accent);
  }
  .actions {
    display: none;
    gap: 2px;
  }
  .row:hover .actions {
    display: flex;
  }
  button {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 12px;
  }
  button:hover {
    color: var(--fg);
    background: var(--hover);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--muted);
  }
  .dot.idle {
    background: var(--ok);
    border-color: var(--ok);
  }
  .dot.busy {
    background: var(--busy);
    border-color: var(--busy);
    animation: pulse 1s ease-in-out infinite;
  }
  .dot.attention {
    background: var(--attention);
    border-color: var(--attention);
    box-shadow: 0 0 6px var(--attention);
  }
  .dot.exited {
    background: none;
    border-color: #c4314b;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.busy {
      animation: none;
    }
  }
</style>
