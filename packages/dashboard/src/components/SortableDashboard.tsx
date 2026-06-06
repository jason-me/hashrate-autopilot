// #244 v2: always-on drag-to-reorder for the top-level dashboard blocks.
//
// Earlier version (build 581ish) gated reordering behind an explicit
// "Rearrange" mode, partly because chart cards have their own
// drag-to-pan that would fight a card-level drag handler, partly
// because the v1 design used the whole card-title row as the drag
// affordance.
//
// v2 borrows the TilesBar pattern: each card gets a small grip handle
// in the top-left corner that fades in on hover. Drag listeners are
// bound to the grip button only, so pointer events on the chart body
// still route to the chart's own pan/zoom handlers - the conflict
// disappears positionally. A 6 px PointerSensor distance gate stops a
// click in the grip's vicinity from being treated as a drag. Touch
// users get a 180 ms press-and-hold via the TouchSensor; mobile shows
// the grip permanently (no hover state on touch). The "Rearrange"
// header toggle and the rearranging-mode flag in the context are gone.
//
// Persistence + reconciliation against the live block set lives in
// lib/cardOrder.ts; this component is purely the drag surface.

import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { t } from '@lingui/core/macro';

export interface DashboardBlock {
  /** Stable block ID, persisted in the saved order. */
  id: string;
  /** Human-readable, translated label shown on the grip's tooltip / aria. */
  label: string;
  /** The rendered block. */
  node: React.ReactNode;
}

function GripIcon() {
  // Lucide grip-vertical - the universal drag-handle affordance.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="19" r="1" />
    </svg>
  );
}

function SortableItem({ block }: { block: DashboardBlock }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 30 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative group rounded-lg ${
        isDragging ? 'ring-2 ring-amber-500 shadow-lg shadow-black/40' : ''
      }`}
    >
      {/* Grip handle: top-left corner, hover-visible on devices that
          can hover, permanently visible elsewhere (mobile-without-
          hover, and during a drag so the operator can still see what
          they're holding). Listeners are bound to the button only so
          pointer events on the block content reach the chart / panel
          handlers normally. touch-none keeps a touch-drag from also
          scrolling the page. */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`${t`Drag to reorder`}: ${block.label}`}
        title={`${t`Drag to reorder`}: ${block.label}`}
        className={`absolute top-1 left-1 z-20 p-1.5 rounded text-slate-500 hover:text-amber-300 hover:bg-slate-800/80 cursor-grab active:cursor-grabbing touch-none transition-opacity ${
          isDragging
            ? 'opacity-100'
            : 'opacity-0 md:opacity-0 md:group-hover:opacity-100 max-md:opacity-50'
        }`}
      >
        <GripIcon />
      </button>
      {block.node}
    </div>
  );
}

export function SortableDashboard({
  blocks,
  onReorder,
}: {
  blocks: DashboardBlock[];
  onReorder: (ids: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 6 px gate so a click near the grip doesn't become a drag.
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      // Press-and-hold to start on touch so vertical scrolling isn't
      // hijacked by an accidental long-touch on the grip.
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = blocks.map((b) => b.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={blocks.map((b) => b.id)}
        strategy={verticalListSortingStrategy}
      >
        {blocks.map((b) => (
          <SortableItem key={b.id} block={b} />
        ))}
      </SortableContext>
    </DndContext>
  );
}
