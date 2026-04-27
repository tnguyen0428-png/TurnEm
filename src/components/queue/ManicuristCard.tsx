import { useState } from 'react';
import { CheckCircle, Coffee, LogIn, LogOut, ChevronUp, ChevronDown, XCircle, CreditCard as Edit, Bell, BellOff, Clock } from 'lucide-react';
import type { Manicurist, QueueEntry } from '../../types';
import CountdownBadge from '../shared/CountdownBadge';
import ConfirmDialog from '../shared/ConfirmDialog';
import { SharedAutoFitText } from '../shared/SharedAutoFitText';
import { useApp } from '../../state/AppContext';
import { sendPushNotification } from '../../utils/pushNotifications';
import { showSmsToast } from '../shared/SmsToast';
import { useElapsedTime } from '../../hooks/useElapsedTime';

interface ManicuristCardProps {
  manicurist: Manicurist;
  currentClient?: QueueEntry | null;
  clientHasWax?: boolean;
  isFirst: boolean;
  isLast: boolean;
  turnRank: number | null;
  totalRanked: number;
  clientDurationMs?: number;
  hasPushSub?: boolean;
}

function getStatusConfig(status: Manicurist['status']) {
  switch (status) {
    case 'available':
      return { label: 'AVAILABLE', color: 'bg-emerald-500', badge: 'green' as const };
    case 'busy':
      return { label: 'BUSY', color: 'bg-red-500', badge: 'red' as const };
    case 'break':
      return { label: 'BREAK', color: 'bg-amber-500', badge: 'amber' as const };
  }
}

