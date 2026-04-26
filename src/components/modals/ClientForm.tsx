import { useState, useMemo } from 'react';
import { CalendarCheck, ChevronDown, ChevronUp, X } from 'lucide-react';
import { SERVICE_CATEGORIES } from '../../constants/services';
import type { SalonService, ServiceType, Manicurist, ServiceRequest } from '../../types';

interface SelectedService {
  serviceId: string;
  serviceName: string;
  turnValue: number;
  requestedManicuristIds: string[];
}

export interface ClientFormData {
  clientName: string;
  isAppointment: boolean;
  services: ServiceType[];
  serviceRequests: ServiceRequest[];
  turnValue: number;
}

interface ClientFormProps {
  initialName?: string;
  initialIsAppointment?: boolean;
  initialSelectedServices?: SelectedService[];
  salonServices: SalonService[];
  manicurists: Manicurist[];
  submitLabel: string;
  onSubmit: (data: ClientFormData) => void;
}

export default function ClientForm({
  initialName = '',
  initialIsAppointment = false,
  initialSelectedServices,
  salonServices,
  manicurists,
  submitLabel,
  onSubmit,
}: ClientFormProps) {
  const [clientName, setClientName] = useState(initialName);
  const [isAppointment, setIsAppointment] = useState(initialIsAppointment);
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>(
    () => initialSelectedServices || []
  );
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const clockedInStaff = manicurists.filter((m) => m.clockedIn);

  const sorted = useMemo(
    () => [...salonServices].filter((s) => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [salonServices]
  );

  const availableCategories = useMemo(() => {
    const cats = new Set(sorted.map((s) => s.category).filter(Boolean));
    return SERVICE_CATEGORIES.filter((c) => cats.has(c));
  }, [sorted]);

  const servicesInCategory = useMemo(() => {
    if (!selectedCategory) return [];
    return sorted.filter((s) => s.category === selectedCategory);
  }, [sorted, selectedCategory]);

  const totalTurnValue = selectedServices.reduce((sum, s) => {
    if (s.requestedManicuristIds.length > 0 && s.turnValue > 0) {
      const svc = salonServices.find((sv) => sv.name === s.serviceName);
      return sum + (svc?.category === 'Combo' ? 1 : 0.5);
    }
    return sum + s.turnValue;
  }, 0);

  function handleRemoveService(index: number) {
    setSelectedServices((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) {
      setExpandedIndex(expandedIndex - 1);
    }
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
    const turnValue = totalTurnValue;

    // Build serviceRequests by flattening each instance's requested manicurists
    // into a positional array. Do NOT dedupe: if a client picks the same
    // manicurist (e.g. Christina) for multiple instances of the same service
    // (e.g. 3 Gel Pedicures), each instance must contribute its own entry so
    // getDistinctServices can map every instance back to its requested
    // manicurist. Deduping here would only let the first instance get the
    // request and silently drop the rest.
    const requestMap = new Map<string, string[]>();
    for (const s of selectedServices) {
      if (s.requestedManicuristIds.length > 0) {
        const existing = requestMap.get(s.serviceName) || [];
        for (const id of s.requestedManicuristIds) {
          existing.push(id);
        }
        requestMap.set(s.serviceName, existing);
      }
    }

    const serviceRequests: ServiceRequest[] = Array.from(requestMap.entries()).map(
      ([service, ids]) => ({
        service: service as ServiceType,
        manicuristIds: ids,
        // Walk-in form: anything the receptionist explicitly assigns here is
        // a real customer request. Mark it so downstream UI (REQ badge in
        // QueueCard, REQUESTED in assign modal) treats it as such.
        clientRequest: true,
      })
    );

    onSubmit({
      clientName: clientName.trim() || 'Walk-in',
      isAppointment,
      services,
      serviceRequests,
      turnValue,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
          CLIENT NAME
        </label>
        <input
          type="text"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          placeholder="Walk-in"
          className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
        />
      </div>

      <div
        className={`flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all duration-150 cursor-pointer ${
          isAppointment ? 'border-blue-400 bg-blue-50' : 'border-gray-100 bg-white'
        }`}
        onClick={() => setIsAppointment(!isAppointment)}
      >
        <div className="flex items-center gap-2.5">
          <CalendarCheck size={16} className={isAppointment ? 'text-blue-500' : 'text-gray-400'} />
          <span className={`font-mono text-xs font-semibold ${isAppointment ? 'text-blue-700' : 'text-gray-600'}`}>
            APPOINTMENT
          </span>
        </div>
        <div
          className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
            isAppointment ? 'bg-blue-500' : 'bg-gray-200'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
              isAppointment ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider">
            ADD SERVICES
          </label>
          {selectedServices.length > 0 && (
            <span className="font-mono text-[11px] text-gray-400">
              {totalTurnValue.toFixed(1)} turns total
            </span>
          )}
        </div>

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
              onChange={(e) => {
                const svc = sorted.find((s) => s.id === e.target.value);
                if (!svc) return;
                setSelectedServices((prev) => [
                  ...prev,
                  {
                    serviceId: svc.id,
                    serviceName: svc.name,
                    turnValue: svc.turnValue,
                    requestedManicuristIds: [],
                  },
                ]);
                setSelectedServiceId('');
                setSelectedCategory('');
              }}
              disabled={!selectedCategory}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
            >
              <option value="">Service...</option>
              {servicesInCategory.map((svc) => (
                <option key={svc.id} value={svc.id}>
                  {svc.name} ({svc.turnValue} turn{svc.turnValue !== 1 ? 's' : ''})
                </option>
              ))}
            </select>
          </div>
        </div>

        {selectedServices.length === 0 ? (
          <div className="text-center py-6 border-2 border-dashed border-gray-200 rounded-xl">
            <p className="font-mono text-xs text-gray-400">No services added yet</p>
            <p className="font-mono text-[10px] text-gray-300 mt-1">
              Select a category and service above
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {selectedServices.map((s, idx) => {
              const isExpanded = expandedIndex === idx;
              const assignedIds = s.requestedManicuristIds;
              const skilledStaff = clockedInStaff.filter((m) =>
                m.skills.includes(s.serviceName)
              );

              return (
                <div key={idx}>
                  <div
                    className="flex items-center justify-between px-3.5 py-3 rounded-xl border-2 border-pink-300 bg-pink-50 shadow-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-xs font-semibold text-pink-700">
                          {s.serviceName}
                        </p>
                        <span className="font-mono text-[10px] text-pink-400">
                          {s.turnValue} turn{s.turnValue !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {assignedIds.length > 0 && !isExpanded && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {assignedIds.map((id) => {
                            const m = manicurists.find((x) => x.id === id);
                            return m ? (
                              <span
                                key={id}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-pink-100 font-mono text-[10px] text-pink-700"
                              >
                                <span
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ backgroundColor: m.color }}
                                />
                                {m.name}
                              </span>
                            ) : null;
                          })}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                      <button
                        type="button"
                        onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                        className="p-1.5 rounded-lg text-pink-400 hover:text-pink-600 hover:bg-pink-100 transition-colors"
                        title="Request manicurist"
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveService(idx)}
                        className="p-1.5 rounded-lg text-pink-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-1 px-3 py-2.5 rounded-xl border border-gray-200 bg-white">
                      <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider mb-2">
                        REQUEST MANICURIST <span className="text-gray-300 font-normal">(optional)</span>
                      </p>
                      {skilledStaff.length === 0 ? (
                        <p className="font-mono text-[10px] text-gray-400">
                          No staff with this skill clocked in
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {skilledStaff.map((m) => {
                            const isSelected = assignedIds.includes(m.id);
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
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={selectedServices.length === 0}
        className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
      >
        {submitLabel}{' '}
        {selectedServices.length > 0 &&
          `(${selectedServices.length} service${selectedServices.length > 1 ? 's' : ''})`}
      </button>
    </form>
  );
}
