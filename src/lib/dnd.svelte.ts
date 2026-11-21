// Pointer-based drag & drop. HTML5 DnD fights Tauri's native file-drop handler, so we roll our own.
// Drop targets are any element with data-drop="<kind>:<id>"; the dragged item decides what a drop means.

export const dnd = $state<{ dragging: string | null; over: string | null }>({ dragging: null, over: null });

// While dragging near (or past) the edge of a `data-autoscroll="x" | "y"` container that the
// dragged item lives in, scroll it.
const EDGE = 40; // px from the edge where scrolling starts
const MAX_SPEED = 14; // px per frame at (or beyond) the edge

function autoscroll(dragged: HTMLElement, x: number, y: number) {
  let moved = false;
  for (const el of document.querySelectorAll<HTMLElement>("[data-autoscroll]")) {
    if (!el.contains(dragged)) continue;
    const r = el.getBoundingClientRect();
    const horizontal = el.dataset.autoscroll === "x";
    const [pos, lo, hi, crossPos, crossLo, crossHi] = horizontal ? [x, r.left, r.right, y, r.top, r.bottom] : [y, r.top, r.bottom, x, r.left, r.right];
    if (crossPos < crossLo - EDGE || crossPos > crossHi + EDGE) continue; // pointer isn't alongside it
    const speed = (d: number) => Math.round(MAX_SPEED * Math.min(1, Math.max(0, (EDGE - d) / EDGE)));
    const delta = speed(hi - pos) - speed(pos - lo);
    if (!delta) continue;
    const before = horizontal ? el.scrollLeft : el.scrollTop;
    if (horizontal) el.scrollLeft += delta;
    else el.scrollTop += delta;
    moved ||= (horizontal ? el.scrollLeft : el.scrollTop) !== before;
  }
  return moved;
}

type Opts = { id: string; drop: (target: string) => void };

export function draggable(node: HTMLElement, opts: Opts) {
  let current = opts;

  function down(e: PointerEvent) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input, button")) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    let x = x0;
    let y = y0;
    let frame = 0;

    const hitTest = () => {
      const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
      dnd.over = hit?.dataset.drop ?? null;
    };
    const tick = () => {
      if (autoscroll(node, x, y)) hitTest(); // content slid under the pointer
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      if (!started && Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
      x = e.clientX;
      y = e.clientY;
      if (!started) frame = requestAnimationFrame(tick);
      started = true;
      dnd.dragging = current.id;
      hitTest();
    };
    const up = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!started) return;
      const target = dnd.over;
      dnd.dragging = dnd.over = null;
      // swallow the click that follows the drag so it doesn't activate/collapse anything
      const swallow = (e: Event) => e.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }));
      if (target) current.drop(target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  node.addEventListener("pointerdown", down);
  return {
    update: (o: Opts) => (current = o),
    destroy: () => node.removeEventListener("pointerdown", down),
  };
}
