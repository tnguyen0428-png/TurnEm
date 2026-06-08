import { useState } from 'react';
import { Clock, MessageSquare, Timer } from 'lucide-react';
import Modal from '../shared/Modal';
import Badge from '../shared/Badge';
import CountdownBadge from '../shared/CountdownBadge';
import AssignConfirmDialog from '../shared/AssignConfirmDialog';
import { useApp } from '../../state/AppContext';
import { getEligibleManicurists, getSuggestedManicurist, isFourthPositionSpecialService } from '../../utils/priority';
import { formatTime } from '../../utils/time';
import { sendTurnAlert } from '../../utils/sms';
import { sendPushNotification } from '../../utils/pushNotifications';
import { showSmsToast } from '../shared/SmsToast';
import type { QueueEntry, ServiceType } from '../../types';
import { isWaxService, waxRotationCompare } from '../../utils/salonRules';
import { getClientDurationMs, formatServiceList, ServiceHistory, getMinsToNextAppt } from './assignHelpers';

// Compute the turn_value a queue entry should carry once it's been marked
// as a customer request for a specific manicurist. Mirrors the convention
// in MultiServiceAssign.handleConfirm (lines 181-187): flat 0.5 per
// non-Combo service, flat 1.0 per Combo service.
//
// SingleServiceAssign previously only stamped isRequested=true without
// touching turnValue, which meant the queue entry kept the higher
// non-request base value (e.g. 1.0 for Pedicure, 1.5 for Gel Pedicure).
// When the manicurist finished, COMPLETE_SERVICE transcribed that
// inflated turn_value to completed_services — observed 2026-05-27 on
// Joe / Sue Keeney / Dip Only (written as turn=1.0 / is_requested=false
// when it should have been turn=0.5 / is_requested=true).
function computeRequestTurnValue(
  services: readonly string[],
  salonServices: { name: string; category?: string | null; turnValue?: number | null }[],
): number {
  let total = 0;
  for (const svcName of services) {
    const svc = salonServices.find((s) => s.name === svcName);
    const baseTurn = svc?.turnValue ?? 0;
    if (baseTurn <= 0) continue; // zero-turn services (e.g. Lip & Brows) stay zero
    total += svc?.category === 'Combo' ? 1 : 0.5;
  }
  return total;
}

