import { useState, useMemo } from 'react';
import { Clock, MessageSquare, Check, CheckCircle } from 'lucide-react';
import Modal from '../shared/Modal';
import Badge from '../shared/Badge';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import { getEligibleManicurists, getSuggestedManicurist, isFourthPositionSpecialService } from '../../utils/priority';
import { formatTime } from '../../utils/time';
import { sendTurnAlert } from '../../utils/sms';
import { showSmsToast } from '../shared/SmsToast';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import type { QueueEntry, SalonService, ServiceType, Manicurist } from '../../types';

function ServiceHistory({ m }: { m: Manicurist }) {
  const checks = [m.hasFourthPositionSpecial, m.hasCheck2, m.hasCheck3].filter(Boolean).length;
  const waxes = [m.hasWax, m.hasWax2, m.hasWax3].filter(Boolean).length;
  if (checks === 0 && waxes === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: checks }).map((_, i) => (
        <CheckCircle key={`c${i}`} size={11} className="text-red-400" />
      ))}
      {waxes > 0 && (
        <span className="font-mono text-[10px] font-bold text-amber-400">
          {'W'.repeat(waxes)}
        </span>
      )}
    </div>
  );
}

function formatServiceList(services: string[]): string {
  const map = new Map<string, number>();
  for (const s of services) map.set(s, (map.get(s) || 0) + 1);
  return Array.from(map.entries())
    .map(([s, count]) => (count > 1 ? `${s} x${count}` : s))
    .join(' + ');
}

function getDistinctServices(
  client: QueueEntry,
  salonServices: SalonService[]
): { service: ServiceType; index: number; requestedId: string | null }[] {
  const orderMap = new Map(salonServices.map((s) => [s.name, s.sortOrder]));
  const sorted = [...client.services].sort(
    (a, b) => (orderMap.get(a) ?? Infinity) - (orderMap.get(b) ?? Infinity)
  );

  const result: { service: ServiceType; index: number; requestedId: string | null }[] = [];
  const serviceCountMap = new Map<string, number>();
  const requestedManicuristUsage = new Map<string, number>();

  for (const s of sorted) {
    const idx = serviceCountMap.get(s) ?? 0;
    serviceCountMap.set(s, idx + 1);

    const req = (client.serviceRequests || []).find((r) => r.service === s);

    if (req && req.manicuristIds && req.manicuristIds.length > 0) {
      const usageKey = req.manicuristIds.join(',');
      const usageCount = requestedManicuristUsage.get(usageKey) ?? 0;

      if (usageCount < req.manicuristIds.length) {
        const requestedId = req.manicuristIds[usageCount];
        result.push({ service: s, index: idx, requestedId });
        requestedManicuristUsage.set(usageKey, usageCount + 1);
      } else {
        result.push({ service: s, index: idx, requestedId: null });
      }
    } else {
      result.push({ service: s, index: idx, requestedId: null });
    }
  }
  return result;
}

function getEligibleForService(service: ServiceType, manicurists: Manicurist[]): Manicurist[] {
  return manicurists
    .filter((m) => m.clockedIn && m.status === 'available')
    .filter((m) => m.skills.includes(service))
    .sort((a, b) => {
      if (a.totalTurns !== b.totalTurns) return a.totalTurns - b.totalTurns;
      const aTime = a.clockInTime ?? Infinity;
      const bTime = b.clockInTime ?? Infinity;
      return aTime - bTime;
    });
}

function getSuggestedForService(service: ServiceType, manicurists: Manicurist[], salonServices: SalonService[], excludeIds: Set<string> = new Set()): Manicurist | null {
  const eligible = getEligibleForService(service, manicurists).filter((m) => !excludeIds.has(m.id));
  if (eligible.length === 0) return null;
  const svc = salonServices.find((s) => s.name === service);
  if (svc?.isFourthPositionSpecial) {
    return eligible[3] ?? eligible[eligible.length - 1];
  }
  return eligible[0];
}

export default function AssignModal() {
  const { state, dispatch } = useApp();

  const client = state.queue.find((c) => c.id === state.selectedClient);
  const hasMultipleServices = client ? client.services.length > 1 : false;

  if (!client) return null;

  if (hasMultipleServices) {
    return <MultiServiceAssign client={client} />;
  }

  return <SingleServiceAssign client={client} />;
}

