import { useState, useMemo } from 'react';
import { Clock, MessageSquare, Check, Timer } from 'lucide-react';
import { useCountdown } from '../../hooks/useCountdown';
import Modal from '../shared/Modal';
import Badge from '../shared/Badge';
import CountdownBadge from '../shared/CountdownBadge';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import { formatTime } from '../../utils/time';
import { sendTurnAlert } from '../../utils/sms';
import { showSmsToast } from '../shared/SmsToast';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import type { QueueEntry, ServiceType, Manicurist } from '../../types';
import { isAcrylicService, getSamPreferenceForServices, findSamIfActive, isSam } from '../../utils/salonRules';
import {
  getClientDurationMs,
  formatServiceList,
  getDistinctServices,
  getEligibleForService,
  getSuggestedForService,
  ServiceHistory,
} from './assignHelpers';

export function MultiServiceAssign({ client }: { client: QueueEntry }) {
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
  const [dismissedSamPrompt, setDismissedSamPrompt] = useState(false);

  const sam = getSamPreferenceForServices(state.manicurists, client.services, state.salonServices);
  const showSamPrompt = !!sam && sam.status === 'busy' && !dismissedSamPrompt;
  const samCurrentClient = sam ? state.queue.find(c => c.id === sam.currentClient) ?? null : null;
  const samDurationMs = sam ? getClientDurationMs(sam, state.queue, state.salonServices) : 0;
  const { display: samCountdownDisplay } = useCountdown(samCurrentClient?.startedAt ?? null, samDurationMs);

  function handleWaitForSam() {
    if (!sam) return;
    setAssignments((prev) => {
      const updated = { ...prev };
      for (const row of serviceRows) {
        if (isAcrylicService(row.service, state.salonServices)) {
          updated[row.uniqueKey] = sam.id;
          setCollapsedRows((c) => new Set([...c, row.uniqueKey]));
        }
      }
      return updated;
    });
    setDismissedSamPrompt(true);
  }

  const assignedManicuristIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of Object.values(assignments)) {
      if (id) ids.add(id);
    }
    return ids;
  }, [assignments]);

  const allAssigned = Object.values(assignments).every((id) => id !== null);

  function getEligibleForRow(service: ServiceType, rowKey: string): (Manicurist & { _takenByOther: boolean; _isSuggested: boolean; _isSamPreferred: boolean; _isBusySam: boolean })[] {
    const skilled = getEligibleForService(service, state.manicurists, state.salonServices);
    const takenByOtherIds = new Set(
      Object.entries(assignments)
        .filter(([k, id]) => k !== rowKey && id !== null)
        .map(([, id]) => id as string)
    );
    const suggested = getSuggestedForService(service, state.manicurists, state.salonServices, takenByOtherIds);

    // Do NOT re-query serviceRequests by service name — that would return the same request
    // for every instance of a repeated service, making all rows show the same preferred manicurist.
    const rowData = serviceRows.find(r => r.uniqueKey === rowKey);
    const explicitlyRequestedId = rowData?.requestedId ?? null;

    const rowIsAcrylic = isAcrylicService(service, state.salonServices);
    const samCandidate = rowIsAcrylic && !explicitlyRequestedId
      ? findSamIfActive(state.manicurists)
      : null;
    const samForRow = samCandidate?.skills.includes(service) ? samCandidate : null;

    const preferredId = explicitlyRequestedId ?? samForRow?.id ?? null;
    const preferredManicurist = preferredId
      ? state.manicurists.find(m => m.id === preferredId && m.clockedIn) ?? null
      : null;

    const baseRows = skilled
      .filter(m => !preferredManicurist || m.id !== preferredManicurist.id)
      .map(m => ({
        ...m,
        _takenByOther: assignedManicuristIds.has(m.id) && assignments[rowKey] !== m.id,
        _isSuggested: suggested?.id === m.id,
        _isSamPreferred: false,
        _isBusySam: false,
      }));

    if (!preferredManicurist) return baseRows;

    const preferredRow = {
      ...preferredManicurist,
      _takenByOther: false,
      _isSuggested: false,
      _isSamPreferred: true,
      _isBusySam: preferredManicurist.status === 'busy',
    };

    return [preferredRow, ...baseRows];
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
    const deferredRows: { service: ServiceType; mId: string }[] = [];
    const waitingServices: ServiceType[] = [];

    for (const row of serviceRows) {
      const key = row.uniqueKey;
      const mId = assignments[key];
      if (mId) {
        const m = state.manicurists.find((x) => x.id === mId);
        if (m && m.status === 'available') {
          if (!manicuristGroups.has(mId)) {
            manicuristGroups.set(mId, { services: [], turnValue: 0 });
          }
          const group = manicuristGroups.get(mId)!;
          group.services.push(row.service);
          const baseTurn = getTurnValueForService(row.service);
          group.turnValue += row.requestedId ? (baseTurn > 0 ? 0.5 : 0) : baseTurn;
        } else {
          deferredRows.push({ service: row.service, mId });
        }
      } else {
        waitingServices.push(row.service);
      }
    }

    const entries: { client: QueueEntry; manicuristId: string | null }[] = [];
    const smsTargets: { phone: string; name: string; clientName: string; service: string }[] = [];

    for (const [mId, group] of manicuristGroups) {
      // Only preserve service requests the CLIENT originally made
      const serviceReqs = group.services
        .filter((s) => (client.serviceRequests || []).some((r) => r.service === s && r.manicuristIds.length > 0))
        .map((s) => ({ service: s as ServiceType, manicuristIds: [mId] }));

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

    for (const { service, mId } of deferredRows) {
      const baseTurn = getTurnValueForService(service);
      const entry: QueueEntry = {
        id: crypto.randomUUID(),
        clientName: client.clientName,
        services: [service],
        turnValue: baseTurn > 0 ? 0.5 : 0,
        serviceRequests: [{ service: service as ServiceType, manicuristIds: [mId] }],
        requestedManicuristId: mId,
        isRequested: true,
        isAppointment: client.isAppointment,
        assignedManicuristId: null,
        status: 'waiting',
        arrivedAt: client.arrivedAt,
        startedAt: null,
        completedAt: null,
      };
      entries.push({ client: entry, manicuristId: null });
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
    const assignable = new Map<string, ServiceType[]>();
    const deferred = new Map<string, ServiceType[]>();
    const unassigned: ServiceType[] = [];

    for (const row of serviceRows) {
      const key = row.uniqueKey;
      const mId = assignments[key];
      if (mId) {
        const m = state.manicurists.find((x) => x.id === mId);
        if (m && m.status === 'available') {
          if (!assignable.has(mId)) assignable.set(mId, []);
          assignable.get(mId)!.push(row.service);
        } else {
          if (!deferred.has(mId)) deferred.set(mId, []);
          deferred.get(mId)!.push(row.service);
        }
      } else {
        unassigned.push(row.service);
      }
    }

    for (const [mId, services] of assignable) {
      const m = state.manicurists.find((x) => x.id === mId);
      parts.push(`${formatServiceList(services)} -> ${m?.name ?? '?'}`);
    }
    for (const [mId, services] of deferred) {
      const m = state.manicurists.find((x) => x.id === mId);
      parts.push(`${formatServiceList(services)} -> Waiting for ${m?.name ?? '?'}`);
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
        {(() => {
          const hasBusyAssignment = serviceRows.some((row) => {
            const mId = assignments[row.uniqueKey];
            if (!mId) return false;
            const m = state.manicurists.find((x) => x.id === mId);
            return m && m.status !== 'available';
          });
          return (
            <div className="mb-5 p-4 bg-gray-50 rounded-xl">
              <p className="font-mono text-sm font-semibold text-gray-900">{client.clientName}</p>
              <p className="font-mono text-xs text-gray-500 mt-1">
                {formatServiceList(client.services)} ({client.turnValue} turns)
              </p>
              <p className="mt-2 font-mono text-[10px] text-blue-600 font-semibold">
                Pick a staff member for each service below
              </p>
              {hasBusyAssignment && (
                <p className="mt-2 font-mono text-[10px] text-indigo-600 font-semibold">
                  ⓵ Services requesting busy staff will stay in the waiting queue.
                </p>
              )}
            </div>
          );
        })()}

        {showSamPrompt && (
          <div className="mb-4 p-4 rounded-2xl border-2 border-dashed border-indigo-300 bg-indigo-50">
            <div className="flex items-center gap-2 mb-2">
              <Badge label="PREFERRED" variant="indigo" />
              <span className="font-mono text-xs font-semibold text-indigo-800">Sam is currently busy</span>
            </div>
            <p className="font-mono text-xs text-indigo-700 mb-4">
              Sam has{' '}
              <span className="font-bold tabular-nums">{samCountdownDisplay || '…'}</span>{' '}
              remaining on his current client. Wait for Sam, or assign{' '}
              <span className="font-bold">{client.clientName}</span> to someone else?
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleWaitForSam}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-indigo-500 text-white font-mono text-xs font-semibold hover:bg-indigo-600 active:scale-[0.98] transition-all"
              >
                <Timer size={13} />
                WAIT FOR SAM
              </button>
              <button
                onClick={() => setDismissedSamPrompt(true)}
                className="flex-1 py-2 rounded-xl bg-white border border-gray-200 text-gray-600 font-mono text-xs font-semibold hover:bg-gray-50 active:scale-[0.98] transition-all"
              >
                Assign Someone Else
              </button>
            </div>
          </div>
        )}

        {(() => {
          const deferredItems = serviceRows
            .filter(row => {
              const reqId = (client.serviceRequests || []).find(r => r.service === row.service)?.manicuristIds?.[0];
              if (!reqId) return false;
              const m = state.manicurists.find(x => x.id === reqId);
              return !!m && m.status === 'busy' && !isSam(m);
            })
            .map(row => {
              const reqId = (client.serviceRequests || []).find(r => r.service === row.service)!.manicuristIds[0];
              const m = state.manicurists.find(x => x.id === reqId)!;
              return { service: row.service, manicurist: m };
            });
          if (deferredItems.length === 0) return null;
          return (
            <div className="mb-4 p-4 rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50">
              <div className="flex items-center gap-2 mb-2">
                <Timer size={13} className="text-amber-600" />
                <span className="font-mono text-xs font-semibold text-amber-800">Some staff are currently busy</span>
              </div>
              <div className="space-y-1 mb-2">
                {deferredItems.map(({ service, manicurist }) => (
                  <p key={service} className="font-mono text-xs text-amber-700">
                    <span className="font-bold">{service}</span> → waiting for <span className="font-bold">{manicurist.name}</span> — will go back to queue
                  </p>
                ))}
              </div>
              <p className="font-mono text-[10px] text-amber-600">Assign the remaining services below.</p>
            </div>
          );
        })()}

        <div className={`space-y-4 mb-5 ${showSamPrompt ? 'opacity-50 pointer-events-none' : ''}`}>
          {serviceRows.map((row) => {
            const key = row.uniqueKey;
            const selectedId = assignments[key];
            const eligible = getEligibleForRow(row.service, key);
            const requestedId = row.requestedId;
            const rowSvc = state.salonServices.find((s) => s.name === row.service);
            const rowIs4thSpecial = rowSvc?.isFourthPositionSpecial === true;
            const isCollapsed = collapsedRows.has(key) && !!selectedId;
            const selectedManicurist = selectedId ? state.manicurists.find((m) => m.id === selectedId) : null;
            const isRowDeferred = !!selectedManicurist && selectedManicurist.status === 'busy';

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
                  <div className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 ${
                    isRowDeferred ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50/50'
                  }`}>
                    {isRowDeferred
                      ? <Timer size={14} className="text-amber-500 flex-shrink-0" />
                      : <Check size={14} className="text-emerald-500 flex-shrink-0" />}
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: selectedManicurist.color }} />
                    <span className="font-mono text-sm font-semibold text-gray-900">{selectedManicurist.name}</span>
                    {isRowDeferred
                      ? <span className="font-mono text-[10px] font-bold text-amber-600 uppercase">Waiting in queue</span>
                      : requestedId === selectedManicurist.id && <Badge label="REQUESTED" variant="pink" />}
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
                      const isBusySam = m._isBusySam;
                      const busySamDurationMs = isBusySam
                        ? getClientDurationMs(m, state.queue, state.salonServices)
                        : 0;
                      const busySamClient = isBusySam
                        ? state.queue.find(c => c.id === m.currentClient) ?? null
                        : null;

                      return (
                        <button
                          key={m.id}
                          onClick={() => !m._takenByOther && handlePickManicurist(key, m.id)}
                          disabled={m._takenByOther}
                          style={isBusySam ? { opacity: 0.85 } : undefined}
                          className={`w-full text-left p-3 rounded-xl border-2 transition-all duration-200 ${
                            isBusySam && isSelected
                              ? 'border-amber-300 bg-amber-50/50 shadow-sm'
                              : isBusySam
                              ? 'border-indigo-200 bg-indigo-50/30 hover:border-indigo-300 hover:shadow-md'
                              : m._takenByOther
                              ? 'opacity-40 cursor-not-allowed border-gray-100 bg-gray-50'
                              : isSelected
                                ? 'border-emerald-300 bg-emerald-50/50 shadow-sm'
                                : m._isSamPreferred
                                  ? 'border-indigo-300 bg-indigo-50/50 hover:border-indigo-400 hover:shadow-md'
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
                              {m._isSamPreferred && <Badge label="PREFERRED" variant="indigo" />}
                              {!m._isSamPreferred && isRequested && <Badge label="REQUESTED" variant="pink" />}
                              {!m._isSamPreferred && m._isSuggested && !isRequested && rowIs4thSpecial && <Badge label="4TH POSITION" variant="amber" />}
                              {!m._isSamPreferred && m._isSuggested && !isRequested && !rowIs4thSpecial && <Badge label="RECOMMENDED" variant="green" />}
                              {m._takenByOther && (
                                <span className="font-mono text-[9px] text-amber-500">(assigned above)</span>
                              )}
                            </div>
                            <div className="flex items-center gap-4">
                              {isBusySam && (
                                <CountdownBadge
                                  startedAt={busySamClient?.startedAt ?? null}
                                  totalDurationMs={busySamDurationMs}
                                  status={m.status}
                                />
                              )}
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
