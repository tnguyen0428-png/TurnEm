import { useState, useEffect, useMemo } from 'react';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import { SERVICE_CATEGORIES } from '../../constants/services';
import { getTodayLA } from '../../utils/time';
import type { ServiceType, ServiceRequest, Appointment } from '../../types';

interface AppointmentModalProps {
  mode: 'add' | 'edit';
}

interface SelectedService {
  serviceId: string;
  serviceName: string;
  turnValue: number;
  requestedManicuristIds: string[];
}

export default function AppointmentModal({ mode }: AppointmentModalProps) {
  const { state, dispatch } = useApp();

  const editing = mode === 'edit'
    ? state.appointments.find((a) => a.id === state.editingAppointmentId)
    : null;

  const today = getTodayLA();
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('10:00');
  const [notes, setNotes] = useState('');

  const sortedServices = useMemo(
    () => [...state.salonServices].filter((s) => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
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

  const allStaffSorted = useMemo(
    () => [...state.manicurists].sort((a, b) => a.name.localeCompare(b.name)),
    [state.manicurists]
  );

  useEffect(() => {
    if (editing) {
      setClientName(editing.clientName);
      setClientPhone(editing.clientPhone);
      setDate(editing.date);
      setTime(editing.time);
      setNotes(editing.notes);

      const svcs = editing.services?.length ? editing.services : [editing.service];
      const restored: SelectedService[] = svcs.map((svcName) => {
        const svc = state.salonServices.find((s) => s.name === svcName);
        const req = (editing.serviceRequests || []).find((r) => r.service === svcName);
        return {
          serviceId: svc?.id || svcName,
          serviceName: svcName,
          turnValue: svc?.turnValue ?? 1,
          requestedManicuristIds: req?.manicuristIds || [],
        };
      });
      setSelectedServices(restored);
    }
  }, [editing]);

  function handleAddService() {
    const svc = sortedServices.find((s) => s.id === selectedServiceId);
    if (!svc) return;
    setSelectedServices((prev) => [
      ...prev,
      { serviceId: svc.id, serviceName: svc.name, turnValue: svc.turnValue, requestedManicuristIds: [] },
    ]);
    setSelectedServiceId('');
    setSelectedCategory('');
  }

  function handleRemoveService(index: number) {
    setSelectedServices((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
  }

  function toggleManicurist(index: number, manicuristId: string) {
    setSelectedServices((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const has = s.requestedManicuristIds.includes(manicuristId);
        return {
          ...s,
          requestedManicuristIds: has
            ? s.requestedManicuristIds.filter((id) => id !== manicuristId)
            : [...s.requestedManicuristIds, manicuristId],
        };
      })
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedServices.length === 0) return;

    const services = selectedServices.map((s) => s.serviceName as ServiceType);
    const serviceRequests: ServiceRequest[] = selectedServices
      .filter((s) => s.requestedManicuristIds.length > 0)
      .map((s) => ({ service: s.serviceName as ServiceType, manicuristIds: s.requestedManicuristIds }));
    const firstRequestedId = serviceRequests[0]?.manicuristIds?.[0] ?? null;
    const name = clientName.trim() || 'Walk-in';

    if (mode === 'edit' && editing) {
      dispatch({
        type: 'UPDATE_APPOINTMENT',
        id: editing.id,
        updates: {
          clientName: name,
          clientPhone: clientPhone.trim(),
          service: services[0],
          services,
          serviceRequests,
          manicuristId: firstRequestedId,
          date,
          time,
          notes: notes.trim(),
        },
      });
    } else {
      const appt: Appointment = {
        id: crypto.randomUUID(),
        clientName: name,
        clientPhone: clientPhone.trim(),
        service: services[0],
        services,
        serviceRequests,
        manicuristId: firstRequestedId,
        date,
        time,
        notes: notes.trim(),
        status: 'scheduled',
        createdAt: Date.now(),
      };
      dispatch({ type: 'ADD_APPOINTMENT', appointment: appt });
    }

    handleClose();
  }

  function handleClose() {
    dispatch({ type: 'SET_MODAL', modal: null });
    dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: null });
  }

  return (
    <Modal
      title={mode === 'edit' ? 'EDIT APPOINTMENT' : 'NEW APPOINTMENT'}
      onClose={handleClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">

        {/* Client info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">CLIENT NAME</label>
            <input
              type="text"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Walk-in"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">PHONE</label>
            <input
              type="tel"
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
              placeholder="(555) 123-4567"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        {/* Services */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider">SERVICES</label>
          </div>

          <div className="flex gap-2 mb-3">
            <div className="flex-1">
              <select
                value={selectedCategory}
                onChange={(e) => { setSelectedCategory(e.target.value); setSelectedServiceId(''); }}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer"
              >
                <option value="">Category...</option>
                {availableCategories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <select
                value={selectedServiceId}
                onChange={(e) => setSelectedServiceId(e.target.value)}
                disabled={!selectedCategory}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                <option value="">Service...</option>
                {servicesInCategory.map((svc) => (
                  <option key={svc.id} value={svc.id}>{svc.name}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={handleAddService}
              disabled={!selectedServiceId}
              className="px-3 py-2.5 rounded-xl bg-pink-500 text-white font-mono text-xs font-semibold hover:bg-pink-600 disabled:bg-gray-100 disabled:text-gray-300 disabled:cursor-not-allowed transition-all"
            >
              Add
            </button>
          </div>

          {selectedServices.length === 0 ? (
            <div className="text-center py-6 border-2 border-dashed border-gray-200 rounded-xl">
              <p className="font-mono text-xs text-gray-400">No services added yet</p>
              <p className="font-mono text-[10px] text-gray-300 mt-1">Select a category and service above</p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedServices.map((s, idx) => {
                const isExpanded = expandedIndex === idx;
                const skilledStaff = allStaffSorted.filter((m) => m.skills.includes(s.serviceName));
                const displayStaff = skilledStaff.length > 0 ? skilledStaff : allStaffSorted;

                return (
                  <div key={idx}>
                    <div className="flex items-center justify-between px-3.5 py-3 rounded-xl border-2 border-pink-300 bg-pink-50 shadow-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-mono text-xs font-semibold text-pink-700">{s.serviceName}</p>
                          {s.requestedManicuristIds.length > 0 && (
                            <span className="font-mono text-[10px] text-pink-500">
                              → {s.requestedManicuristIds.map((id) => state.manicurists.find((m) => m.id === id)?.name).filter(Boolean).join(', ')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                          className="p-1 rounded hover:bg-pink-100 transition-colors"
                        >
                          {isExpanded ? <ChevronUp size={14} className="text-pink-500" /> : <ChevronDown size={14} className="text-pink-500" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveService(idx)}
                          className="p-1 rounded hover:bg-pink-100 transition-colors"
                        >
                          <X size={14} className="text-pink-400" />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-1 px-3 py-2.5 rounded-xl border border-gray-200 bg-white">
                        <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider mb-2">REQUEST MANICURIST (OPTIONAL)</p>
                        <div className="flex flex-wrap gap-1.5">
                          {displayStaff.map((m) => {
                            const isSelected = s.requestedManicuristIds.includes(m.id);
                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => toggleManicurist(idx, m.id)}
                                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[10px] font-semibold transition-all ${
                                  isSelected ? 'bg-pink-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                              >
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                                {m.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Date & Time */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">DATE</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">TIME</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">NOTES</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any special requests..."
            rows={2}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all resize-none"
          />
        </div>

        <button
          type="submit"
          disabled={selectedServices.length === 0}
          className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {mode === 'edit' ? 'SAVE CHANGES' : 'BOOK APPOINTMENT'}
        </button>
      </form>
    </Modal>
  );
}
