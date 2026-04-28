import { useMemo, useState } from 'react';
import { Ban, RotateCcw, X } from 'lucide-react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import { SERVICE_CATEGORIES } from '../../constants/services';
import type { CompletedEntry, ServiceType } from '../../types';

interface Props {
  entry: CompletedEntry;
  onClose: () => void;
}

export default function EditCompletedModal({ entry, onClose }: Props) {
  const { state, dispatch } = useApp();
  const [manicuristId, setManicuristId] = useState(entry.manicuristId);
  const [turnValue, setTurnValue] = useState(String(entry.turnValue));
  const [services, setServices] = useState<ServiceType[]>(entry.services);
  const [requestedServices, setRequestedServices] = useState<ServiceType[]>(
    entry.requestedServices ?? []
  );
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedServiceId, setSelectedServiceId] = useState('');

  // All manicurists (clocked-in or not) so a user can fix a misattribution
  // even if the original tech has since clocked out.
  const manicuristOptions = useMemo(
    () => [...state.manicurists].sort((a, b) => a.name.localeCompare(b.name)),
    [state.manicurists]
  );

  const sortedServices = useMemo(
    () =>
      [...state.salonServices]
        .filter((s) => s.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [state.salonServices]
  );

  const availableCategories = useMemo(() => {
    const cats = new Set(sortedServices.map((s) => s.category).filter(Boolean));
    return SERVICE_CATEGORIES.filter((c) => cats.has(c));
  }, [sortedServices]);

  const servicesInCategory = useMemo(() => {
    if (!selectedCategory) return [];
    return sortedServices.filter((s) => s.category === selectedCategory);
  }, [sortedServices, selectedCategory]);

  // Suggested turn value derived from the salon-service config for the
  // currently selected services. Shown as a small "use suggested" link.
  const suggestedTurnValue = useMemo(() => {
    let total = 0;
    for (const name of services) {
      const s = state.salonServices.find((x) => x.name === name);
      if (s) total += s.turnValue;
    }
    return total;
  }, [services, state.salonServices]);

  function handleAddService(svcId: string) {
    const svc = sortedServices.find((s) => s.id === svcId);
    if (!svc) return;
    setServices((prev) => [...prev, svc.name]);
    setSelectedServiceId('');
    setSelectedCategory('');
  }

  function handleRemoveServiceAt(idx: number) {
    setServices((prev) => {
      const removed = prev[idx];
      const next = prev.filter((_, i) => i !== idx);
      // If this was the last instance of `removed`, drop it from requested too.
      if (!next.includes(removed)) {
        setRequestedServices((r) => r.filter((s) => s !== removed));
      }
      return next;
    });
  }

  function toggleRequestedAt(idx: number) {
    const name = services[idx];
    if (!name) return;
    setRequestedServices((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    );
  }

  function handleSave() {
    const parsed = parseFloat(turnValue);
    const safeTurn = Number.isFinite(parsed) && parsed >= 0 ? parsed : entry.turnValue;
    const m = state.manicurists.find((x) => x.id === manicuristId);
    const cleanedRequested = requestedServices.filter((s) => services.includes(s));
    dispatch({
      type: 'UPDATE_COMPLETED',
      id: entry.id,
      updates: {
        manicuristId,
        manicuristName: m?.name ?? entry.manicuristName,
        manicuristColor: m?.color ?? entry.manicuristColor,
        turnValue: safeTurn,
        services,
        requestedServices: cleanedRequested.length > 0 ? cleanedRequested : undefined,
        isRequested: cleanedRequested.length > 0,
      },
    });
    onClose();
  }

  function handleToggleVoid() {
    dispatch({ type: 'TOGGLE_VOID_COMPLETED', id: entry.id });
    onClose();
  }

  return (
    <Modal title={entry.voided ? 'EDIT SERVICE (VOIDED)' : 'EDIT SERVICE'} onClose={onClose} width="max-w-lg">
      <div className="flex flex-col gap-4">
        {/* Client (read-only) */}
        <div>
          <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
            Client
          </label>
          <p className="font-mono text-sm font-bold text-gray-900 mt-1">{entry.clientName}</p>
        </div>

        {/* Services — Category dropdown + Service dropdown, then a list of added rows */}
        <div>
          <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase block mb-2">
            Services
          </label>

          <div className="flex gap-2 mb-3">
            <div className="flex-1">
              <select
                value={selectedCategory}
                onChange={(e) => {
                  setSelectedCategory(e.target.value);
                  setSelectedServiceId('');
                }}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer"
              >
                <option value="">Category...</option>
                {availableCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <select
                value={selectedServiceId}
                onChange={(e) => handleAddService(e.target.value)}
                disabled={!selectedCategory}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                <option value="">Select service...</option>
                {servicesInCategory.map((svc) => (
                  <option key={svc.id} value={svc.id}>
                    {svc.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {services.length === 0 ? (
            <div className="text-center py-6 border-2 border-dashed border-gray-200 rounded-xl">
              <p className="font-mono text-xs text-gray-400">No services on this entry</p>
              <p className="font-mono text-[10px] text-gray-300 mt-1">Select a category and service above</p>
            </div>
          ) : (
            <div className="space-y-2">
              {services.map((name, idx) => {
                const isReq = requestedServices.includes(name);
                return (
                  <div
                    key={`${name}-${idx}`}
                    className="flex items-center justify-between px-3.5 py-2.5 rounded-xl border-2 border-pink-300 bg-pink-50"
                  >
                    <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                      <p className="font-mono text-xs font-semibold text-pink-700">{name}</p>
                      {isReq && (
                        <span className="px-1.5 py-0.5 rounded-md font-mono text-[8px] font-bold bg-red-500 text-white leading-none tracking-wide">
                          REQ
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleRequestedAt(idx)}
                        title={isReq ? 'Unmark as requested' : 'Mark as requested'}
                        className={`px-2 py-1 rounded-md font-mono text-[10px] font-bold border transition-colors ${
                          isReq
                            ? 'bg-red-500 text-white border-red-500 hover:bg-red-600'
                            : 'bg-white text-gray-400 border-gray-200 hover:border-red-300 hover:text-red-500'
                        }`}
                      >
                        R
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveServiceAt(idx)}
                        className="p-1 rounded hover:bg-pink-100 transition-colors"
                      >
                        <X size={14} className="text-pink-400" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Manicurist */}
        <div>
          <label
            htmlFor="edit-completed-manicurist"
            className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase block mb-1"
          >
            Manicurist
          </label>
          <select
            id="edit-completed-manicurist"
            value={manicuristId}
            onChange={(e) => setManicuristId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-xs font-semibold text-gray-700 bg-white focus:outline-none focus:border-gray-400"
          >
            {manicuristOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        {/* Turn value */}
        <div>
          <label
            htmlFor="edit-completed-turns"
            className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase block mb-1"
          >
            Turn Value
            {suggestedTurnValue !== parseFloat(turnValue) && (
              <button
                type="button"
                onClick={() => setTurnValue(String(suggestedTurnValue))}
                className="ml-2 normal-case font-normal text-gray-400 hover:text-pink-500 underline decoration-dotted"
              >
                use suggested ({suggestedTurnValue})
              </button>
            )}
          </label>
          <input
            id="edit-completed-turns"
            type="number"
            step="0.5"
            min="0"
            value={turnValue}
            onChange={(e) => setTurnValue(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-xs font-semibold text-gray-700 bg-white focus:outline-none focus:border-gray-400"
          />
        </div>

        {/* Footer: void/un-void + hard delete + cancel/save */}
        <div className="flex flex-wrap items-center gap-2 justify-between pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleVoid}
              type="button"
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border-2 font-mono text-[10px] font-bold transition-colors ${
                entry.voided
                  ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'
                  : 'border-amber-200 text-amber-600 hover:bg-amber-50'
              }`}
            >
              {entry.voided ? <RotateCcw size={12} /> : <Ban size={12} />}
              {entry.voided ? 'UN-VOID' : 'VOID'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50 transition-colors"
            >
              CANCEL
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 transition-colors"
            >
              SAVE
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