export default function ManicuristCard({ manicurist, currentClient, clientHasWax, isFirst, isLast, turnRank, totalRanked, clientDurationMs = 0, hasPushSub = false }: ManicuristCardProps) {
  const { dispatch } = useApp();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
  const [bellSending, setBellSending] = useState(false);
  const statusConfig = getStatusConfig(manicurist.status);
  const breakElapsed = useElapsedTime(manicurist.status === 'break' ? (manicurist.breakStartTime ?? null) : null);

  function handleClockToggle() {
    if (manicurist.clockedIn) {
      setShowClockOutConfirm(true);
    } else {
      dispatch({ type: 'CLOCK_IN', id: manicurist.id });
    }
  }

  function handleClockOutConfirm() {
    dispatch({ type: 'CLOCK_OUT', id: manicurist.id });
    setShowClockOutConfirm(false);
  }

  function handleBreakToggle() {
    if (manicurist.status === 'break') {
      dispatch({ type: 'END_BREAK', id: manicurist.id });
    } else {
      dispatch({ type: 'SET_BREAK', id: manicurist.id });
    }
  }

  function handleDone() {
        dispatch({ type: 'COMPLETE_SERVICE', manicuristId: manicurist.id });
  }

  function handleCancel() {
    dispatch({ type: 'CANCEL_SERVICE', manicuristId: manicurist.id });
    setShowCancelConfirm(false);
  }

  function handleEditClient() {
    if (currentClient) {
      dispatch({ type: 'SET_EDITING_CLIENT', clientId: currentClient.id });
      dispatch({ type: 'SET_MODAL', modal: 'editClient' });
    }
  }

  async function handleBellClick() {
    if (!hasPushSub || bellSending) return;
    setBellSending(true);
    const result = await sendPushNotification(
      manicurist.id,
      manicurist.name,
      currentClient?.clientName || 'Test',
      currentClient?.services?.join(', ') || 'Notification',
      manicurist.notificationBody
    );
    if (result.success) {
      showSmsToast('sent', `Push OK: ${result.error || 'no details'}`);
    } else {
      showSmsToast('failed', `Push FAIL: ${result.error}`);
    }
    setBellSending(false);
  }

  return (
    <>
    {showCancelConfirm && (
      <ConfirmDialog
        message={`Cancel service and return ${currentClient?.clientName || 'client'} to the queue?`}
        confirmLabel="Cancel Service"
        onConfirm={handleCancel}
        onCancel={() => setShowCancelConfirm(false)}
      />
    )}
    {showClockOutConfirm && (
      <ConfirmDialog
        message={`Clock out "${manicurist.name.toUpperCase()}"?`}
        confirmLabel="Clock Out"
        onConfirm={handleClockOutConfirm}
        onCancel={() => setShowClockOutConfirm(false)}
      />
    )}
    <div
      className={`bg-white rounded-xl border-2 transition-all duration-200 overflow-hidden ${
        !manicurist.clockedIn
          ? 'border-gray-100 opacity-50'
          : manicurist.status === 'busy'
          ? 'border-red-200 shadow-md shadow-red-50'
          : manicurist.status === 'break'
          ? 'border-amber-200 shadow-md shadow-amber-50'
          : turnRank === 1
          ? 'border-emerald-400 shadow-md shadow-emerald-100 ring-2 ring-emerald-300/50'
          : turnRank === 4
          ? 'border-purple-400 shadow-md shadow-purple-100 ring-2 ring-purple-300/50'
          : 'border-gray-100 hover:border-emerald-200 hover:shadow-md'
      }`}
    >
      <div className="p-2">
        <div className="flex items-center gap-1.5 mb-1.5">
          <div className="flex flex-col gap-0.5">
            <button
              onClick={() => dispatch({ type: 'REORDER_MANICURIST', id: manicurist.id, direction: 'up' })}
              disabled={isFirst}
              className={`p-0.5 rounded transition-colors ${
                isFirst
                  ? 'text-gray-200 cursor-not-allowed'
                  : 'text-gray-400 hover:text-pink-500 hover:bg-pink-50'
              }`}
              title="Move up in queue"
            >
              <ChevronUp size={10} />
            </button>
            <button
              onClick={() => dispatch({ type: 'REORDER_MANICURIST', id: manicurist.id, direction: 'down' })}
              disabled={isLast}
              className={`p-0.5 rounded transition-colors ${
                isLast
                  ? 'text-gray-200 cursor-not-allowed'
                  : 'text-gray-400 hover:text-pink-500 hover:bg-pink-50'
              }`}
              title="Move down in queue"
            >
              <ChevronDown size={10} />
            </button>
          </div>
          <div
            className="w-2.5 h-2.5 rounded-full ring-2 ring-white shadow shrink-0"
            style={{ backgroundColor: manicurist.color }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <SharedAutoFitText className="flex-1 font-bebas tracking-[1px] text-gray-900 leading-none">
                {manicurist.name}
              </SharedAutoFitText>
              <button
                onClick={handleBellClick}
                disabled={!hasPushSub || bellSending}
                className={`p-0.5 rounded transition-colors shrink-0 ${
                  hasPushSub
                    ? 'text-emerald-500 hover:bg-emerald-50 cursor-pointer'
                    : 'text-gray-200 cursor-default'
                } ${bellSending ? 'animate-pulse' : ''}`}
                title={hasPushSub ? 'Tap to resend push notification' : 'Push not enabled'}
              >
                {hasPushSub ? <Bell size={12} fill="currentColor" /> : <BellOff size={12} />}
              </button>
            </div>
            <span className={`font-mono text-[10px] font-semibold tracking-wider ${
              manicurist.status === 'available' ? 'text-emerald-500' :
              manicurist.status === 'busy' ? 'text-red-500' : 'text-amber-500'
            }`}>
              {statusConfig.label}
            </span>
          </div>
        </div>

        <div className="mb-1 flex items-center justify-between h-4">
          {turnRank !== null && totalRanked > 0 && (
            <span
              className={`font-mono text-[10px] font-bold tracking-wider ${
                turnRank === 1
                  ? 'text-emerald-600'
                  : turnRank === 2
                  ? 'text-sky-600'
                  : turnRank === 4
                  ? 'text-purple-600'
                  : 'text-gray-400'
              }`}
            >
              {turnRank === 1 ? 'NEXT UP' : `#${turnRank}`}
            </span>
          )}
        </div>

        {(() => {
          const hasWaxSkill = manicurist.skills.some(s => ['Waxing', 'Eyebrows', 'Lip & Brows', 'Lips', 'Whole Face'].includes(s));
          return (
            <div className="mb-2 flex items-center gap-1.5">
              <div className="flex flex-col items-center gap-0.5">
                <button
                  onClick={() => dispatch({ type: 'TOGGLE_FOURTH_POSITION_SPECIAL', id: manicurist.id })}
                  className="flex items-center justify-center w-5 h-5"
                  title="Toggle check 1"
                >
                  <CheckCircle
                    size={14}
                    className={`transition-colors ${manicurist.hasFourthPositionSpecial ? 'text-red-500' : 'text-gray-200'}`}
                  />
                </button>
                <button
                  onClick={() => hasWaxSkill && dispatch({ type: 'TOGGLE_WAX', id: manicurist.id })}
                  className={`font-mono text-xs font-bold leading-none transition-colors h-4 ${
                    !hasWaxSkill ? 'invisible' :
                    manicurist.hasWax || clientHasWax ? 'text-amber-400' : 'text-gray-200 hover:text-gray-300'
                  }`}
                  title="Toggle wax 1"
                >
                  W
                </button>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <button
                  onClick={() => dispatch({ type: 'TOGGLE_CHECK2', id: manicurist.id })}
                  className="flex items-center justify-center w-5 h-5"
                  title="Toggle check 2"
                >
                  <CheckCircle
                    size={14}
                    className={`transition-colors ${manicurist.hasCheck2 ? 'text-red-500' : 'text-gray-200'}`}
                  />
                </button>
                <button
                  onClick={() => hasWaxSkill && dispatch({ type: 'TOGGLE_WAX2', id: manicurist.id })}
                  className={`font-mono text-xs font-bold leading-none transition-colors h-4 ${
                    !hasWaxSkill ? 'invisible' :
                    manicurist.hasWax2 ? 'text-amber-400' : 'text-gray-200 hover:text-gray-300'
                  }`}
                  title="Toggle wax 2"
                >
                  W
                </button>
              </div>
              <div className="flex flex-col items-center gap-0.5">
                <button
                  onClick={() => dispatch({ type: 'TOGGLE_CHECK3', id: manicurist.id })}
                  className="flex items-center justify-center w-5 h-5"
                  title="Toggle check 3"
                >
                  <CheckCircle
                    size={14}
                    className={`transition-colors ${manicurist.hasCheck3 ? 'text-red-500' : 'text-gray-200'}`}
                  />
                </button>
                <button
                  onClick={() => hasWaxSkill && dispatch({ type: 'TOGGLE_WAX3', id: manicurist.id })}
                  className={`font-mono text-xs font-bold leading-none transition-colors h-4 ${
                    !hasWaxSkill ? 'invisible' :
                    manicurist.hasWax3 ? 'text-amber-400' : 'text-gray-200 hover:text-gray-300'
                  }`}
                  title="Toggle wax 3"
                >
                  W
                </button>
              </div>
            </div>
          );
        })()}

        <div className="text-center my-1.5">
          <p className="font-bebas text-2xl text-gray-900 leading-none">
            {(Number(manicurist.totalTurns) || 0).toFixed(1)}
          </p>
          <p className="font-mono text-[9px] text-gray-400 tracking-wider mt-0.5">TURNS</p>
        </div>

        {manicurist.status === 'busy' && currentClient && (
          <div className="bg-red-50 rounded-lg p-1.5 mb-1.5">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1 min-w-0">
                <p className="font-mono text-[10px] font-semibold text-red-700 truncate">
                  {currentClient.clientName}
                </p>
                {currentClient.serviceRequests?.some(
                  sr => Array.isArray(sr.manicuristIds) && sr.manicuristIds.includes(manicurist.id)
                ) && (
                  <span className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white font-bold text-[9px]">R</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleEditClient}
                  className="flex items-center justify-center p-0.5 rounded hover:bg-red-100 transition-colors"
                  title="Edit client services"
                >
                  <Edit size={12} className="text-red-500" />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-1.5 mb-1">
              <CountdownBadge
                startedAt={currentClient.startedAt}
                totalDurationMs={clientDurationMs}
                status={manicurist.status}
              />
              <button
                onClick={() => dispatch({ type: 'UPDATE_CLIENT', id: currentClient.id, updates: { extraTimeMs: (currentClient.extraTimeMs || 0) + 5 * 60000 } })}
                className="flex items-center justify-center px-1.5 py-0.5 rounded font-mono text-[9px] font-bold bg-red-100 text-red-600 hover:bg-red-200 active:scale-95 transition-all"
                title="Add 5 minutes"
              >
                +5m
              </button>
            </div>
            {currentClient.services.length > 0 && (
              <div className="flex flex-wrap gap-0.5 mt-1">
                {currentClient.services.map((svc) => (
                  <span
                    key={svc}
                    className="font-mono text-[9px] bg-red-100 text-red-600 rounded px-1 py-0.5 leading-none"
                  >
                    {svc}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {manicurist.status === 'break' && breakElapsed && (
          <div className="bg-amber-50 rounded-lg px-2 py-1.5 mb-1.5 flex items-center gap-1.5">
            <Clock size={11} className="text-amber-500 shrink-0" />
            <span className="font-mono text-[11px] font-bold text-amber-700 tabular-nums">{breakElapsed}</span>
            <span className="font-mono text-[9px] text-amber-500 tracking-wider">ON BREAK</span>
          </div>
        )}

        <div className="flex gap-1">
          {manicurist.status === 'busy' ? (
            <>
              <button
                onClick={() => setShowCancelConfirm(true)}
                className="flex-1 flex items-center justify-center gap-0.5 py-1.5 rounded-lg border-2 border-red-200 text-red-500 font-mono text-[10px] font-semibold hover:bg-red-50 active:scale-[0.98] transition-all"
              >
                <XCircle size={11} />
                CANCEL
              </button>
              <button
                onClick={handleDone}
                className="flex-1 flex items-center justify-center gap-0.5 py-1.5 rounded-lg bg-emerald-500 text-white font-mono text-[10px] font-semibold hover:bg-emerald-600 active:scale-[0.98] transition-all"
              >
                <CheckCircle size={11} />
                DONE
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleClockToggle}
                className={`flex-1 flex items-center justify-center gap-0.5 py-1.5 rounded-lg border-2 font-mono text-[10px] font-semibold transition-all active:scale-[0.98] ${
                  manicurist.clockedIn
                    ? 'border-red-200 text-red-500 hover:bg-red-50'
                    : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'
                }`}
              >
                {manicurist.clockedIn ? <LogOut size={11} /> : <LogIn size={11} />}
                {manicurist.clockedIn ? 'OUT' : 'IN'}
              </button>
              {manicurist.clockedIn && (
                <button
                  onClick={handleBreakToggle}
                  className={`flex-1 flex items-center justify-center gap-0.5 py-1.5 rounded-lg border-2 font-mono text-[10px] font-semibold transition-all active:scale-[0.98] ${
                    manicurist.status === 'break'
                      ? 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'
                      : 'border-amber-200 text-amber-600 hover:bg-amber-50'
                  }`}
                >
                  <Coffee size={11} />
                  {manicurist.status === 'break' ? 'BACK' : 'BRK'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  </>
  );
}
