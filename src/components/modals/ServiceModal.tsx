import { useState, useEffect, useMemo } from 'react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import type { SalonService } from '../../types';
import { useServiceCategories } from '../../hooks/useServiceCategories';
import { staffSkillUpdates } from '../../utils/serviceCategories';

interface ServiceModalProps {
  mode: 'add' | 'edit';
  onClose: () => void;
  /** Add mode: preselect this category (e.g. the tab the user is on). */
  defaultCategory?: string;
}

export default function ServiceModal({ mode, onClose, defaultCategory }: ServiceModalProps) {
  const { state, dispatch, setPriority } = useApp();
  const { categoryNames } = useServiceCategories();

  // Everyone who can be given services — receptionist-only accounts (no skills)
  // are left out, matching how StaffModal keeps them out of the book.
  const staff = useMemo(
    () => state.manicurists.filter((m) => !(m.isReceptionist && m.skills.length === 0)),
    [state.manicurists],
  );

  const editing = mode === 'edit'
    ? state.salonServices.find((s) => s.id === state.editingServiceId)
    : null;

  const [name, setName] = useState('');
  const [turnValue, setTurnValue] = useState(0);
  const [duration, setDuration] = useState(30);
  const [price, setPrice] = useState(0);
  const [staffIds, setStaffIds] = useState<Set<string>>(new Set());
  const [nameError, setNameError] = useState<string | null>(null);
  const [category, setCategory] = useState(
    defaultCategory && categoryNames.includes(defaultCategory) ? defaultCategory : categoryNames[0] ?? '',
  );

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setTurnValue(editing.turnValue);
      setDuration(editing.duration);
      setPrice(editing.price);
      setCategory(editing.category || categoryNames[0] || '');
      setStaffIds(new Set(state.manicurists.filter((m) => m.skills.includes(editing.name)).map((m) => m.id)));
    }
  // Seed only when the edited service changes; a live category update must not
  // reset what the user has typed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function toggleStaff(id: string) {
    setStaffIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Skills, time adjustments and the service priority list all reference a
  // service by NAME. Apply the staff checkboxes and carry a rename through all
  // three, working from the latest manicurist rows so a concurrent edit to
  // someone's other skills isn't overwritten.
  function applyStaffAndRename(oldName: string | null, newName: string) {
    const listed = new Set(staff.map((m) => m.id));
    for (const u of staffSkillUpdates(state.manicurists, listed, staffIds, oldName, newName)) {
      dispatch({ type: 'UPDATE_MANICURIST', id: u.id, updates: { skills: u.skills, timeAdjustments: u.timeAdjustments } });
    }
    if (oldName && oldName !== newName && state.servicePriority) {
      const lists = Object.entries(state.servicePriority);
      if (lists.some(([, names]) => names.includes(oldName))) {
        void setPriority({
          servicePriority: Object.fromEntries(
            lists.map(([cat, names]) => [cat, names.map((n) => (n === oldName ? newName : n))]),
          ),
        });
      }
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    // Services are looked up by name all over the app, so two with the same
    // name would be ambiguous.
    const lower = name.trim().toLowerCase();
    if (state.salonServices.some((s) => s.id !== editing?.id && s.name.trim().toLowerCase() === lower)) {
      setNameError('A service with this name already exists');
      return;
    }

    if (mode === 'edit' && editing) {
      dispatch({
        type: 'UPDATE_SALON_SERVICE',
        id: editing.id,
        updates: {
          name: name.trim(),
          turnValue,
          duration,
          price,
          category,
        },
      });
      applyStaffAndRename(editing.name, name.trim());
    } else {
      const maxOrder = state.salonServices.reduce((max, s) => Math.max(max, s.sortOrder), -1);
      const svc: SalonService = {
        id: crypto.randomUUID(),
        name: name.trim(),
        turnValue,
        duration,
        price,
        isActive: true,
        category,
        sortOrder: maxOrder + 1,
        isFourthPositionSpecial: false,
      };
      dispatch({ type: 'ADD_SALON_SERVICE', service: svc });
      applyStaffAndRename(null, svc.name);
    }

    onClose();
  }

  return (
    <Modal
      title={mode === 'edit' ? 'EDIT SERVICE' : 'ADD SERVICE'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            SERVICE NAME
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameError(null); }}
            placeholder="e.g. Gel Manicure"
            required
            className={`w-full px-4 py-3 rounded-xl border font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 transition-all ${
              nameError ? 'border-red-300 focus:ring-red-200' : 'border-gray-200 focus:ring-pink-200 focus:border-pink-300'
            }`}
          />
          {nameError && <p className="mt-1 font-mono text-[11px] text-red-500">{nameError}</p>}
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            CATEGORY
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white transition-all"
          >
            {/* A service whose category isn't in the list still gets its own
                option, so saving the form never silently re-categorizes it. */}
            {category && !categoryNames.includes(category) && (
              <option value={category}>{category}</option>
            )}
            {categoryNames.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              TURN VALUE
            </label>
            <select
              value={turnValue}
              onChange={(e) => setTurnValue(Number(e.target.value))}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white transition-all"
            >
              <option value={0}>0</option>
              <option value={0.5}>0.5</option>
              <option value={1.0}>1.0</option>
              <option value={1.5}>1.5</option>
              <option value={2.0}>2.0</option>
              <option value={2.5}>2.5</option>
              <option value={3.0}>3.0</option>
            </select>
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              DURATION (MIN)
            </label>
            <input
              type="number"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              min={5}
              step={5}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              PRICE ($)
            </label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(Number(e.target.value))}
              min={0}
              step={0.01}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider">
              STAFF WHO DO THIS SERVICE ({staffIds.size})
            </label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStaffIds(new Set(staff.map((m) => m.id)))}
                className="font-mono text-[11px] font-semibold text-pink-500 hover:text-pink-600"
              >
                ALL
              </button>
              <button
                type="button"
                onClick={() => setStaffIds(new Set())}
                className="font-mono text-[11px] font-semibold text-gray-400 hover:text-gray-600"
              >
                NONE
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-56 overflow-y-auto p-1 -m-1">
            {staff.map((m) => {
              const on = staffIds.has(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleStaff(m.id)}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border font-mono text-xs text-left transition-all ${
                    on ? 'border-pink-300 bg-pink-50 text-gray-900' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                  }`}
                >
                  <span
                    className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                      on ? 'bg-pink-500 border-pink-500' : 'border-gray-300'
                    }`}
                  >
                    {on && (
                      <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                        <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
                  <span className="truncate">{m.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="submit"
          disabled={!name.trim()}
          className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {mode === 'edit' ? 'SAVE CHANGES' : 'ADD SERVICE'}
        </button>
      </form>
    </Modal>
  );
}
