import { useState, useEffect, useMemo } from 'react';
import { Sparkles } from 'lucide-react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import { STAFF_COLORS, SERVICE_CATEGORIES } from '../../constants/services';
import type { Manicurist } from '../../types';

interface StaffModalProps {
  mode: 'add' | 'edit';
}

export default function StaffModal({ mode }: StaffModalProps) {
  const { state, dispatch } = useApp();

  const editingStaff = mode === 'edit'
    ? state.manicurists.find((m) => m.id === state.editingStaffId)
    : null;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [color, setColor] = useState(STAFF_COLORS[0]);
  const [skills, setSkills] = useState<string[]>([]);
  const [timeAdjustments, setTimeAdjustments] = useState<Record<string, number>>({});
  const [pinCode, setPinCode] = useState('');
  const [isReceptionist, setIsReceptionist] = useState(false);

  const sortedServices = useMemo(
    () => [...state.salonServices].sort((a, b) => a.sortOrder - b.sortOrder),
    [state.salonServices]
  );

  const groupedServices = useMemo(() => {
    const map = new Map<string, typeof sortedServices>();
    sortedServices.forEach(s => {
      const cat = s.category || 'Other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    });
    return SERVICE_CATEGORIES
      .filter(c => map.has(c))
      .map(c => ({ category: c, services: map.get(c)! }));
  }, [sortedServices]);

  useEffect(() => {
    if (editingStaff) {
      setName(editingStaff.name);
      setPhone(editingStaff.phone || '');
      setColor(editingStaff.color);
      setSkills([...editingStaff.skills]);
      setTimeAdjustments({ ...(editingStaff.timeAdjustments || {}) });
      setPinCode(editingStaff.pinCode || '');
      setIsReceptionist(editingStaff.isReceptionist ?? false);
    }
  }, [editingStaff]);

  function toggleSkill(serviceName: string) {
    setSkills((prev) =>
      prev.includes(serviceName)
        ? prev.filter((s) => s !== serviceName)
        : [...prev, serviceName]
    );
  }

  function toggleCategory(category: string) {
    const group = groupedServices.find(g => g.category === category);
    if (!group) return;
    const names = group.services.map(s => s.name);
    const allIn = names.every(n => skills.includes(n));
    if (allIn) {
      setSkills(prev => prev.filter(s => !names.includes(s)));
    } else {
      setSkills(prev => [...new Set([...prev, ...names])]);
    }
  }

  function getCategoryState(category: string): 'all' | 'some' | 'none' {
    const group = groupedServices.find(g => g.category === category);
    if (!group) return 'none';
    const names = group.services.map(s => s.name);
    const count = names.filter(n => skills.includes(n)).length;
    if (count === names.length) return 'all';
    if (count > 0) return 'some';
    return 'none';
  }

  function selectAll() {
    setSkills(sortedServices.map(s => s.name));
  }

  function clearAll() {
    setSkills([]);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!isReceptionist && skills.length === 0) return;

    if (mode === 'edit' && editingStaff) {
      dispatch({
        type: 'UPDATE_MANICURIST',
        id: editingStaff.id,
        updates: {
          name: name.trim(), phone: phone.trim(), color,
          skills: isReceptionist ? [] : skills,
          timeAdjustments, pinCode: pinCode.trim(),
          isReceptionist, showInBook: !isReceptionist,
        },
      });
    } else {
      const newManicurist: Manicurist = {
        id: crypto.randomUUID(),
        name: name.trim(),
        color,
        phone: phone.trim(),
        skills: isReceptionist ? [] : skills,
        clockedIn: false,
        clockInTime: null,
        totalTurns: 0,
        currentClient: null,
        status: 'available',
        hasFourthPositionSpecial: false,
        hasCheck2: false,
        hasCheck3: false,
        hasWax: false,
        hasWax2: false,
        hasWax3: false,
        timeAdjustments,
        pinCode: pinCode.trim(),
        breakStartTime: null,
        smsOptIn: false,
        isReceptionist,
        showInBook: !isReceptionist,
      };
      dispatch({ type: 'ADD_MANICURIST', manicurist: newManicurist });
    }

    dispatch({ type: 'SET_MODAL', modal: null });
    dispatch({ type: 'SET_EDITING_STAFF', staffId: null });
  }

  function handleClose() {
    dispatch({ type: 'SET_MODAL', modal: null });
    dispatch({ type: 'SET_EDITING_STAFF', staffId: null });
  }

  const allSelected = skills.length === sortedServices.length;

  return (
    <Modal
      title={mode === 'edit' ? 'EDIT STAFF' : 'ADD STAFF'}
      onClose={handleClose}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            NAME
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter name..."
            required
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
          />
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            PHONE NUMBER
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 (555) 123-4567"
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
          />
          <p className="font-mono text-[10px] text-gray-400 mt-1">
            Used for SMS turn alerts when assigned a client
          </p>
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            STAFF PIN
          </label>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={pinCode}
            onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))}
            placeholder="4-6 digit PIN"
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
          />
          <p className="font-mono text-[10px] text-gray-400 mt-1">
            Used to log into the staff portal at turnem.io?mode=staff
          </p>
        </div>

        {/* Receptionist toggle */}
        <div
          onClick={() => setIsReceptionist((r) => !r)}
          className={`flex items-center justify-between px-4 py-3 rounded-xl border-2 cursor-pointer transition-all ${
            isReceptionist ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <div>
            <p className={`font-mono text-sm font-semibold ${isReceptionist ? 'text-indigo-700' : 'text-gray-700'}`}>
              Receptionist
            </p>
            <p className="font-mono text-[10px] text-gray-400 mt-0.5">
              No services needed — can book appointments &amp; has security access
            </p>
          </div>
          <div className={`w-10 h-6 rounded-full transition-all relative flex-shrink-0 ml-4 ${isReceptionist ? 'bg-indigo-500' : 'bg-gray-200'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${isReceptionist ? 'left-4' : 'left-0.5'}`} />
          </div>
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-2">
            COLOR
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {STAFF_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-7 h-7 rounded-lg transition-all duration-150 ${
                  color === c
                    ? 'ring-2 ring-offset-2 ring-gray-400 scale-110'
                    : 'hover:scale-105'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {!isReceptionist && <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider">
              SERVICES
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={allSelected ? clearAll : selectAll}
                className="font-mono text-[10px] font-semibold text-pink-500 hover:text-pink-600 transition-colors"
              >
                {allSelected ? 'CLEAR ALL' : 'SELECT ALL'}
              </button>
            </div>
          </div>
          <p className="font-mono text-[10px] text-gray-400 mb-3">
            {skills.length} of {sortedServices.length} selected
          </p>

          {sortedServices.length === 0 ? (
            <div className="text-center py-6">
              <Sparkles size={24} className="mx-auto text-gray-300 mb-2" />
              <p className="font-mono text-xs text-gray-400">No services configured yet</p>
              <p className="font-mono text-[10px] text-gray-300 mt-1">Add services in the Services tab first</p>
            </div>
          ) : (
            <div className="space-y-4 max-h-[280px] overflow-y-auto pr-1">
              {groupedServices.map(group => {
                const catState = getCategoryState(group.category);
                return (
                <div key={group.category}>
                  <div
                    className="flex items-center gap-2 mb-1.5 cursor-pointer group/cat"
                    onClick={() => toggleCategory(group.category)}
                  >
                    <div
                      className={`w-4 h-4 rounded flex items-center justify-center border-2 transition-all flex-shrink-0 ${
                        catState === 'all'
                          ? 'border-pink-500 bg-pink-500'
                          : catState === 'some'
                            ? 'border-pink-300 bg-pink-200'
                            : 'border-gray-300 group-hover/cat:border-gray-400'
                      }`}
                    >
                      {catState === 'all' && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      {catState === 'some' && (
                        <div className="w-2 h-0.5 bg-pink-500 rounded-full" />
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider uppercase group-hover/cat:text-gray-500 transition-colors">
                      {group.category}
                    </span>
                    <div className="flex-1 h-px bg-gray-100" />
                    <span className="font-mono text-[9px] text-gray-300">
                      {group.services.filter(s => skills.includes(s.name)).length}/{group.services.length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {group.services.map((svc) => (
                      <label
                        key={svc.id}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 cursor-pointer transition-all duration-150 ${
                          skills.includes(svc.name)
                            ? 'border-pink-300 bg-pink-50/50'
                            : 'border-gray-100 hover:border-gray-200'
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all flex-shrink-0 ${
                            skills.includes(svc.name)
                              ? 'border-pink-500 bg-pink-500'
                              : 'border-gray-300'
                          }`}
                        >
                          {skills.includes(svc.name) && (
                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <input
                          type="checkbox"
                          checked={skills.includes(svc.name)}
                          onChange={() => toggleSkill(svc.name)}
                          className="sr-only"
                        />
                        <div className="flex items-center justify-between flex-1 min-w-0">
                          <span className="font-mono text-sm text-gray-700 truncate">{svc.name}</span>
                          <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                            {skills.includes(svc.name) && (
                              <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setTimeAdjustments(prev => ({
                                      ...prev,
                                      [svc.name]: (prev[svc.name] || 0) - 5,
                                    }));
                                  }}
                                  className="w-5 h-5 flex items-center justify-center rounded bg-gray-100 hover:bg-gray-200 font-mono text-xs font-bold text-gray-600 transition-colors"
                                >
                                  -
                                </button>
                                <span className={`font-mono text-[10px] font-semibold w-10 text-center tabular-nums ${
                                  (timeAdjustments[svc.name] || 0) > 0 ? 'text-red-500' :
                                  (timeAdjustments[svc.name] || 0) < 0 ? 'text-emerald-500' : 'text-gray-400'
                                }`}>
                                  {(timeAdjustments[svc.name] || 0) > 0 ? '+' : ''}{timeAdjustments[svc.name] || 0}m
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setTimeAdjustments(prev => ({
                                          ...prev,
                                      [svc.name]: (prev[svc.name] || 0) + 5,
                                    }));
                                  }}
                                  className="w-5 h-5 flex items-center justify-center rounded bg-gray-100 hover:bg-gray-200 font-mono text-xs font-bold text-gray-600 transition-colors"
                                >
                                  +
                                </button>
                              </div>
                            )}
                            <span className="font-mono text-[10px] text-gray-400">
                              {svc.duration + (timeAdjustments[svc.name] || 0)}m
                            </span>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>}

        <button
          type="submit"
          disabled={!name.trim() || (!isReceptionist && skills.length === 0)}
          className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {mode === 'edit' ? 'SAVE CHANGES' : 'ADD STAFF'}
        </button>
      </form>
    </Modal>
  );
}
