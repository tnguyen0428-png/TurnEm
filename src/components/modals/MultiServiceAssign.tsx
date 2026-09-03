import { useState, useMemo } from 'react';
import { Clock, MessageSquare, Check, Timer } from 'lucide-react';
import Modal from '../shared/Modal';
import Badge from '../shared/Badge';
import CountdownBadge from '../shared/CountdownBadge';
import AssignConfirmDialog from '../shared/AssignConfirmDialog';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import { formatTime } from '../../utils/time';
import { sendTurnAlert } from '../../utils/sms';
import { sendPushNotification } from '../../utils/pushNotifications';
import { showSmsToast } from '../shared/SmsToast';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import type { QueueEntry, ServiceType, Manicurist } from '../../types';
import {
  getClientDurationMs,
  formatServiceList,
  getDistinctServices,
  getEligibleForService,
  getSuggestedForService,
  ServiceHistory,
  getMinsToNextAppt,
  APPT_PILL_WINDOW_MINS,
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

  // Rows the receptionist has explicitly deferred: the tech stays the client's
  // request, but is not assigned in this round. A client having two services
  // back-to-back with different techs (Gel Builder with CHRISTINA now, Pedicure
  // with LEO after) should only tie up CHRISTINA — LEO picks the client up when
  // he's free. Without this, the only way to leave LEO out was "Clear", which
  // drops the request entirely and hands the pedicure to whoever is next.
  //
  // A deferred row takes the same path as a row whose tech is busy: a waiting
  // child that keeps clientRequest/requestedManicuristId and the 0.5 request
  // turn. The difference is that this is a deliberate choice rather than a
  // consequence of the tech's current status.
  const [notNowRows, setNotNowRows] = useState<Set<string>>(new Set());
  const [pendingNotNow, setPendingNotNow] = useState<
    { key: string; manicuristName: string; service: string } | null
  >(null);

  const assignedManicuristIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of Object.values(assignments)) {
      if (id) ids.add(id);
    }
    return ids;
  }, [assignments]);

  // A deferred row has a tech picked but is NOT being assigned this round, so
  // it must not count toward "ASSIGN ALL" or the button lies about what the
  // confirm step is going to do.
  const allAssigned = serviceRows.every(
    (r) => assignments[r.uniqueKey] !== null && !notNowRows.has(r.uniqueKey)
  );

  /** True when this row is going to become a waiting child rather than an
   *  assignment — either the tech is busy, or the receptionist deferred it. */
  function isRowDeferredNow(rowKey: string): boolean {
    if (notNowRows.has(rowKey)) return true;
    const mId = assignments[rowKey];
    if (!mId) return false;
    return state.manicurists.find((x) => x.id === mId)?.status !== 'available';
  }

  function handleNotNow(rowKey: string) {
    setNotNowRows((prev) => new Set([...prev, rowKey]));
    setCollapsedRows((prev) => new Set([...prev, rowKey]));
    setPendingNotNow(null);
  }

  function handleAssignNow(rowKey: string) {
    setNotNowRows((prev) => { const s = new Set(prev); s.delete(rowKey); return s; });
  }

  function getEligibleForRow(service: ServiceType, rowKey: string): (Manicurist & { _takenByOther: boolean; _isSuggested: boolean; _isExplicitlyRequested: boolean; _almostDone: boolean })[] {
    const skilled = getEligibleForService(service, state.manicurists, state.salonServices, state.queue);
    const takenByOtherIds = new Set(
      Object.entries(assignments)
        .filter(([k, id]) => k !== rowKey && id !== null)
        .map(([, id]) => id as string)
    );
    const suggested = getSuggestedForService(service, state.manicurists, state.salonServices, takenByOtherIds, state.queue);

    // Do NOT re-query serviceRequests by service name — that would return the same request
    // for every instance of a repeated service, making all rows show the same preferred manicurist.
    const rowData = serviceRows.find(r => r.uniqueKey === rowKey);
    const explicitlyRequestedId = rowData?.requestedId ?? null;

    const preferredManicurist = explicitlyRequestedId
      ? state.manicurists.find(m => m.id === explicitlyRequestedId && m.clockedIn) ?? null
      : null;

    // If the requested manicurist is already assigned to another row for this client,
    // don't highlight them as preferred — treat them like a normal staff member.
    const preferredTakenByOther = preferredManicurist
      ? assignedManicuristIds.has(preferredManicurist.id) && assignments[rowKey] !== preferredManicurist.id
      : false;
    const effectivePreferred = preferredTakenByOther ? null : preferredManicurist;

    const baseRows = skilled
      .filter(m => !effectivePreferred || m.id !== effectivePreferred.id)
      .map(m => ({
        ...m,
        _takenByOther: assignedManicuristIds.has(m.id) && assignments[rowKey] !== m.id,
        _isSuggested: suggested?.id === m.id,
        _isExplicitlyRequested: false,
        _almostDone: ('_almostDone' in m && !!(m as { _almostDone?: boolean })._almostDone),
      }));

    if (!effectivePreferred) return baseRows;

    const preferredRow = {
      ...effectivePreferred,
      _takenByOther: false,
      _isSuggested: false,
      _isExplicitlyRequested: true,
      _almostDone: false,
    };

    // A specific manicurist is explicitly requested — show only that person
    return [preferredRow];
  }

  // Picking or clearing a tech is an explicit fresh decision about this row, so
  // both drop any earlier "not now" — otherwise a row could silently stay
  // deferred under a tech the receptionist just changed.
  function handlePickManicurist(rowKey: string, manicuristId: string) {
    setAssignments((prev) => ({ ...prev, [rowKey]: manicuristId }));
    setCollapsedRows((prev) => new Set([...prev, rowKey]));
    handleAssignNow(rowKey);
  }

  function handleClearAssignment(rowKey: string) {
    setAssignments((prev) => ({ ...prev, [rowKey]: null }));
    setCollapsedRows((prev) => { const s = new Set(prev); s.delete(rowKey); return s; });
    handleAssignNow(rowKey);
  }

  function getTurnValueForService(service: ServiceType): number {
    const svc = state.salonServices.find((s) => s.name === service);
    return svc?.turnValue ?? SERVICE_TURN_VALUES[service] ?? 0;
  }

  /** Did the CLIENT ask for this tech for this service? `clientRequest === true`
   *  is the only truth — a booking parked in a tech's column carries her id with
   *  clientRequest: false. Shared by the commit path and the confirm preview so
   *  the dialog can never show a turn count the commit doesn't credit. */
  function wasClientRequest(service: ServiceType, mId: string): boolean {
    return (client.serviceRequests || []).some(
      (r) => r.service === service && r.clientRequest === true && r.manicuristIds.includes(mId)
    );
  }

  /** Turn a deferred (waiting) row credits. A genuine client request is a half
   *  turn (a Combo is a full one); anything else earns the service's full turn.
   *  Deferring used to stamp EVERY waiting row as a request on the reasoning
   *  that choosing to wait is itself a request — but that quietly halved the
   *  turn on work the client never requested. Tony's rule, 2026-09-03: keep the
   *  full turn when it wasn't a request. */
  function deferredTurnValue(service: ServiceType, mId: string): number {
    const baseTurn = getTurnValueForService(service);
    if (baseTurn <= 0 || !wasClientRequest(service, mId)) return baseTurn;
    return state.salonServices.find((s) => s.name === service)?.category === 'Combo' ? 1 : 0.5;
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
        if (m && m.status === 'available' && !notNowRows.has(key)) {
          if (!manicuristGroups.has(mId)) {
            manicuristGroups.set(mId, { services: [], turnValue: 0 });
          }
          const group = manicuristGroups.get(mId)!;
          group.services.push(row.service);
          const baseTurn = getTurnValueForService(row.service);
          if (row.requestedId && baseTurn > 0) {
            const svc = state.salonServices.find((s) => s.name === row.service);
            group.turnValue += svc?.category === 'Combo' ? 1 : 0.5;
          } else {
            group.turnValue += baseTurn;
          }
        } else {
          deferredRows.push({ service: row.service, mId });
        }
      } else {
        waitingServices.push(row.service);
      }
    }

    const entries: { client: QueueEntry; manicuristId: string | null }[] = [];
    const smsTargets: { id: string; phone: string; smsOptIn: boolean; name: string; clientName: string; service: string; notificationBody?: string }[] = [];

    for (const [mId, group] of manicuristGroups) {
      // A request is a request only when the booking says clientRequest: true.
      // The presence of mId in manicuristIds is NOT sufficient: a booking
      // parked in a tech's column carries that tech with clientRequest: false.
      // This used to rely on check-in stripping those ids — an invariant that
      // lives in a different file and stopped holding (2026-08-22).
      const wasRequested = group.services.some((s) =>
        (client.serviceRequests || []).some(
          (r) => r.service === s && r.clientRequest === true && r.manicuristIds.includes(mId)
        )
      );
      // Stamp clientRequest: true so downstream consumers (R badge, edit modal,
      // QueueCard) can distinguish real requests from non-request assignments.
      const serviceReqs = wasRequested
        ? group.services.map((s) => ({ service: s as ServiceType, manicuristIds: [mId], clientRequest: true as const }))
        : [];

      // Deterministic id derived from the parent + manicurist slot — re-firing
      // SPLIT_AND_ASSIGN with the same selections produces the same child id,
      // so the upsert is idempotent at the PRIMARY KEY layer.
      const entry: QueueEntry = {
        id: `${client.id}-${mId}`,
        clientName: client.clientName,
        services: group.services,
        turnValue: group.turnValue,
        serviceRequests: serviceReqs,
        requestedManicuristId: wasRequested ? mId : null,
        isRequested: wasRequested,
        isAppointment: client.isAppointment,
        assignedManicuristId: null,
        status: 'waiting',
        arrivedAt: client.arrivedAt,
        startedAt: null,
        completedAt: null,
        extraTimeMs: 0,
      };

      entries.push({ client: entry, manicuristId: mId });

      const m = state.manicurists.find((x) => x.id === mId);
      if (m) {
        smsTargets.push({
          id: m.id,
          phone: m.phone || '',
          smsOptIn: m.smsOptIn || false,
          name: m.name,
          clientName: client.clientName,
          service: formatServiceList(group.services),
          notificationBody: m.notificationBody,
        });
      }
    }

    for (const { service, mId } of deferredRows) {
      const wasRequested = wasClientRequest(service, mId);
      // Deterministic id — parent + manicurist + service uniquely identifies
      // a deferred-row slot, so re-firing produces the same child id.
      const entry: QueueEntry = {
        id: `${client.id}-${mId}-${service}`,
        clientName: client.clientName,
        services: [service],
        turnValue: deferredTurnValue(service, mId),
        // The tech is carried either way so the waiting card still knows who
        // it's for — but clientRequest only says true when the CLIENT asked.
        // A false entry is the parked-column shape: this tech is intended,
        // the client didn't request her, and the full turn stands.
        serviceRequests: [{ service: service as ServiceType, manicuristIds: [mId], clientRequest: wasRequested }],
        requestedManicuristId: wasRequested ? mId : null,
        isRequested: wasRequested,
        isAppointment: client.isAppointment,
        assignedManicuristId: null,
        status: 'waiting',
        arrivedAt: client.arrivedAt,
        startedAt: null,
        completedAt: null,
        extraTimeMs: 0,
      };
      entries.push({ client: entry, manicuristId: null });
    }

    if (waitingServices.length > 0) {
      const turnValue = waitingServices.reduce((sum, s) => sum + getTurnValueForService(s), 0);
      // Deterministic id — there's only one "waiting bucket" per parent, so
      // ${parent.id}-waiting collapses any double-fires to a single row.
      //
      // BUT: `client` here can itself already BE a previously-created waiting
      // bucket (a receptionist re-opening the "still needs a tech" queue card
      // to assign whoever just became available, leaving the rest waiting
      // again — the normal "add a tech mid-ticket" flow). Blindly appending
      // another literal "-waiting" onto an id that already ends in "-waiting"
      // produces a malformed `${visit}-waiting-waiting` id (and would grow to
      // `-waiting-waiting-waiting` on a third round). Confirmed in production
      // (ticket_items.queue_entry_id LIKE '%waiting-waiting%', ticket #28
      // 2026-07-26) — the malformed id orphaned the newly-added tech's line
      // from turn crediting. Reuse the existing bucket id instead so repeated
      // rounds stay idempotent at a single "-waiting" suffix.
      const bucketId = client.id.endsWith('-waiting') ? client.id : `${client.id}-waiting`;
      const entry: QueueEntry = {
        id: bucketId,
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
        extraTimeMs: 0,
      };
      entries.push({ client: entry, manicuristId: null });
    }

    dispatch({ type: 'SPLIT_AND_ASSIGN', originalId: client.id, entries });

    for (const target of smsTargets) {
      showSmsToast('sending');
      sendPushNotification(target.id, target.name, target.clientName, target.service, target.notificationBody).then((pushResult) => {
        if (pushResult.success) {
          showSmsToast('sent');
        } else if (target.phone && target.smsOptIn) {
          sendTurnAlert(target.phone, target.name, target.clientName, target.service).then((smsResult) => {
            showSmsToast(smsResult.success ? 'sent' : 'failed');
          });
        } else {
          showSmsToast('failed');
        }
      });
    }

    setShowConfirm(false);
  }

  function buildConfirmRows() {
    const assignableGroups = new Map<string, { services: string[]; turnValue: number }>();
    const deferredGroups = new Map<string, { services: string[]; turnValue: number }>();

    for (const row of serviceRows) {
      const mId = assignments[row.uniqueKey];
      if (!mId) continue;
      const m = state.manicurists.find((x) => x.id === mId);
      if (m && m.status === 'available' && !notNowRows.has(row.uniqueKey)) {
        if (!assignableGroups.has(mId)) assignableGroups.set(mId, { services: [], turnValue: 0 });
        const group = assignableGroups.get(mId)!;
        group.services.push(row.service);
        const baseTurn = getTurnValueForService(row.service);
        if (row.requestedId && baseTurn > 0) {
          const svc = state.salonServices.find((s) => s.name === row.service);
          group.turnValue += svc?.category === 'Combo' ? 1 : 0.5;
        } else {
          group.turnValue += baseTurn;
        }
      } else if (m) {
        if (!deferredGroups.has(mId)) deferredGroups.set(mId, { services: [], turnValue: 0 });
        const g = deferredGroups.get(mId)!;
        g.services.push(row.service);
        g.turnValue += deferredTurnValue(row.service, mId);
      }
    }

    const rows: { manicuristName: string; manicuristColor: string; services: string[]; turnsToAdd: number; isDeferred?: boolean; isRequested?: boolean }[] = [];
    for (const [mId, group] of assignableGroups) {
      const m = state.manicurists.find((x) => x.id === mId);
      if (!m) continue;
      // Must use the SAME test as handleConfirm above, or the dialog shows a
      // REQUESTED badge and a turn count that don't match what gets credited.
      const wasRequested = group.services.some((s) =>
        (client.serviceRequests || []).some(
          (r) => r.service === s && r.clientRequest === true && r.manicuristIds.includes(mId)
        )
      );
      rows.push({ manicuristName: m.name, manicuristColor: m.color, services: group.services, turnsToAdd: group.turnValue, isRequested: wasRequested });
    }
    for (const [mId, group] of deferredGroups) {
      const m = state.manicurists.find((x) => x.id === mId);
      if (!m) continue;
      // Must use the SAME tests as the deferred loop in handleConfirm, or the
      // dialog shows a REQUESTED badge and a turn count the commit won't credit.
      const wasRequested = group.services.some((s) => wasClientRequest(s as ServiceType, mId));
      rows.push({ manicuristName: m.name, manicuristColor: m.color, services: group.services, turnsToAdd: group.turnValue, isDeferred: true, isRequested: wasRequested });
    }
    return rows;
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

        {(() => {
          const deferredItems = serviceRows
            .filter(row => {
              const reqId = (client.serviceRequests || []).find(r => r.service === row.service)?.manicuristIds?.[0];
              if (!reqId) return false;
              const m = state.manicurists.find(x => x.id === reqId);
              return !!m && m.status === 'busy';
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
            const isRowDeferred = !!selectedManicurist && isRowDeferredNow(key);
            const isNotNow = notNowRows.has(key);

            return (
              <div key={key}>
                <div className="flex items-center gap-2 mb-2">
                  <Badge label={row.service} variant="blue" size="md" />
                  {selectedId && (
                    <button
                      onClick={() => handleClearAssignment(key)}
                      className="font-mono text-[10px] text-red-400 hover:text-red-500 transition-colors"
                      title="Drop the request — anyone can take this service later"
                    >
                      Clear
                    </button>
                  )}
                  {/* "Not now" keeps the tech as the client's request and just
                      leaves them out of this round; "Clear" above drops the
                      request altogether. Only offered when the tech is actually
                      free — a busy tech already defers on her own. */}
                  {selectedId && !isNotNow && selectedManicurist?.status === 'available' && (
                    <button
                      onClick={() => setPendingNotNow({
                        key,
                        manicuristName: selectedManicurist.name,
                        service: row.service,
                      })}
                      className="font-mono text-[10px] text-amber-500 hover:text-amber-600 transition-colors"
                      title="Leave this service waiting, with this tech still requested"
                    >
                      Not now
                    </button>
                  )}
                  {isNotNow && (
                    <button
                      onClick={() => handleAssignNow(key)}
                      className="font-mono text-[10px] text-emerald-500 hover:text-emerald-600 transition-colors"
                    >
                      Assign now
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
                      ? <span className="font-mono text-[10px] font-bold text-amber-600 uppercase">
                          {isNotNow ? 'Waiting — still requested' : 'Waiting in queue'}
                        </span>
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
                      const isAlmostDone = m._almostDone;
                      const isBusy = isAlmostDone;
                      const busyDurationMs = isBusy
                        ? getClientDurationMs(m, state.queue, state.salonServices)
                        : 0;
                      const busyClient = isBusy
                        ? state.queue.find(c => c.id === m.currentClient) ?? null
                        : null;

                      return (
                        <div key={m.id}>
                          <div
                            onClick={() => !m._takenByOther && !isAlmostDone && handlePickManicurist(key, m.id)}
                            className={`w-full text-left p-3 rounded-xl border-2 transition-all duration-200 ${
                              isAlmostDone
                                ? 'border-amber-200 bg-amber-50/30'
                                : m._takenByOther
                                ? 'opacity-40 cursor-not-allowed border-gray-100 bg-gray-50'
                                : isSelected
                                  ? 'cursor-pointer border-emerald-300 bg-emerald-50/50 shadow-sm'
                                  : m._isExplicitlyRequested
                                    ? 'cursor-pointer border-pink-200 bg-pink-50/30 hover:border-pink-300 hover:shadow-md'
                                    : isRequested
                                      ? 'cursor-pointer border-pink-200 bg-pink-50/30 hover:border-pink-300 hover:shadow-md'
                                      : m._isSuggested
                                        ? 'cursor-pointer border-emerald-200 bg-emerald-50/30 hover:border-emerald-300 hover:shadow-md'
                                        : 'cursor-pointer border-gray-100 bg-white hover:border-pink-200 hover:shadow-md'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <span className="font-mono text-xs text-gray-400 w-5">#{idx + 1}</span>
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: m.color }} />
                                <span className="font-mono text-sm font-semibold text-gray-900">{m.name}</span>
                                <ServiceHistory m={m} />
                                {isSelected && <Check size={14} className="text-emerald-500" />}
                                {!isAlmostDone && m._isExplicitlyRequested && <Badge label="REQUESTED" variant="pink" />}
                                {!isAlmostDone && !m._isExplicitlyRequested && isRequested && <Badge label="REQUESTED" variant="pink" />}
                                {!isAlmostDone && m._isSuggested && !isRequested && rowIs4thSpecial && <Badge label="4TH POSITION" variant="amber" />}
                                {!isAlmostDone && m._isSuggested && !isRequested && !rowIs4thSpecial && !requestedId && <Badge label="RECOMMENDED" variant="green" />}
                                {isAlmostDone && <Badge label="ALMOST DONE" variant="amber" />}
                                {(() => {
                                  // includePast=true — see the same block in
                                  // SingleServiceAssign. A late appointment used to
                                  // drop out of the list entirely, hiding the warning
                                  // at the moment the receptionist most needs it.
                                  const apptIn = getMinsToNextAppt(m.id, state.appointments, true, state.queue, state.completed);
                                  if (apptIn === null || apptIn >= APPT_PILL_WINDOW_MINS) return null;
                                  const apptLate = apptIn < 0;
                                  return (
                                    <span className={`inline-flex items-center rounded-full font-mono font-bold tracking-wide uppercase text-[10px] px-2 py-0.5 animate-pulse ${apptLate ? 'bg-red-100 text-red-700 border border-red-500' : 'bg-yellow-100 text-yellow-700 border border-yellow-400'}`}>
                                      {apptLate ? `APPT ${Math.abs(apptIn)} MIN LATE` : `APPT IN ${apptIn} MIN`}
                                    </span>
                                  );
                                })()}
                                {m._takenByOther && (
                                  <span className="font-mono text-[9px] text-amber-500">(assigned above)</span>
                                )}
                              </div>
                              <div className="flex items-center gap-4">
                                {isBusy && (
                                  <CountdownBadge
                                    startedAt={busyClient?.startedAt ?? null}
                                    totalDurationMs={busyDurationMs}
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
                            {isAlmostDone && (
                              <div className="mt-2 flex gap-2">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handlePickManicurist(key, m.id); }}
                                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-amber-500 text-white font-mono text-xs font-semibold hover:bg-amber-600 active:scale-[0.98] transition-all"
                                >
                                  <Timer size={13} />
                                  WAIT FOR {m.name}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
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
        <AssignConfirmDialog
          clientName={client.clientName}
          rows={buildConfirmRows()}
          onConfirm={handleConfirm}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {pendingNotNow && (
        <ConfirmDialog
          message={`Unassign ${pendingNotNow.manicuristName} for now?\n\n${pendingNotNow.service} stays in the waiting queue with ${pendingNotNow.manicuristName} still requested. Assign ${pendingNotNow.manicuristName} when they're free.`}
          confirmLabel="Leave waiting"
          onConfirm={() => handleNotNow(pendingNotNow.key)}
          onCancel={() => setPendingNotNow(null)}
        />
      )}
    </>
  );
}
