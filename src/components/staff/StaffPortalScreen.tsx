import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { LogOut, Bell, BellOff, CheckCircle, Clock, Volume2 } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { subscribeToPush, isPushSupported, getPermissionState } from '../../utils/pushNotifications';
import { formatTime } from '../../utils/time';
import type { Manicurist } from '../../types';

interface StaffPortalScreenProps {
  manicurist: Manicurist;
  onLogout: () => void;
}

export default function StaffPortalScreen({ manicurist: initialManicurist, onLogout }: StaffPortalScreenProps) {
  const { state } = useApp();
  const [pushStatus, setPushStatus] = useState<'idle' | 'subscribing' | 'subscribed' | 'error'>('idle');

  // Get live data for this manicurist from state (real-time updates)
  const manicurist = state.manicurists.find((m) => m.id === initialManicurist.id) || initialManicurist;

  // Services completed today by this manicurist
  const completedToday = useMemo(() => {
    return state.completed
      .filter((e) => e.manicuristId === manicurist.id)
      .sort((a, b) => b.completedAt - a.completedAt);
  }, [state.completed, manicurist.id]);

  // Queue position: rank among clocked-in available manicurists by turn count
  const queuePosition = useMemo(() => {
    if (!manicurist.clockedIn) return null;
    if (manicurist.status !== 'available') return null;

    const available = state.manicurists
      .filter((m) => m.clockedIn && m.status === 'available')
      .sort((a, b) => {
        const aFloor = Math.floor(a.totalTurns);
        const bFloor = Math.floor(b.totalTurns);
        if (aFloor !== bFloor) return aFloor - bFloor;
        return (a.clockInTime ?? Infinity) - (b.clockInTime ?? Infinity);
      });

    const idx = available.findIndex((m) => m.id === manicurist.id);
    return idx === -1 ? null : idx + 1;
  }, [state.manicurists, manicurist]);

  // ---- In-app alert when assigned a client or becoming next up ----
  const [alert, setAlert] = useState<{ type: 'assigned' | 'nextup'; clientName?: string; services?: string[] } | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const prevStatusRef = useRef(manicurist.status);
  const prevQueuePosRef = useRef(queuePosition);
  const audioContextRef = useRef<AudioContext | null>(null);

  const playAlertSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const ctx = audioContextRef.current || new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = ctx;

      // Play a loud two-tone alert
      const playTone = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'square';
        gain.gain.value = 0.3;
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration);
      };

      // Three beeps
      playTone(880, 0, 0.15);
      playTone(1100, 0.2, 0.15);
      playTone(880, 0.4, 0.15);
      playTone(1100, 0.6, 0.15);
      playTone(1320, 0.8, 0.3);
    } catch (e) {
      console.log('Audio alert failed:', e);
    }
  }, [soundEnabled]);

  // Detect assignment (status changed to busy)
  useEffect(() => {
    if (prevStatusRef.current !== 'busy' && manicurist.status === 'busy' && manicurist.currentClient) {
      const client = state.queue.find((c) => c.id === manicurist.currentClient);
      setAlert({
        type: 'assigned',
        clientName: client?.clientName || 'Client',
        services: client?.services || [],
      });
      playAlertSound();
    }
    prevStatusRef.current = manicurist.status;
  }, [manicurist.status, manicurist.currentClient, state.queue, playAlertSound]);

  // Detect becoming next up (queue position changed to 1)
  useEffect(() => {
    if (prevQueuePosRef.current !== 1 && queuePosition === 1) {
      setAlert({ type: 'nextup' });
      playAlertSound();
    }
    prevQueuePosRef.current = queuePosition;
  }, [queuePosition, playAlertSound]);

  // Auto-dismiss alert after 30 seconds
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(null), 30000);
    return () => clearTimeout(timer);
  }, [alert]);

  // Activate AudioContext on first tap (iOS requires user gesture)
  function handleScreenTap() {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  }

  async function handleEnablePush() {
    setPushStatus('subscribing');
    const result = await subscribeToPush(manicurist.id);
    setPushStatus(result.success ? 'subscribed' : 'error');
    if (!result.success) {
      setTimeout(() => setPushStatus('idle'), 3000);
    }
  }

  const statusLabel = manicurist.status === 'available' ? 'Available' :
    manicurist.status === 'busy' ? 'Busy' : 'On Break';
  const statusColor = manicurist.status === 'available' ? 'text-emerald-500' :
    manicurist.status === 'busy' ? 'text-red-500' : 'text-amber-500';

  return (
    <div className="min-h-screen bg-gray-50" onClick={handleScreenTap}>
      {/* Full-screen alert overlay */}
      {alert && (
        <div
          className={`fixed inset-0 z-50 flex flex-col items-center justify-center p-8 ${
            alert.type === 'assigned'
              ? 'bg-gradient-to-b from-red-500 to-red-700'
              : 'bg-gradient-to-b from-emerald-500 to-emerald-700'
          }`}
          style={{ animation: 'pulse 1s ease-in-out infinite alternate' }}
          onClick={() => setAlert(null)}
        >
          <style>{`
            @keyframes pulse { from { opacity: 0.85; } to { opacity: 1; } }
            @keyframes bounceIn { 0% { transform: scale(0.5); opacity: 0; } 50% { transform: scale(1.1); } 100% { transform: scale(1); opacity: 1; } }
          `}</style>
          <div style={{ animation: 'bounceIn 0.5s ease-out' }} className="text-center">
            {alert.type === 'assigned' ? (
              <>
                <Bell size={64} className="text-white mx-auto mb-4" />
                <h2 className="font-bebas text-5xl text-white tracking-[3px] mb-3">YOUR TURN!</h2>
                <p className="font-mono text-lg text-white/90 font-semibold mb-2">
                  Client: {alert.clientName}
                </p>
                {alert.services && alert.services.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-2 mt-3">
                    {alert.services.map((s) => (
                      <span key={s} className="px-3 py-1 rounded-full bg-white/20 text-white font-mono text-sm font-semibold">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                <p className="font-mono text-sm text-white/70 mt-6">Please head to your station</p>
              </>
            ) : (
              <>
                <div className="text-7xl mb-4">👆</div>
                <h2 className="font-bebas text-5xl text-white tracking-[3px] mb-3">YOU'RE NEXT!</h2>
                <p className="font-mono text-lg text-white/90 font-semibold">Get ready — you're next in line</p>
              </>
            )}
            <p className="font-mono text-xs text-white/50 mt-8">Tap anywhere to dismiss</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full ring-2 ring-white shadow"
              style={{ backgroundColor: manicurist.color }}
            />
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-bebas text-xl tracking-[1px] text-gray-900 leading-none">{manicurist.name}</h1>
                {(pushStatus === 'subscribed' || getPermissionState() === 'granted') && (
                  <Bell size={14} className="text-emerald-500" />
                )}
              </div>
              <span className={`font-mono text-[10px] font-semibold tracking-wider uppercase ${statusColor}`}>
                {statusLabel}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                handleScreenTap();
                setSoundEnabled(!soundEnabled);
              }}
              className={`flex items-center gap-1 px-2.5 py-2 rounded-lg border font-mono text-xs font-semibold transition-all ${
                soundEnabled
                  ? 'border-emerald-200 text-emerald-600 bg-emerald-50'
                  : 'border-gray-200 text-gray-400'
              }`}
            >
              <Volume2 size={14} />
              {soundEnabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 font-mono text-xs font-semibold transition-all"
            >
              <LogOut size={14} />
              LOGOUT
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-5 space-y-4">
        {/* Stats Row */}
        <div className="grid grid-cols-2 gap-3">
          {/* Total Turns */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4 text-center shadow-sm">
            <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider uppercase mb-1">TOTAL TURNS</p>
            <p className="font-bebas text-4xl text-gray-900 leading-none">{manicurist.totalTurns.toFixed(1)}</p>
          </div>

          {/* Queue Position */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4 text-center shadow-sm">
            <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider uppercase mb-1">QUEUE POSITION</p>
            {manicurist.status === 'busy' ? (
              <p className="font-bebas text-2xl text-red-500 leading-none mt-1">BUSY</p>
            ) : manicurist.status === 'break' ? (
              <p className="font-bebas text-2xl text-amber-500 leading-none mt-1">BREAK</p>
            ) : !manicurist.clockedIn ? (
              <p className="font-bebas text-2xl text-gray-300 leading-none mt-1">OFF</p>
            ) : queuePosition ? (
              <p className="font-bebas text-4xl text-gray-900 leading-none">#{queuePosition}</p>
            ) : (
              <p className="font-bebas text-2xl text-gray-300 leading-none mt-1">—</p>
            )}
          </div>
        </div>

        {/* Push Notifications */}
        {isPushSupported() && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono text-xs font-semibold text-gray-900">Push Notifications</p>
                <p className="font-mono text-[10px] text-gray-400 mt-0.5">
                  {pushStatus === 'subscribed' || getPermissionState() === 'granted'
                    ? 'You will be notified when a client is assigned to you'
                    : 'Enable to get notified when a client is assigned to you'
                  }
                </p>
              </div>
              {pushStatus === 'subscribed' || getPermissionState() === 'granted' ? (
                <span className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-200 font-mono text-xs font-semibold">
                  <Bell size={14} /> ACTIVE
                </span>
              ) : (
                <button
                  onClick={handleEnablePush}
                  disabled={pushStatus === 'subscribing'}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs font-semibold transition-all ${
                    pushStatus === 'error'
                      ? 'bg-red-50 text-red-500 border border-red-200'
                      : 'bg-indigo-500 text-white hover:bg-indigo-600 active:scale-[0.98]'
                  }`}
                >
                  {pushStatus === 'subscribing'
                    ? 'ENABLING...'
                    : pushStatus === 'error'
                    ? 'FAILED — TAP TO RETRY'
                    : <><BellOff size={14} /> ENABLE</>
                  }
                </button>
              )}
            </div>
          </div>
        )}

        {/* Services Rendered Today */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <p className="font-mono text-xs font-semibold text-gray-900">Services Today</p>
            <span className="font-mono text-[10px] text-gray-400 font-semibold">
              {completedToday.length} completed
            </span>
          </div>

          {completedToday.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <CheckCircle size={24} className="mx-auto text-gray-200 mb-2" />
              <p className="font-mono text-xs text-gray-400">No services completed yet today</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
              {completedToday.map((entry) => (
                <div key={entry.id} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {entry.services.map((s, i) => (
                        <span
                          key={`${s}-${i}`}
                          className="inline-block px-2 py-0.5 rounded-md bg-pink-50 border border-pink-100 font-mono text-[10px] text-pink-600 font-semibold"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono text-[10px] text-gray-400">
                        {entry.turnValue} turns
                      </span>
                      <span className="flex items-center gap-1 font-mono text-[10px] text-gray-300">
                        <Clock size={9} />
                        {formatTime(entry.completedAt)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
