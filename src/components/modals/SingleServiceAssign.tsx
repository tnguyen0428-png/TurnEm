import { useState } from 'react';
import { Clock, MessageSquare, Timer } from 'lucide-react';
import { useCountdown } from '../../hooks/useCountdown';
import Modal from '../shared/Modal';
import Badge from '../shared/Badge';
import CountdownBadge from '../shared/CountdownBadge';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import { getEligibleManicurists, getSuggestedManicurist, isFourthPositionSpecialService } from '../../utils/priority';
import { formatTime } from '../../utils/time';
import { sendTurnAlert } from '../../utils/sms';
import { showSmsToast } from '../shared/SmsToast';
import type { QueueEntry, ServiceType } from '../../types';
import { isWaxService, isAcrylicService, getSamPreferenceForServices, waxRotationCompare } from '../../utils/salonRules';
import { getClientDurationMs, formatServiceList, ServiceHistory } from './assignHelpers';

export function SingleServiceAssign({ client }: { client: QueueEntry }) {
  const { state, dispatch } = useApp();
  const [confirmAssignment, setConfirmAssignment] = useState<{
    clientId: string;
    manicuristId: string;
    clientName: string;
    manicuristName: string;
    service: string;
  } | null>(null);
  const [dismissedSamPrompt, setDismissedSamPrompt] = useState(false);

  const requestedIds = new Set(
    (client.serviceRequests || []).flatMap((r) => r.manicuristIds || [])
  );

  const is4thSpecial = isFourthPositionSpecialService(client.services, state.salonServices);

  const eligible = getEligibleManicurists(client.services, state.manicurists, state.salonServices);

  const requestedNotEligible = state.manicurists.filter(
    (m) => requestedIds.has(m.id) && !eligible.find((e) => e.id === m.id) && m.clockedIn && m.status === 'available'
  );

  const sam = getSamPreferenceForServices(state.manicurists, client.services, state.salonServices);
  const clientIsWax = client.services.length > 0 && isWaxService(client.services[0], state.salonServices);

  const baseList = [...eligible, ...requestedNotEligible]
    .filter(m => !sam || m.id !== sam.id)
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

  const allEligible = sam ? [sam, ...baseList] : baseList;

  const suggestedId = getSuggestedManicurist(client.services, state.manicurists, state.salonServices)?.id ?? null;

  const showSamPrompt = !!sam && sam.status === 'busy' && !dismissedSamPrompt;
  const samCurrentClient = sam ? state.queue.find(c => c.id === sam.currentClient) ?? null : null;
  const samDurationMs = sam ? getClientDurationMs(sam, state.queue, state.salonServices) : 0;
  const { display: samCountdownDisplay } = useCountdown(samCurrentClient?.startedAt ?? null, samDurationMs);

  function handleWaitForSam() {
    if (!sam) return;
    const updatedRequests = [...(client.serviceRequests || [])];
    for (const svcName of client.services) {
      if (isAcrylicService(svcName, state.salonServices)) {
        const existing = updatedRequests.find(r => r.service === svcName);
        if (existing) {
          if (!existing.manicuristIds.includes(sam.id)) {
            existing.manicuristIds = [...existing.manicuristIds, sam.id];
          }
        } else {
          updatedRequests.push({ service: svcName as ServiceType, manicuristIds: [sam.id] });
        }
      }
    }
    dispatch({
      type: 'UPDATE_CLIENT',
      id: client.id,
      updates: { serviceRequests: updatedRequests, requestedManicuristId: sam.id, isRequested: true },
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
                ASSIGN SOMEONE ELSE
              </button>
            </div>
          </div>
        )}

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
          <div className={`space-y-2 ${showSamPrompt ? 'opacity-50 pointer-events-none' : ''}`}>
            {allEligible.map((m, idx) => {
              const isSamPreferred = sam?.id === m.id;
              const isBusySam = isSamPreferred && m.status === 'busy';
              const durationMs = isBusySam ? getClientDurationMs(m, state.queue, state.salonServices) : 0;
              const currentQueueEntry = isBusySam
                ? state.queue.find(c => c.id === m.currentClient) ?? null
                : null;

              return (
                <button
                  key={m.id}
                  onClick={() => !isBusySam && handleSelect(m.id)}
                  disabled={isBusySam}
                  style={isBusySam ? { opacity: 0.7 } : undefined}
                  className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-200 ${
                    isBusySam
                      ? 'cursor-not-allowed border-indigo-200 bg-indigo-50/30'
                      : isSamPreferred
                      ? 'border-indigo-300 bg-indigo-50/50 hover:border-indigo-400 hover:shadow-md'
                      : requestedIds.has(m.id)
                      ? 'border-pink-300 bg-pink-50/50 hover:border-pink-400 hover:shadow-md'
                      : m.id === suggestedId
                      ? 'border-emerald-300 bg-emerald-50/50 hover:border-emerald-400 hover:shadow-md'
                      : 'border-gray-100 bg-white hover:border-pink-200 hover:shadow-md'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-gray-400 w-6">#{idx + 1}</span>
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: m.color }} />
                      <span className="font-mono text-sm font-semibold text-gray-900">{m.name}</span>
                      <ServiceHistory m={m} />
                      {isSamPreferred && <Badge label="PREFERRED" variant="indigo" />}
                      {!isSamPreferred && requestedIds.has(m.id) && <Badge label="REQUESTED" variant="pink" />}
                      {!isSamPreferred && m.id === suggestedId && is4thSpecial && <Badge label="4TH POSITION" variant="amber" />}
                      {!isSamPreferred && m.id === suggestedId && !is4thSpecial && <Badge label="RECOMMENDED" variant="green" />}
                    </div>
                    <div className="flex items-center gap-4">
                      {isBusySam && (
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
                </button>
              );
            })}
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
