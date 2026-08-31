import { useState, useMemo, useEffect } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { SERVICE_CATEGORIES } from '../../constants/services';
import { toTitleCase, searchCustomers } from '../../lib/customers';
import CustomerNoteAlert from '../shared/CustomerNoteAlert';
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
  // Pop a customer's saved permanent note the moment the typed name exactly
  // matches an existing profile. Opt-in (only AddClientModal's walk-in
  // check-in passes this) so EditClientModal's flow is unchanged.
  matchCustomerNotes?: boolean;
}

export default function ClientForm({
  initialName = '',
  initialIsAppointment = false,
  initialSelectedServices,
  salonServices,
  manicurists,
  submitLabel,
  onSubmit,
  matchCustomerNotes = false,
}: ClientFormProps) {
  // Split incoming initialName on the first space so an edit of an existing
  // record ("Sarah Klein Doe") puts "Sarah" in First and "Klein Doe" in Last.
  // On submit we re-combine.
  const [clientFirstName, setClientFirstName] = useState(() => {
    const s = (initialName ?? '').trim();
    const i = s.indexOf(' ');
    return i === -1 ? s : s.slice(0, i);
  });
  const [clientLastName, setClientLastName] = useState(() => {
    const s = (initialName ?? '').trim();
    const i = s.indexOf(' ');
    return i === -1 ? '' : s.slice(i + 1).trim();
  });
  // The APPOINTMENT toggle is gone (Tony 2026-08-31): a client added from the
  // queue is never an appointment — real appointments reach the queue from the
  // book, which sets this itself — so the control was dead weight on the one
  // card the front desk fills in most.
  //
  // The VALUE stays and is still submitted. ClientForm is shared with the EDIT
  // modal, which passes the entry's existing flag in; dropping the field here
  // instead of just the control would silently demote a checked-in appointment
  // to a walk-in every time someone edited one.
  const [isAppointment] = useState(initialIsAppointment);
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>(
    () => initialSelectedServices || []
  );
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  // Permanent-note popup for the walk-in check-in flow (see matchCustomerNotes
  // prop). There's no phone field here to disambiguate same-named customers
  // like AppointmentModal does, so this fires on an exact case-insensitive
  // first+last match rather than offering a click-to-pick list — walk-in
  // check-in needs to stay fast while a client is standing at the counter.
  const [noteAlert, setNoteAlert] = useState<{ name: string; note: string } | null>(null);
  const [lastAlertedKey, setLastAlertedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!matchCustomerNotes) return;
    const first = clientFirstName.trim();
    const last = clientLastName.trim();
    if (!first || !last) return;
    const key = `${first.toLowerCase()}|${last.toLowerCase()}`;
    if (key === lastAlertedKey) return; // already alerted (or checked) for this exact name
    let cancelled = false;
    const handle = setTimeout(async () => {
      const rows = await searchCustomers({ first, last }, 5);
      if (cancelled) return;
      setLastAlertedKey(key);
      const match = rows.find(
        (r) => r.firstName.toLowerCase() === first.toLowerCase() && r.lastName.toLowerCase() === last.toLowerCase(),
      );
      const stored = (match?.notes ?? '').trim();
      if (match && stored) {
        setNoteAlert({ name: `${match.firstName} ${match.lastName}`.trim(), note: stored });
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [matchCustomerNotes, clientFirstName, clientLastName, lastAlertedKey]);

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

    const combinedName = `${clientFirstName.trim()} ${clientLastName.trim()}`.trim() || 'Walk-in';
    onSubmit({
      clientName: combinedName,
      isAppointment,
      services,
      serviceRequests,
      turnValue,
    });
  }

  return (
    <>
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block font-mono text-[16px] text-gray-500 font-semibold tracking-wider mb-1.5">
            FIRST NAME
          </label>
          <input
            type="text"
            value={clientFirstName}
            onChange={(e) => setClientFirstName(e.target.value)}
            onBlur={(e) => setClientFirstName(toTitleCase(e.target.value))}
            placeholder="First"
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-[19px] text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
          />
        </div>
        <div>
          <label className="block font-mono text-[16px] text-gray-500 font-semibold tracking-wider mb-1.5">
            LAST NAME
          </label>
          <input
            type="text"
            value={clientLastName}
            onChange={(e) => setClientLastName(e.target.value)}
            onBlur={(e) => setClientLastName(toTitleCase(e.target.value))}
            placeholder="Last"
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-[19px] text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block font-mono text-[16px] text-gray-500 font-semibold tracking-wider">
            ADD SERVICES
          </label>
          {selectedServices.length > 0 && (
            <span className="font-mono text-[16px] text-gray-400">
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
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-[17px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer"
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
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-[17px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
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
            <p className="font-mono text-[17px] text-gray-400">No services added yet</p>
            <p className="font-mono text-[15px] text-gray-300 mt-1">
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
                        <p className="font-mono text-[17px] font-semibold text-pink-700">
                          {s.serviceName}
                        </p>
                        <span className="font-mono text-[15px] text-pink-400">
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
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-pink-100 font-mono text-[15px] text-pink-700"
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
                      <p className="font-mono text-[15px] text-gray-400 font-semibold tracking-wider mb-2">
                        REQUEST MANICURIST <span className="text-gray-300 font-normal">(optional)</span>
                      </p>
                      {skilledStaff.length === 0 ? (
                        <p className="font-mono text-[15px] text-gray-400">
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
                                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[15px] font-semibold transition-all ${
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
        className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-[19px] font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
      >
        {submitLabel}{' '}
        {selectedServices.length > 0 &&
          `(${selectedServices.length} service${selectedServices.length > 1 ? 's' : ''})`}
      </button>
    </form>
    {noteAlert && (
      <CustomerNoteAlert
        name={noteAlert.name}
        note={noteAlert.note}
        onDismiss={() => setNoteAlert(null)}
      />
    )}
    </>
  );
}