function SingleServiceAssign({ client }: { client: QueueEntry }) {
  const { state, dispatch } = useApp();
  const [confirmAssignment, setConfirmAssignment] = useState<{
    clientId: string;
    manicuristId: string;
    clientName: string;
    manicuristName: string;
    service: string;
  } | null>(null);

  const requestedIds = new Set(
    (client.serviceRequests || []).flatMap((r) => r.manicuristIds || [])
  );

  const is4thSpecial = isFourthPositionSpecialService(client.services, state.salonServices);

  const eligible = getEligibleManicurists(client.services, state.manicurists, state.salonServices);

  const requestedNotEligible = state.manicurists.filter(
    (m) => requestedIds.has(m.id) && !eligible.find((e) => e.id === m.id) && m.clockedIn && m.status === 'available'
  );

  const allEligible = [...eligible, ...requestedNotEligible].sort((a, b) => {
    const aReq = requestedIds.has(a.id) ? 0 : 1;
    const bReq = requestedIds.has(b.id) ? 0 : 1;
    if (aReq !== bReq) return aReq - bReq;
    if (a.totalTurns !== b.totalTurns) return a.totalTurns - b.totalTurns;
    const aTime = a.clockInTime ?? Infinity;
    const bTime = b.clockInTime ?? Infinity;
    return aTime - bTime;
  });

  const suggestedId = getSuggestedManicurist(client.services, state.manicurists, state.salonServices)?.id ?? null;

  function handleSelect(manicuristId: string) {
    const manicurist = state.manicurists.find((m) => m.id === manicuristId);
    if (!manicurist) return;
    setConfirmAssignment({
      clientId: client.id,
      manicuristId,
      clientName: client.clientName,
      manicuristName: manicurist.name,
      service: formatServiceList(client.services),
    });
  }

  function handleConfirm() {
    if (!confirmAssignment) return;
    dispatch({
      type: 'ASSIGN_CLIENT',
      clientId: confirmAssignment.clientId,
      manicuristId: confirmAssignment.manicuristId,
    });

    const manicurist = state.manicurists.find((m) => m.id === confirmAssignment.manicuristId);
    if (manicurist?.phone) {
      showSmsToast('sending');
      sendTurnAlert(
        manicurist.phone,
        manicurist.name,
        confirmAssignment.clientName,
        confirmAssignment.service
      ).then((result) => {
        showSmsToast(result.success ? 'sent' : 'failed');
      });
    } else {
      showSmsToast('no-phone');
    }
    setConfirmAssignment(null);
  }

  return (
    <>
      <Modal
        title="ASSIGN CLIENT"
        onClose={() => {
          dispatch({ type: 'SET_SELECTED_CLIENT', clientId: null });
          dispatch({ type: 'SET_MODAL', modal: null });
        }}
        width="max-w-xl"
      >
        <div className="mb-5 p-4 bg-gray-50 rounded-xl">
          <p className="font-mono text-sm font-semibold text-gray-900">{client.clientName}</p>
          <p className="font-mono text-xs text-gray-500 mt-1">
            {formatServiceList(client.services)} ({client.turnValue} turns)
          </p>
        </div>

        {allEligible.length === 0 ? (
          <div className="text-center py-8">
            <p className="font-mono text-sm text-gray-400">No eligible staff available</p>
            <p className="font-mono text-xs text-gray-300 mt-1">
              Check that staff are clocked in with the right skills
            </p>
            <button
              onClick={() => {
                dispatch({ type: 'SET_SELECTED_CLIENT', clientId: null });
                dispatch({ type: 'SET_MODAL', modal: null });
              }}
              className="mt-4 px-6 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 font-mono text-sm text-gray-600 transition-colors"
            >
              Keep in Queue
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {allEligible.map((m, idx) => (
              <button
                key={m.id}
                onClick={() => handleSelect(m.id)}
                className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-200 hover:shadow-md ${
                  requestedIds.has(m.id)
                    ? 'border-pink-300 bg-pink-50/50 hover:border-pink-400'
                    : m.id === suggestedId
                      ? 'border-emerald-300 bg-emerald-50/50 hover:border-emerald-400'
                      : 'border-gray-100 bg-white hover:border-pink-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-gray-400 w-6">#{idx + 1}</span>
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: m.color }} />
                    <span className="font-mono text-sm font-semibold text-gray-900">{m.name}</span>
                    <ServiceHistory m={m} />
                    {requestedIds.has(m.id) && <Badge label="REQUESTED" variant="pink" />}
                    {m.id === suggestedId && is4thSpecial && <Badge label="4TH POSITION" variant="amber" />}
                    {m.id === suggestedId && !is4thSpecial && <Badge label="RECOMMENDED" variant="green" />}
                  </div>
                  <div className="flex items-center gap-4">
                    {m.phone && (
                      <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-500" title="SMS alerts enabled">
                        <MessageSquare size={10} />
                        SMS
                      </span>
                    )}
                    <span className="font-mono text-xs text-gray-500">{m.totalTurns.toFixed(1)} turns</span>
                    {m.clockInTime && (
                      <span className="flex items-center gap-1 font-mono text-[10px] text-gray-400">
                        <Clock size={10} />
                        {formatTime(m.clockInTime)}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Modal>

      {confirmAssignment && (
        <ConfirmDialog
          message={`Assign ${confirmAssignment.clientName} to ${confirmAssignment.manicuristName}?`}
          confirmLabel="Assign"
          onConfirm={handleConfirm}
          onCancel={() => setConfirmAssignment(null)}
        />
      )}
    </>
  );
}

function MultiServiceAssign({ client }: { client: QueueEntry }) {
  const { state, dispatch } = useApp();

  const serviceRows = useMemo(() => {
    const rows = getDistinctServices(client, state.salonServices);
    return rows.map((row, idx) => ({ ...row, uniqueKey: `${row.service}-${row.index}-${idx}` }));
  }, [client, state.salonServices]);

  const [assignments, setAssignments] = useState<Record<string, string | null>>(() => {
    const initial: Record<string, string | null> = {};
    for (const row of serviceRows) {
      initial[row.uniqueKey] = row.requestedId;
    }
    return initial;
  });

  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(() => {
    const pre = new Set<string>();
    for (const row of serviceRows) {
      if (row.requestedId) pre.add(row.uniqueKey);
    }
    return pre;
  });

  const [showConfirm, setShowConfirm] = useState(false);

  const assignedManicuristIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of Object.values(assignments)) {
      if (id) ids.add(id);
    }
    return ids;
  }, [assignments]);

  const allAssigned = Object.values(assignments).every((id) => id !== null);

  function getEligibleForRow(service: ServiceType, rowKey: string): (Manicurist & { _takenByOther: boolean; _isSuggested: boolean })[] {
    const skilled = getEligibleForService(service, state.manicurists);
    const takenByOtherIds = new Set(
      Object.entries(assignments)
        .filter(([k, id]) => k !== rowKey && id !== null)
        .map(([, id]) => id as string)
    );
    const suggested = getSuggestedForService(service, state.manicurists, state.salonServices, takenByOtherIds);
    return skilled.map((m) => ({
      ...m,
      _takenByOther: assignedManicuristIds.has(m.id) && assignments[rowKey] !== m.id,
      _isSuggested: suggested?.id === m.id,
    }));
  }

  function handlePickManicurist(rowKey: string, manicuristId: string) {
    setAssignments((prev) => ({ ...prev, [rowKey]: manicuristId }));
    setCollapsedRows((prev) => new Set([...prev, rowKey]));
  }

  function handleClearAssignment(rowKey: string) {
    setAssignments((prev) => ({ ...prev, [rowKey]: null }));
    setCollapsedRows((prev) => { const s = new Set(prev); s.delete(rowKey); return s; });
  }

  function getTurnValueForService(service: ServiceType): number {
    const svc = state.salonServices.find((s) => s.name === service);
    return svc?.turnValue ?? SERVICE_TURN_VALUES[service] ?? 0;
  }

  function handleConfirm() {
    const manicuristGroups = new Map<string, { services: ServiceType[]; turnValue: number }>();
    const waitingServices: ServiceType[] = [];

    for (const row of serviceRows) {
      const key = row.uniqueKey;
      const mId = assignments[key];
      if (mId) {
        if (!manicuristGroups.has(mId)) {
          manicuristGroups.set(mId, { services: [], turnValue: 0 });
        }
        const group = manicuristGroups.get(mId)!;
        group.services.push(row.service);
        const baseTurn = getTurnValueForService(row.service);
        group.turnValue += row.requestedId ? (baseTurn > 0 ? 0.5 : 0) : baseTurn;
      } else {
        waitingServices.push(row.service);
      }
    }

    const entries: { client: QueueEntry; manicuristId: string | null }[] = [];
    const smsTargets: { phone: string; name: string; clientName: string; service: string }[] = [];

    for (const [mId, group] of manicuristGroups) {
      const serviceReqs = group.services.map((s) => ({
        service: s,
        manicuristIds: [mId],
      }));

      const entry: QueueEntry = {
        id: crypto.randomUUID(),
        clientName: client.clientName,
        services: group.services,
        turnValue: group.turnValue,
        serviceRequests: serviceReqs,
        requestedManicuristId: mId,
        isRequested: true,
        isAppointment: client.isAppointment,
        assignedManicuristId: null,
        status: 'waiting',
        arrivedAt: client.arrivedAt,
        startedAt: null,
        completedAt: null,
      };

      entries.push({ client: entry, manicuristId: mId });

      const m = state.manicurists.find((x) => x.id === mId);
      if (m?.phone) {
        smsTargets.push({
          phone: m.phone,
          name: m.name,
          clientName: client.clientName,
          service: formatServiceList(group.services),
        });
      }
    }

    if (waitingServices.length > 0) {
      const turnValue = waitingServices.reduce((sum, s) => sum + getTurnValueForService(s), 0);
      const entry: QueueEntry = {
        id: crypto.randomUUID(),
        clientName: client.clientName,
        services: waitingServices,
        turnValue,
        serviceRequests: [],
        requestedManicuristId: null,
        isRequested: false,
        isAppointment: client.isAppointment,
        assignedManicuristId: null,
        status: 'waiting',
        arrivedAt: Date.now() - 3600000,
        startedAt: null,
        completedAt: null,
      };
      entries.push({ client: entry, manicuristId: null });
    }

    dispatch({ type: 'SPLIT_AND_ASSIGN', originalId: client.id, entries });

    for (const target of smsTargets) {
      showSmsToast('sending');
      sendTurnAlert(target.phone, target.name, target.clientName, target.service).then((result) => {
        showSmsToast(result.success ? 'sent' : 'failed');
      });
    }

    setShowConfirm(false);
  }

  function buildConfirmMessage() {
    const parts: string[] = [];
    const grouped = new Map<string, ServiceType[]>();
    const unassigned: ServiceType[] = [];

    for (const row of serviceRows) {
      const key = row.uniqueKey;
      const mId = assignments[key];
      if (mId) {
        if (!grouped.has(mId)) grouped.set(mId, []);
        grouped.get(mId)!.push(row.service);
      } else {
        unassigned.push(row.service);
      }
    }

    for (const [mId, services] of grouped) {
      const m = state.manicurists.find((x) => x.id === mId);
      parts.push(`${formatServiceList(services)} -> ${m?.name ?? '?'}`);
    }

    if (unassigned.length > 0) {
      parts.push(`${formatServiceList(unassigned)} -> Waiting`);
    }

    return `Assign ${client.clientName}?\n\n${parts.join('\n')}`;
  }

  return (
    <>
      <Modal
        title="ASSIGN CLIENT"
        onClose={() => {
          dispatch({ type: 'SET_SELECTED_CLIENT', clientId: null });
          dispatch({ type: 'SET_MODAL', modal: null });
        }}
        width="max-w-xl"
      >
        <div className="mb-5 p-4 bg-gray-50 rounded-xl">
          <p className="font-mono text-sm font-semibold text-gray-900">{client.clientName}</p>
          <p className="font-mono text-xs text-gray-500 mt-1">
            {formatServiceList(client.services)} ({client.turnValue} turns)
          </p>
          <p className="mt-2 font-mono text-[10px] text-blue-600 font-semibold">
            Pick a staff member for each service below
          </p>
        </div>

        <div className="space-y-4 mb-5">
          {serviceRows.map((row) => {
            const key = row.uniqueKey;
            const selectedId = assignments[key];
            const eligible = getEligibleForRow(row.service, key);
            const requestedId = row.requestedId;
            const rowSvc = state.salonServices.find((s) => s.name === row.service);
            const rowIs4thSpecial = rowSvc?.isFourthPositionSpecial === true;
            const isCollapsed = collapsedRows.has(key) && !!selectedId;
            const selectedManicurist = selectedId ? state.manicurists.find((m) => m.id === selectedId) : null;

            return (
              <div key={key}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge label={row.service} variant="blue" size="md" />
                  {selectedId && (
                    <button
                      onClick={() => handleClearAssignment(key)}
                      className="font-mono text-[10px] text-red-400 hover:text-red-500 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                  {isCollapsed && (
                    <button
                      onClick={() => setCollapsedRows((prev) => { const s = new Set(prev); s.delete(key); return s; })}
                      className="font-mono text-[10px] text-blue-400 hover:text-blue-500 transition-colors"
                    >
                      Change
                    </button>
                  )}
                </div>

                {isCollapsed && selectedManicurist ? (
                  <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 border-emerald-300 bg-emerald-50/50">
                    <Check size={14} className="text-emerald-500 flex-shrink-0" />
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: selectedManicurist.color }} />
                    <span className="font-mono text-sm font-semibold text-gray-900">{selectedManicurist.name}</span>
                    {requestedId === selectedManicurist.id && <Badge label="REQUESTED" variant="pink" />}
                  </div>
                ) : eligible.length === 0 ? (
                  <div className="text-center py-4 bg-gray-50 rounded-xl">
                    <p className="font-mono text-xs text-gray-400">No available staff with this skill</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {eligible.map((m, idx) => {
                      const isSelected = selectedId === m.id;
                      const isRequested = requestedId === m.id;

                      return (
                        <button
                          key={m.id}
                          onClick={() => !m._takenByOther && handlePickManicurist(key, m.id)}
                          disabled={m._takenByOther}
                          className={`w-full text-left p-3 rounded-xl border-2 transition-all duration-200 ${
                            m._takenByOther
                              ? 'opacity-40 cursor-not-allowed border-gray-100 bg-gray-50'
                              : isSelected
                                ? 'border-emerald-300 bg-emerald-50/50 shadow-sm'
                                : isRequested
                                  ? 'border-pink-200 bg-pink-50/30 hover:border-pink-300 hover:shadow-md'
                                  : m._isSuggested
                                    ? 'border-emerald-200 bg-emerald-50/30 hover:border-emerald-300 hover:shadow-md'
                                    : 'border-gray-100 bg-white hover:border-pink-200 hover:shadow-md'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-xs text-gray-400 w-5">#{idx + 1}</span>
                              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: m.color }} />
                              <span className="font-mono text-sm font-semibold text-gray-900">{m.name}</span>
                              <ServiceHistory m={m} />
                              {isSelected && <Check size={14} className="text-emerald-500" />}
                              {isRequested && <Badge label="REQUESTED" variant="pink" />}
                              {m._isSuggested && !isRequested && rowIs4thSpecial && <Badge label="4TH POSITION" variant="amber" />}
                              {m._isSuggested && !isRequested && !rowIs4thSpecial && <Badge label="RECOMMENDED" variant="green" />}
                              {m._takenByOther && (
                                <span className="font-mono text-[9px] text-amber-500">(assigned above)</span>
                              )}
                            </div>
                            <div className="flex items-center gap-4">
                              {m.phone && (
                                <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-500" title="SMS alerts enabled">
                                  <MessageSquare size={10} />
                                  SMS
                                </span>
                              )}
                              <span className="font-mono text-xs text-gray-500">{m.totalTurns.toFixed(1)} turns</span>
                              {m.clockInTime && (
                                <span className="flex items-center gap-1 font-mono text-[10px] text-gray-400">
                                  <Clock size={10} />
                                  {formatTime(m.clockInTime)}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {row !== serviceRows[serviceRows.length - 1] && (
                  <div className="border-b border-gray-100 mt-4" />
                )}
              </div>
            );
          })}
        </div>

        <button
          onClick={() => setShowConfirm(true)}
          disabled={!Object.values(assignments).some((id) => id !== null)}
          className={`w-full py-3 rounded-xl font-mono text-sm font-semibold transition-all duration-150 ${
            Object.values(assignments).some((id) => id !== null)
              ? 'bg-pink-500 text-white hover:bg-pink-600 active:scale-[0.98]'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          {allAssigned ? 'ASSIGN ALL' : 'ASSIGN SELECTED'}
        </button>

        {!allAssigned && Object.values(assignments).some((id) => id !== null) && (
          <p className="text-center mt-2 font-mono text-[10px] text-gray-400">
            Unassigned services will stay in the waiting queue
          </p>
        )}
      </Modal>

      {showConfirm && (
        <ConfirmDialog
          message={buildConfirmMessage()}
          confirmLabel="Assign"
          onConfirm={handleConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );
}
