<script lang="ts">
  import { HANDLES, resizeRect, type Handle, type Rect } from './selection.ts';

  type Props = {
    /** Where the frame is, in canvas pixels. Owned by the caller. */
    rect: Rect;
    /** The ground it may cover — the caller's rules about chrome and edges. */
    region: Rect;
    onchange: (rect: Rect) => void;
  };

  let { rect, region, onchange }: Props = $props();

  /** How far one arrow-key press moves an edge, and how far with shift held. */
  const STEP_PX = 12;
  const STRIDE_PX = 48;

  const LABELS: Record<Handle, string> = {
    nw: 'top left corner',
    n: 'top edge',
    ne: 'top right corner',
    e: 'right edge',
    se: 'bottom right corner',
    s: 'bottom edge',
    sw: 'bottom left corner',
    w: 'left edge',
  };

  /**
   * The frame as it was when the drag began, plus where the pointer started.
   *
   * Held rather than read back from the prop because a drag is measured from
   * its own origin: an edge held against the region stops moving while the
   * finger keeps going, and accumulating per-move deltas instead would leave
   * the frame trailing the pointer by however far it had been over the limit.
   */
  let drag: { id: number; handle: Handle; from: Rect; at: { x: number; y: number } } | null = null;

  function grab(handle: Handle, event: PointerEvent) {
    // The map is underneath: without this, a drag on a handle also pans it.
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    // A copy, not the prop: the drag is measured against the frame as it was
    // when it started, whoever owns the object it came in.
    drag = {
      id: event.pointerId,
      handle,
      from: { ...rect },
      at: { x: event.clientX, y: event.clientY },
    };
  }

  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    onchange(
      resizeRect(
        drag.from,
        drag.handle,
        event.clientX - drag.at.x,
        event.clientY - drag.at.y,
        region,
      ),
    );
  }

  function release(event: PointerEvent) {
    if (drag && event.pointerId === drag.id) drag = null;
  }

  function nudge(handle: Handle, event: KeyboardEvent) {
    const step = event.shiftKey ? STRIDE_PX : STEP_PX;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = by[event.key];
    if (!delta) return;
    // Otherwise the arrow keys scroll the page out from under the map.
    event.preventDefault();
    onchange(resizeRect(rect, handle, delta[0], delta[1], region));
  }
</script>

<!--
  A viewfinder over the map, not a shape drawn on it.

  Everything but the handles is `pointer-events: none`, so panning and pinching
  work through the frame exactly as they do anywhere else on the map — the
  ground moves under the frame and the frame stays where it was put. The dim
  outside is a single spread box-shadow rather than four panels, so there is one
  element to repaint while a handle is being dragged.
-->
<div class="layer">
  <div
    class="frame"
    style:left="{rect.left}px"
    style:top="{rect.top}px"
    style:width="{rect.right - rect.left}px"
    style:height="{rect.bottom - rect.top}px"
  >
    {#each HANDLES as handle (handle)}
      <button
        type="button"
        class="handle handle--{handle}"
        aria-label="Resize the area by its {LABELS[handle]}"
        onpointerdown={(event) => grab(handle, event)}
        onpointermove={move}
        onpointerup={release}
        onpointercancel={release}
        onkeydown={(event) => nudge(handle, event)}
      ></button>
    {/each}
  </div>
</div>

<style>
  .layer {
    position: absolute;
    inset: 0;
    /*
     * Over the map's own labels, which lift themselves above the plain map with
     * z-indexes of their own. A place name left on top of the dim would be the
     * one thing outside the frame that did not look excluded.
     */
    z-index: 3;
    pointer-events: none;
  }

  .frame {
    position: absolute;
    border: 2px solid var(--wrong);
    border-radius: 3px;
    /*
     * Everything outside the frame, knocked back far enough to read as "not
     * this" while leaving the relief legible — you are still choosing by what
     * the terrain looks like out there.
     */
    box-shadow:
      0 0 0 200vmax rgba(20, 26, 33, 0.3),
      0 0 0 1px rgba(255, 255, 255, 0.55) inset;
  }

  .handle {
    position: absolute;
    margin: 0;
    padding: 0;
    background: none;
    border: 0;
    pointer-events: auto;
    /* The browser's own pan and zoom would otherwise eat the drag. */
    touch-action: none;
  }
  .handle::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    translate: -50% -50%;
    background: #fff;
    border: 2px solid var(--wrong);
    border-radius: 3px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  }
  .handle:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }

  /*
   * Hit areas a fingertip wide, over marks small enough not to hide the ground
   * being chosen. Corners take the four ends; the edge strips run between them,
   * so a grab is never ambiguous about which one it got.
   */
  .handle--nw,
  .handle--ne,
  .handle--se,
  .handle--sw {
    width: 44px;
    height: 44px;
  }
  .handle--nw::after,
  .handle--ne::after,
  .handle--se::after,
  .handle--sw::after {
    width: 16px;
    height: 16px;
  }
  .handle--nw { left: -22px; top: -22px; cursor: nwse-resize; }
  .handle--ne { right: -22px; top: -22px; cursor: nesw-resize; }
  .handle--se { right: -22px; bottom: -22px; cursor: nwse-resize; }
  .handle--sw { left: -22px; bottom: -22px; cursor: nesw-resize; }

  .handle--n,
  .handle--s {
    left: 22px;
    right: 22px;
    height: 30px;
    cursor: ns-resize;
  }
  .handle--n { top: -15px; }
  .handle--s { bottom: -15px; }
  .handle--n::after,
  .handle--s::after {
    width: 30px;
    height: 8px;
  }

  .handle--e,
  .handle--w {
    top: 22px;
    bottom: 22px;
    width: 30px;
    cursor: ew-resize;
  }
  .handle--w { left: -15px; }
  .handle--e { right: -15px; }
  .handle--e::after,
  .handle--w::after {
    width: 8px;
    height: 30px;
  }
</style>
