import { useState, useMemo, useEffect, type CSSProperties } from 'react';
import { Plus, Pencil, Trash2, Sparkles, Search, X, ChevronUp, ChevronDown, ChevronRight, GripVertical, Tags, RotateCcw } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { supabase } from '../../lib/supabase';
import Badge, { getTurnBadgeVariant } from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import ServiceModal from '../modals/ServiceModal';
import CategoryManagerModal from '../modals/CategoryManagerModal';
import { paletteFor } from '../../constants/categoryPalette';
import { useServiceCategories } from '../../hooks/useServiceCategories';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import PriorityListView from './PriorityListView';
import type { SalonService } from '../../types';

// 'All' isn't a real category, so it keeps its own fixed styling.
const ALL_TAB_COLORS = { active: 'bg-gray-900 text-white', inactive: 'bg-white text-gray-600 hover:bg-gray-50' };

// Tab order used to be saved per device under this key; it now lives in the
// shared service_categories.sort_order, so the old value is just cleared.
const LEGACY_ORDER_KEY = 'turnem_category_order';

interface SortableTabProps {
  cat: string;
  isActive: boolean;
  colors: { active: string; inactive: string };
  count: number;
  onClick: () => void;
}

function SortableTab({ cat, isActive, colors, count, onClick }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: cat });
  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      style={{
        padding: '10px 20px',
        fontSize: '15px',
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`flex items-center gap-1.5 rounded-full font-mono font-semibold whitespace-nowrap border transition-all duration-200 ${
        isActive
          ? `${colors.active} border-transparent shadow-sm`
          : `${colors.inactive} border-gray-200`
      }`}
      {...attributes}
      {...listeners}
    >
      {cat}
      <span className={`ml-0.5 text-[10px] ${isActive ? 'opacity-80' : 'opacity-50'}`}>
        {count}
      </span>
    </button>
  );
}

interface SortableServiceRowProps {
  svc: SalonService;
  idx: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleFourth: () => void;
  onRestore: () => void;
  iconClass: string;
}

