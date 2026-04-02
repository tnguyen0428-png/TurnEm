import { useState, useMemo } from 'react';
import { Plus, Pencil, Trash2, Sparkles, Search, X, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import Badge from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import ServiceModal from '../modals/ServiceModal';
import { SERVICE_CATEGORIES } from '../../constants/services';

function getTurnBadgeVariant(value: number): 'green' | 'blue' | 'amber' {
  if (value <= 0.5) return 'green';
  if (value <= 1.0) return 'blue';
  return 'amber';
}

const CATEGORY_ICONS: Record<string, string> = {
  'All': '',
  'Acrylics': 'bg-rose-50 text-rose-500',
  'Healthy Nails': 'bg-emerald-50 text-emerald-500',
  'Manicure & Pedicure': 'bg-sky-50 text-sky-500',
  'Combo': 'bg-amber-50 text-amber-500',
  'A La Carte & Add-Ons': 'bg-teal-50 text-teal-500',
  'Kids Services': 'bg-pink-50 text-pink-500',
  'Wax Services': 'bg-orange-50 text-orange-500',
};

const TAB_COLORS: Record<string, { active: string; inactive: string }> = {
  'All': { active: 'bg-gray-900 text-white', inactive: 'bg-white text-gray-600 hover:bg-gray-50' },
  'Acrylics': { active: 'bg-rose-500 text-white', inactive: 'bg-white text-rose-600 hover:bg-rose-50' },
  'Healthy Nails': { active: 'bg-emerald-500 text-white', inactive: 'bg-white text-emerald-600 hover:bg-emerald-50' },
  'Manicure & Pedicure': { active: 'bg-sky-500 text-white', inactive: 'bg-white text-sky-600 hover:bg-sky-50' },
  'Combo': { active: 'bg-amber-500 text-white', inactive: 'bg-white text-amber-600 hover:bg-amber-50' },
  'A La Carte & Add-Ons': { active: 'bg-teal-500 text-white', inactive: 'bg-white text-teal-600 hover:bg-teal-50' },
  'Kids Services': { active: 'bg-pink-500 text-white', inactive: 'bg-white text-pink-600 hover:bg-pink-50' },
  'Wax Services': { active: 'bg-orange-500 text-white', inactive: 'bg-white text-orange-600 hover:bg-orange-50' },
};

export default function ServicesScreen() {
  const { state, dispatch } = useApp();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState<'add' | 'edit' | null>(null);
  const [activeCategory, setActiveCategory] = useState('All');
  const [search, setSearch] = useState('');

  const sorted = useMemo(
    () => [...state.salonServices].sort((a, b) => a.sortOrder - b.sortOrder),
    [state.salonServices]
  );

  const categories = useMemo(() => {
    const cats = new Set(sorted.map(s => s.category).filter(Boolean));
    return ['All', ...SERVICE_CATEGORIES.filter(c => cats.has(c))];
  }, [sorted]);

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
    return SERVICE_CATEGORIES
      .filter(c => map.has(c))
      .map(c => ({ category: c, services: map.get(c)! }));
  }, [filtered, activeCategory]);

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
        <button
          onClick={() => setShowModal('add')}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-pink-500 text-white font-mono text-xs font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all shadow-sm"
        >
          <Plus size={14} />
          ADD SERVICE
        </button>
      </div>

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

      <div className="mb-6 -mx-4 px-4 overflow-x-auto scrollbar-hide">
        <div className="flex gap-2 pb-1">
          {categories.map(cat => {
            const isActive = activeCategory === cat;
            const colors = TAB_COLORS[cat] || TAB_COLORS['All'];
            const count = categoryCounts[cat] || 0;

            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full font-mono text-[11px] font-semibold whitespace-nowrap border transition-all duration-200 ${
                  isActive
                    ? `${colors.active} border-transparent shadow-sm`
                    : `${colors.inactive} border-gray-200`
                }`}
              >
                {cat === 'All' ? 'All' : cat}
                <span className={`ml-0.5 text-[10px] ${isActive ? 'opacity-80' : 'opacity-50'}`}>
                  {count}
                </span>
              </button>
            );
          })}
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
          {grouped.map(group => (
            <div key={group.category}>
              {activeCategory === 'All' && (
                <div className="flex items-center gap-3 mb-3">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${CATEGORY_ICONS[group.category] || 'bg-gray-50 text-gray-500'}`}>
                    <Sparkles size={13} />
                  </div>
                  <h3 className="font-mono text-[11px] text-gray-500 font-semibold tracking-wider uppercase">
                    {group.category}
                  </h3>
                  <div className="flex-1 h-px bg-gray-100" />
                  <span className="font-mono text-[10px] text-gray-300">{group.services.length}</span>
                </div>
              )}

              <div className="grid gap-2">
                {group.services.map((svc, idx) => (
                  <div
                    key={svc.id}
                    className="bg-white rounded-xl border border-gray-100 p-4 transition-all duration-200 hover:shadow-md hover:border-gray-200"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="flex flex-col gap-0.5 flex-shrink-0">
                          <button
                            onClick={() => handleMoveUp(svc.id)}
                            disabled={idx === 0}
                            className={`p-0.5 rounded transition-colors ${
                              idx === 0
                                ? 'text-gray-200 cursor-not-allowed'
                                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                            }`}
                          >
                            <ChevronUp size={14} />
                          </button>
                          <GripVertical size={12} className="text-gray-200 mx-auto" />
                          <button
                            onClick={() => handleMoveDown(svc.id)}
                            disabled={idx === group.services.length - 1}
                            className={`p-0.5 rounded transition-colors ${
                              idx === group.services.length - 1
                                ? 'text-gray-200 cursor-not-allowed'
                                : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                            }`}
                          >
                            <ChevronDown size={14} />
                          </button>
                        </div>
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          CATEGORY_ICONS[svc.category] || 'bg-gray-50 text-gray-500'
                        }`}>
                          <Sparkles size={14} />
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-mono text-sm font-semibold text-gray-900 truncate mb-0.5">
                            {svc.name}
                          </h4>
                          <div className="flex items-center gap-2 flex-wrap">
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
                          onClick={() =>
                            dispatch({
                              type: 'UPDATE_SALON_SERVICE',
                              id: svc.id,
                              updates: { isFourthPositionSpecial: !svc.isFourthPositionSpecial },
                            })
                          }
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
                          onClick={() => {
                            dispatch({ type: 'SET_EDITING_SERVICE', serviceId: svc.id });
                            setShowModal('edit');
                          }}
                          className="p-2 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-600 transition-colors"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => setDeleteId(svc.id)}
                          className="p-2 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteId && (
        <ConfirmDialog
          message="Delete this service? This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            dispatch({ type: 'DELETE_SALON_SERVICE', id: deleteId });
            setDeleteId(null);
          }}
          onCancel={() => setDeleteId(null)}
        />
      )}

      {showModal === 'add' && (
        <ServiceModal mode="add" onClose={() => setShowModal(null)} />
      )}
      {showModal === 'edit' && (
        <ServiceModal mode="edit" onClose={() => { setShowModal(null); dispatch({ type: 'SET_EDITING_SERVICE', serviceId: null }); }} />
      )}
    </div>
  );
}
