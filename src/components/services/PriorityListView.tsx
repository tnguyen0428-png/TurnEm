import { useState, useMemo, type ReactNode } from 'react';
import { GripVertical, ChevronDown, ChevronRight } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import Badge, { getTurnBadgeVariant } from '../shared/Badge';
import { SERVICE_CATEGORIES } from '../../constants/services';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SalonService } from '../../types';

// Merge a saved category order against the live service catalogue.
// Drops categories that no longer exist; appends categories the user hasn't
// reordered yet so a fresh service category is still visible immediately.
function mergeCatOrder(saved: string[], allCats: string[]): string[] {
  const known = new Set(saved);
  const merged = saved.filter(c => allCats.includes(c));
  allCats.forEach(c => { if (!known.has(c)) merged.push(c); });
  return merged;
}

// Same idea for the per-category service order.
function mergeSvcOrder(saved: string[] | undefined, defaultNames: string[]): string[] {
  if (!saved) return [...defaultNames];
  const known = new Set(saved);
  const merged = saved.filter(n => defaultNames.includes(n));
  defaultNames.forEach(n => { if (!known.has(n)) merged.push(n); });
  return merged;
}

// ─── Sortable service row ─────────────────────────────────────────────────────

function SortableServiceRow({ svc, rank }: { svc: SalonService; rank: number }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: svc.name });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 px-3 py-2.5 bg-white rounded-xl border transition-all duration-150 ${
        isDragging
          ? 'opacity-40 shadow-lg border-pink-300'
          : isOver
          ? 'border-pink-300 bg-pink-50/30'
          : 'border-gray-100 hover:border-gray-200'
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="touch-none flex-shrink-0 text-gray-300 hover:text-pink-400 cursor-grab active:cursor-grabbing"
        tabIndex={-1}
      >
        <GripVertical size={13} />
      </button>
      <span className="font-mono text-[10px] text-gray-300 w-4 text-right flex-shrink-0">
        {rank}
      </span>
      <span className="font-mono text-xs text-gray-700 flex-1 min-w-0 truncate">
        {svc.name}
      </span>
      <Badge label={`${svc.turnValue}t`} variant={getTurnBadgeVariant(svc.turnValue)} />
    </div>
  );
}

// ─── Sortable category row ────────────────────────────────────────────────────

interface CatRowProps {
  category: string;
  rank: number;
  serviceCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

function SortableCategoryRow({
  category,
  rank,
  serviceCount,
  isExpanded,
  onToggle,
  children,
}: CatRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: category });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-2xl border overflow-hidden transition-all duration-150 ${
        isDragging
          ? 'opacity-50 shadow-xl border-pink-400 bg-white'
          : isOver
          ? 'border-pink-300 bg-pink-50/20'
          : 'border-gray-200 bg-white'
      }`}
    >
      {/* Row header */}
      <div className="flex items-center gap-2 px-3 py-3">
        {/* Drag handle — listeners here, NOT on the toggle button */}
        <button
          {...attributes}
          {...listeners}
          className="touch-none flex-shrink-0 text-gray-300 hover:text-pink-400 cursor-grab active:cursor-grabbing p-0.5"
          tabIndex={-1}
          onClick={e => e.stopPropagation()}
        >
          <GripVertical size={15} />
        </button>

        {/* Priority number */}
        <span className="font-mono text-xs font-bold text-pink-500 w-5 text-center flex-shrink-0">
          {rank}
        </span>

        {/* Collapse toggle — click only, no drag listeners */}
        <button
          onClick={onToggle}
          className="flex-1 flex items-center gap-2 min-w-0 text-left"
        >
          <span className="font-bebas text-[15px] tracking-widest text-gray-900 leading-none">
            {category}
          </span>
          <span className="font-mono text-[10px] text-gray-400">{serviceCount}</span>
          <span className="ml-auto flex-shrink-0 text-gray-400">
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </button>
      </div>

      {/* Service list (when expanded) */}
      {children}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PriorityListView() {
  const { state, setPriority } = useApp();

  // Group active services by category, ordered by sortOrder as the default
  const servicesByCategory = useMemo(() => {
    const map = new Map<string, SalonService[]>();
    [...state.salonServices]
      .filter(s => s.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach(s => {
        const cat = s.category || 'Other';
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat)!.push(s);
      });
    return map;
  }, [state.salonServices]);

  const allCats = useMemo(() => {
    const present = new Set(
      state.salonServices.map(s => s.category).filter(Boolean)
    );
    return SERVICE_CATEGORIES.filter(c => present.has(c));
  }, [state.salonServices]);

  // Derive the visible orderings from cross-device-synced state. Memoised against the
  // saved priority and the live service catalogue, so an admin adding/removing a
  // service or category re-merges the order without losing the user's drag-set sequence.
  const categoryOrder = useMemo(
    () => mergeCatOrder(state.categoryPriority || [], allCats),
    [state.categoryPriority, allCats]
  );

  const serviceOrders = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const [cat, svcs] of servicesByCategory) {
      result[cat] = mergeSvcOrder(state.servicePriority?.[cat], svcs.map(s => s.name));
    }
    return result;
  }, [state.servicePriority, servicesByCategory]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(cat: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = active.id as string;
    const overId = over.id as string;

    // Category drag — push new category order through setPriority. The Provider
    // dispatches SET_PRIORITY locally (immediate UI update) and upserts to Supabase;
    // other devices receive the change via the system_state realtime channel.
    if (categoryOrder.includes(activeId)) {
      const next = arrayMove(categoryOrder, categoryOrder.indexOf(activeId), categoryOrder.indexOf(overId));
      void setPriority({ categoryPriority: next });
      return;
    }

    // Service drag — find which category owns both items, then push the merged map.
    for (const cat of categoryOrder) {
      const order = serviceOrders[cat] ?? [];
      if (order.includes(activeId) && order.includes(overId)) {
        const next = arrayMove(order, order.indexOf(activeId), order.indexOf(overId));
        const updated = { ...(state.servicePriority || {}), ...serviceOrders, [cat]: next };
        void setPriority({ servicePriority: updated });
        return;
      }
    }
  }

  return (
    <div className="space-y-2">
      <p className="font-mono text-[11px] text-gray-400 pb-1">
        Drag categories and services to set priority order. Used when assigning clients with multiple services.
      </p>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        {/* Category-level SortableContext */}
        <SortableContext items={categoryOrder} strategy={verticalListSortingStrategy}>
          {categoryOrder.map((cat, idx) => {
            const svcs = servicesByCategory.get(cat) ?? [];
            const svcOrder = serviceOrders[cat] ?? svcs.map(s => s.name);
            const ordered = svcOrder
              .map(n => svcs.find(s => s.name === n))
              .filter((s): s is SalonService => !!s);

            return (
              <SortableCategoryRow
                key={cat}
                category={cat}
                rank={idx + 1}
                serviceCount={svcs.length}
                isExpanded={expanded.has(cat)}
                onToggle={() => toggleExpanded(cat)}
              >
                {expanded.has(cat) && (
                  /* Service-level SortableContext, nested inside the single DndContext */
                  <SortableContext items={svcOrder} strategy={verticalListSortingStrategy}>
                    <div className="px-3 pb-3 space-y-1.5">
                      {ordered.map((svc, svcIdx) => (
                        <SortableServiceRow key={svc.id} svc={svc} rank={svcIdx + 1} />
                      ))}
                    </div>
                  </SortableContext>
                )}
              </SortableCategoryRow>
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