export function SingleServiceAssign({ client }: { client: QueueEntry }) {
  const { state, dispatch } = useApp();
  const [confirmAssignment, setConfirmAssignment] = useState<{
    clientId: string;
    manicuristId: string;
    clientName: string;
    manicuristName: string;
    manicuristColor: string;
    service: string;
    services: string[];
    turnsToAdd: number;
  } | null>(null);

  // Upstream paths (addApptToQueue, handleCheckIn) already clear manicuristIds
  // on non-request entries, so any populated manicuristIds here represents a
  // real customer request — no need to also gate on clientRequest === true,
  // which can be missing on older data even when the request is genuine.
  const requestedIds = new Set(
    (client.serviceRequests || [])
      .filter((r) => Array.isArray(r.manicuristIds) && r.manicuristIds.length > 0)
      .flatMap((r) => r.manicuristIds || [])
  );

  const is4thSpecial = isFourthPositionSpecialService(client.services, state.salonServices);

  const eligible = getEligibleManicurists(client.services, state.manicurists, state.salonServices, state.queue);

  const requestedNotEligible = state.manicurists.filter(
    (m) => requestedIds.has(m.id) && !eligible.find((e) => e.id === m.id) && m.clockedIn && m.status === 'available'
  );

  const clientIsWax = client.services.length > 0 && isWaxService(client.services[0], state.salonServices);

  const baseList = [...eligible, ...requestedNotEligible]
    .sort((a, b) => {
      if (clientIsWax) return waxRotationCompare(a, b);
      const aReq = requestedIds.has(a.id) ? 0 : 1;
      const bReq = requestedIds.has(b.id) ? 0 : 1;
      if (aReq !== bReq) return aReq - bReq;
      if (Math.floor(a.totalTurns) !== Math.floor(b.totalTurns)) return Math.floor(a.totalTurns) - Math.floor(b.totalTurns);
      const aTime = a.clockInTime ?? Infinity;
      const bTime = b.clockInTime ?? Infinity;
      return aTime - bTime;
    });

  // When a specific manicurist is requested, lock the list to only that person
  const allEligible = requestedIds.size > 0
    ? baseList.filter(m => requestedIds.has(m.id))
    : baseList;

  const suggestedId = getSuggestedManicurist(client.services, state.manicurists, state.salonServices)?.id ?? null;

  function handleWaitForManicurist(manicuristId: string) {
    // User explicitly chose to wait for this manicurist — record an actual
    // request entry (clientRequest: true) on every service so the R badge,
    // QueueCard requested-services list, and edit modal all reflect it.
    const updatedRequests = [...(client.serviceRequests || [])];
    for (const svcName of client.services) {
      const existing = updatedRequests.find(r => r.service === svcName);
      if (existing) {
        if (!existing.manicuristIds.includes(manicuristId)) {
          existing.manicuristIds = [...existing.manicuristIds, manicuristId];
        }
        existing.clientRequest = true;
      } else {
        updatedRequests.push({ service: svcName as ServiceType, manicuristIds: [manicuristId], clientRequest: true });
      }
    }
    const newTurnValue = computeRequestTurnValue(client.services, state.salonServices);
    dispatch({
      type: 'UPDATE_CLIENT',
      id: client.id,
      updates: {
        serviceRequests: updatedRequests,
        requestedManicuristId: manicuristId,
        isRequested: true,
        turnValue: newTurnValue,
      },
    });
    dispatch({ type: 'SET_SELECTED_CLIENT', clientId: null });
    dispatch({ type: 'SET_MODAL', modal: null });
  }

  function handleSelect(manicuristId: string) {
    const manicurist = state.manicurists.find((m) => m.id === manicuristId);
    if (!manicurist) return;
    setConfirmAssignment({
      clientId: client.id,
      manicuristId,
      clientName: client.clientName,
      manicuristName: manicurist.name,
      manicuristColor: manicurist.color,
      service: formatServiceList(client.services),
      services: client.services,
      turnsToAdd: client.turnValue,
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
    if (manicurist) {
      showSmsToast('sending');
      // Try push notification first, fall back to SMS
      sendPushNotification(
        manicurist.id,
        manicurist.name,
        confirmAssignment.clientName,
        confirmAssignment.service,
        manicurist.notificationBody
      ).then((pushResult) => {
        if (pushResult.success) {
          showSmsToast('sent');
        } else if (manicurist.phone && manicurist.smsOptIn) {
          // Fall back to SMS if push fails and manicurist has opted in
          sendTurnAlert(
            manicurist.phone,
            manicurist.name,
            confirmAssignment.clientName,
            confirmAssignment.service
          ).then((smsResult) => {
            showSmsToast(smsResult.success ? 'sent' : 'failed');
          });
        } else {
          showSmsToast('failed');
        }
      });
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
            {allEligible.map((m, idx) => {
              const isAlmostDone = '_almostDone' in m && !!(m as { _almostDone?: boolean })._almostDone;
              const isBusy = isAlmostDone;
              const durationMs = isBusy ? getClientDurationMs(m, state.queue, state.salonServices) : 0;
              const currentQueueEntry = isBusy
                ? state.queue.find(c => c.id === m.currentClient) ?? null
                : null;

              return (
                <div key={m.id}>
                  <div
                    onClick={() => !isBusy && handleSelect(m.id)}
                    className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-200 ${
                      isAlmostDone
                        ? 'border-amber-200 bg-amber-50/30'
                        : requestedIds.has(m.id)
                        ? 'cursor-pointer border-pink-300 bg-pink-50/50 hover:border-pink-400 hover:shadow-md'
                        : m.id === suggestedId
                        ? 'cursor-pointer border-emerald-300 bg-emerald-50/50 hover:border-emerald-400 hover:shadow-md'
                        : 'cursor-pointer border-gray-100 bg-white hover:border-pink-200 hover:shadow-md'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-gray-400 w-6">#{idx + 1}</span>
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: m.color }} />
                        <span className="font-mono text-sm font-semibold text-gray-900">{m.name}</span>
                        <ServiceHistory m={m} />
                        {!isAlmostDone && requestedIds.has(m.id) && <Badge label="REQUESTED" variant="pink" />}
                        {!isAlmostDone && m.id === suggestedId && is4thSpecial && <Badge label="4TH POSITION" variant="amber" />}
                        {!isAlmostDone && m.id === suggestedId && !is4thSpecial && requestedIds.size === 0 && <Badge label="RECOMMENDED" variant="green" />}
                        {isAlmostDone && <Badge label="ALMOST DONE" variant="amber" />}
                        {(() => {
                          const apptIn = getMinsToNextAppt(m.id, state.appointments, false, state.queue, state.completed);
                          if (apptIn === null || apptIn >= 30) return null;
                          return (
                            <span className="inline-flex items-center rounded-full font-mono font-bold tracking-wide uppercase text-[10px] px-2 py-0.5 bg-yellow-100 text-yellow-700 border border-yellow-400 animate-pulse">
                              APPT IN {apptIn} MIN
                            </span>
                          );
                        })()}
                      </div>
                      <div className="flex items-center gap-4">
                        {isBusy && (
                          <CountdownBadge
                            startedAt={currentQueueEntry?.startedAt ?? null}
                            totalDurationMs={durationMs}
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
                      <div className="mt-3 flex gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleWaitForManicurist(m.id); }}
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
      </Modal>

      {confirmAssignment && (
        <AssignConfirmDialog
          clientName={confirmAssignment.clientName}
          rows={[{
            manicuristName: confirmAssignment.manicuristName,
            manicuristColor: confirmAssignment.manicuristColor,
            services: confirmAssignment.services,
            turnsToAdd: confirmAssignment.turnsToAdd,
            isRequested: client.isRequested,
          }]}
          onConfirm={handleConfirm}
          onCancel={() => setConfirmAssignment(null)}
        />
      )}
    </>
  );
}