function SortableServiceRow({
  svc,
  idx,
  total,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
  onToggleFourth,
  onRestore,
  iconClass,
}: SortableServiceRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: svc.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 'auto',
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white rounded-xl border border-gray-100 p-4 transition-all duration-200 hover:shadow-md hover:border-gray-200 ${
        svc.isActive ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="flex flex-col gap-0.5 flex-shrink-0">
            <button
              onClick={onMoveUp}
              disabled={idx === 0}
              className={`p-0.5 rounded transition-colors ${
                idx === 0
                  ? 'text-gray-200 cursor-not-allowed'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
              }`}
            >
              <ChevronUp size={14} />
            </button>
            <button
              {...attributes}
              {...listeners}
              title="Drag to reorder"
              className="cursor-grab active:cursor-grabbing p-0.5 rounded text-gray-300 hover:text-gray-500 hover:bg-gray-100 touch-none"
            >
              <GripVertical size={12} className="mx-auto" />
            </button>
            <button
              onClick={onMoveDown}
              disabled={idx === total - 1}
              className={`p-0.5 rounded transition-colors ${
                idx === total - 1
                  ? 'text-gray-200 cursor-not-allowed'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
              }`}
            >
              <ChevronDown size={14} />
            </button>
          </div>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${iconClass}`}>
            <Sparkles size={14} />
          </div>
          <div className="min-w-0">
            <h4 className="font-mono text-sm font-semibold text-gray-900 truncate mb-0.5">
              {svc.name}
            </h4>
            <div className="flex items-center gap-2 flex-wrap">
              {!svc.isActive && (
                <span
                  title="Hidden from pickers; kept because it's on past tickets"
                  className="px-1.5 py-0.5 rounded bg-gray-100 font-mono text-[10px] font-semibold text-gray-500"
                >
                  HIDDEN
                </span>
              )}
              <Badge label={`${svc.turnValue} turn`} variant={getTurnBadgeVariant(svc.turnValue)} />
              <span className="font-mono text-[11px] text-gray-400">{svc.duration} min</span>
              <span className="font-mono text-[11px] font-semibold text-gray-600">
                ${svc.price.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <button
            onClick={onToggleFourth}
            title="Mark as 4th position special"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border font-mono text-[10px] font-semibold transition-all duration-200 ${
              svc.isFourthPositionSpecial
                ? 'bg-purple-100 border-purple-300 text-purple-700'
                : 'bg-white border-gray-200 text-gray-400 hover:border-purple-300 hover:text-purple-500'
            }`}
          >
            <span
              className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                svc.isFourthPositionSpecial
                  ? 'bg-purple-500 border-purple-500'
                  : 'border-gray-300'
              }`}
            >
              {svc.isFourthPositionSpecial && (
                <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                  <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            #4
          </button>
          <button
            onClick={onEdit}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-600 transition-colors"
          >
            <Pencil size={14} />
          </button>
          {svc.isActive ? (
            <button
              onClick={onDelete}
              className="p-2 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          ) : (
            <button
              onClick={onRestore}
              title="Restore — show in pickers again"
              className="p-2 rounded-lg hover:bg-emerald-50 text-gray-300 hover:text-emerald-600 transition-colors"
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ServicesScreen() {
  const { state, dispatch } = useApp();
  const { categories, categoryNames } = useServiceCategories();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState<'add' | 'edit' | null>(null);
  // Tracked by id so the selected tab survives a rename; a deleted category
  // falls back to 'All'.
  const [activeCategoryId, setActiveCategoryId] = useState('All');
  const [showCategories, setShowCategories] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'services' | 'priority'>('services');

  const sorted = useMemo(
    () => [...state.salonServices].sort((a, b) => a.sortOrder - b.sortOrder),
    [state.salonServices]
  );

  const activeCategory = categories.find(c => c.id === activeCategoryId)?.name ?? 'All';
  const setActiveCategory = (name: string) => setActiveCategoryId(categories.find(c => c.name === name)?.id ?? 'All');

  useEffect(() => {
    try { localStorage.removeItem(LEGACY_ORDER_KEY); } catch { /* nothing to clear */ }
  }, []);
  const colorByCategory = useMemo(() => new Map(categories.map(c => [c.name, c.color])), [categories]);
  const iconClassFor = (category: string) => paletteFor(colorByCategory.get(category)).icon;
  const tabColorsFor = (category: string) => {
    if (!colorByCategory.has(category)) return ALL_TAB_COLORS;
    const p = paletteFor(colorByCategory.get(category));
    return { active: p.tabActive, inactive: p.tabInactive };
  };
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = categories.findIndex(c => c.name === active.id);
      const newIndex = categories.findIndex(c => c.name === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      dispatch({ type: 'REORDER_SERVICE_CATEGORY', ids: arrayMove(categories, oldIndex, newIndex).map(c => c.id) });
    }
  }

  function handleServiceDragEnd(event: DragEndEvent, group: { category: string; services: SalonService[] }) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = group.services.findIndex((s) => s.id === active.id);
    const newIndex = group.services.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(group.services, oldIndex, newIndex);
    dispatch({
      type: 'SET_SALON_SERVICE_ORDER',
      ids: reordered.map((s) => s.id),
    });
  }

  function toggleCollapse(cat: string) {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { All: sorted.length };
    sorted.forEach(s => {
      if (s.category) {
        counts[s.category] = (counts[s.category] || 0) + 1;
      }
    });
    return counts;
  }, [sorted]);

  const filtered = useMemo(() => {
    let services = sorted;

    if (activeCategory !== 'All') {
      services = services.filter(s => s.category === activeCategory);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      services = services.filter(s => s.name.toLowerCase().includes(q));
    }

    return services;
  }, [sorted, activeCategory, search]);

  const grouped = useMemo(() => {
    if (activeCategory !== 'All') {
      return [{ category: activeCategory, services: filtered }];
    }
    const map = new Map<string, typeof filtered>();
    filtered.forEach(s => {
      const cat = s.category || 'Other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    });
    return categoryNames
      .filter(c => map.has(c))
      .map(c => ({ category: c, services: map.get(c)! }));
  }, [filtered, activeCategory, categoryNames]);

  // Deleting a service nulls ticket_items.service_id on every past line, and
  // the voided-ticket guard rejects that — so a service with any ticket history
  // is hidden (isActive false) instead. If the check itself fails, hide too:
  // that's always safe and reversible.
  async function deleteOrHideService(id: string) {
    const { count, error } = await supabase
      .from('ticket_items')
      .select('id', { count: 'exact', head: true })
      .eq('service_id', id);
    if (error || (count ?? 0) > 0) {
      dispatch({ type: 'UPDATE_SALON_SERVICE', id, updates: { isActive: false } });
    } else {
      dispatch({ type: 'DELETE_SALON_SERVICE', id });
    }
  }

  function handleMoveUp(id: string) {
    dispatch({ type: 'REORDER_SALON_SERVICE', id, direction: 'up' });
  }

  function handleMoveDown(id: string) {
    dispatch({ type: 'REORDER_SALON_SERVICE', id, direction: 'down' });
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">SERVICES</h2>
          <p className="font-mono text-xs text-gray-400 mt-0.5">
            {sorted.length} services
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCategories(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-gray-200 text-gray-700 font-mono text-xs font-semibold hover:bg-gray-50 active:scale-[0.98] transition-all shadow-sm"
          >
            <Tags size={14} />
            CATEGORIES
          </button>
          <button
            onClick={() => setShowModal('add')}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-pink-500 text-white font-mono text-xs font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all shadow-sm"
          >
            <Plus size={14} />
            ADD SERVICE
          </button>
        </div>
      </div>

      <div className="flex gap-1 mb-5 p-1 bg-gray-100 rounded-xl w-fit">
        <button
          onClick={() => setView('services')}
          className={`px-4 py-1.5 rounded-lg font-mono text-xs font-semibold transition-all ${
            view === 'services' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          SERVICES
        </button>
        <button
          onClick={() => setView('priority')}
          className={`px-4 py-1.5 rounded-lg font-mono text-xs font-semibold transition-all ${
            view === 'priority' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          PRIORITY LIST
        </button>
      </div>

      {view === 'priority' && <PriorityListView />}

      {view === 'services' && (
      <>
      <div className="mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search services..."
            className="w-full pl-10 pr-9 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all bg-white"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="mb-6">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '12px 16px' }}>
          {/* All tab — always first, not draggable */}
          <button
            onClick={() => setActiveCategory('All')}
            style={{ padding: '10px 20px', fontSize: '15px' }}
            className={`flex items-center gap-1.5 rounded-full font-mono font-semibold whitespace-nowrap border transition-all duration-200 ${
              activeCategory === 'All'
                ? `${ALL_TAB_COLORS.active} border-transparent shadow-sm`
                : `${ALL_TAB_COLORS.inactive} border-gray-200`
            }`}
          >
            All
            <span className={`ml-0.5 text-[10px] ${activeCategory === 'All' ? 'opacity-80' : 'opacity-50'}`}>
              {categoryCounts['All'] || 0}
            </span>
          </button>

          {/* Draggable category tabs */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={categoryNames} strategy={horizontalListSortingStrategy}>
              {categoryNames.map(cat => (
                <SortableTab
                  key={cat}
                  cat={cat}
                  isActive={activeCategory === cat}
                  colors={tabColorsFor(cat)}
                  count={categoryCounts[cat] || 0}
                  onClick={() => setActiveCategory(cat)}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={48} />}
          title="No services configured"
          description="Add your salon services with turn values and pricing"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search size={48} />}
          title="No services found"
          description={search ? `No results for "${search}"` : 'No services in this category'}
        />
      ) : (
        <div className="space-y-8">
          {grouped.map(group => {
            const isCollapsed = collapsedCategories.has(group.category);
            const canCollapse = activeCategory === 'All';
            return (
              <div key={group.category}>
                {activeCategory === 'All' && (
                  <button
                    type="button"
                    onClick={() => toggleCollapse(group.category)}
                    className="flex items-center gap-3 mb-3 w-full text-left group"
                    title={isCollapsed ? 'Expand' : 'Minimize'}
                  >
                    <span className="text-gray-300 group-hover:text-gray-500 transition-colors flex-shrink-0">
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </span>
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${iconClassFor(group.category)}`}>
                      <Sparkles size={13} />
                    </div>
                    <h3 className="font-mono text-[11px] text-gray-500 font-semibold tracking-wider uppercase">
                      {group.category}
                    </h3>
                    <div className="flex-1 h-px bg-gray-100" />
                    <span className="font-mono text-[10px] text-gray-300">{group.services.length}</span>
                  </button>
                )}

                {(!canCollapse || !isCollapsed) && (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(e) => handleServiceDragEnd(e, group)}
                  >
                    <SortableContext
                      items={group.services.map((s) => s.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="grid gap-2">
                        {group.services.map((svc, idx) => (
                          <SortableServiceRow
                            key={svc.id}
                            svc={svc}
                            idx={idx}
                            total={group.services.length}
                            onMoveUp={() => handleMoveUp(svc.id)}
                            onMoveDown={() => handleMoveDown(svc.id)}
                            onEdit={() => {
                              dispatch({ type: 'SET_EDITING_SERVICE', serviceId: svc.id });
                              setShowModal('edit');
                            }}
                            onDelete={() => setDeleteId(svc.id)}
                            onRestore={() => dispatch({ type: 'UPDATE_SALON_SERVICE', id: svc.id, updates: { isActive: true } })}
                            iconClass={iconClassFor(svc.category)}
                            onToggleFourth={() =>
                              dispatch({
                                type: 'UPDATE_SALON_SERVICE',
                                id: svc.id,
                                updates: { isFourthPositionSpecial: !svc.isFourthPositionSpecial },
                              })
                            }
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            );
          })}
        </div>
      )}
      </>
      )}

      {deleteId && (
        <ConfirmDialog
          message="Delete this service? If it's on past tickets it will be hidden instead, so that history stays intact."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const id = deleteId;
            setDeleteId(null);
            void deleteOrHideService(id);
          }}
          onCancel={() => setDeleteId(null)}
        />
      )}

      {showModal === 'add' && (
        <ServiceModal
          mode="add"
          defaultCategory={activeCategory === 'All' ? undefined : activeCategory}
          onClose={() => setShowModal(null)}
        />
      )}
      {showCategories && <CategoryManagerModal onClose={() => setShowCategories(false)} />}
      {showModal === 'edit' && (
        <ServiceModal mode="edit" onClose={() => { setShowModal(null); dispatch({ type: 'SET_EDITING_SERVICE', serviceId: null }); }} />
      )}
    </div>
  );
}
