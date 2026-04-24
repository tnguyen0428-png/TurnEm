import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { LogOut, Bell, BellOff, CheckCircle, Clock, Volume2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { supabase } from '../../lib/supabase';
import { subscribeToPush, isPushSupported, getPermissionState } from '../../utils/pushNotifications';
import { formatTime, getTodayLA, getLocalDateStr } from '../../utils/time';
import type { Manicurist, CompletedEntry } from '../../types';

interface StaffPortalScreenProps {
  manicurist: Manicurist;
  onLogout: () => void;
}

export default function StaffPortalScreen({ manicurist: initialManicurist, onLogout }: StaffPortalScreenProps) {
  const { state, dispatch } = useApp();
  const [pushStatus, setPushStatus] = useState<'idle' | 'subscribing' | 'subscribed' | 'error'>('idle');
  const [selectedDate, setSelectedDate] = useState<string>(getTodayLA());
  const [historyEntries, setHistoryEntries] = useState<CompletedEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const todayStr = getTodayLA();
  const isToday = selectedDate === todayStr;

  useEffect(() => {
    if (isToday) { setHistoryEntries([]); return; }
    setHistoryLoading(true);
    supabase
      .from('daily_history')
      .select('entries')
      .eq('date', selectedDate)
      .maybeSingle()
      .then(({ data }) => {
        const entries: CompletedEntry[] = (data?.entries || [])
          .filter((e: CompletedEntry) => e.manicuristId === initialManicurist.id)
          .sort((a: CompletedEntry, b: CompletedEntry) => b.completedAt - a.completedAt);
        setHistoryEntries(entries);
        setHistoryLoading(false);
      });
  }, [selectedDate, isToday, initialManicurist.id]);

  function shiftDate(days: number) {
    const d = new Date(selectedDate + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const next = getLocalDateStr(d);
    if (next <= todayStr) setSelectedDate(next);
  }

  function formatDateLabel(dateStr: string): string {
    if (dateStr === todayStr) return 'Today';
    const yesterday = getLocalDateStr(new Date(new Date().setDate(new Date().getDate() - 1)));
    if (dateStr === yesterday) return 'Yesterday';
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  // Poll Supabase every 3s for live data (staff mode sync-back is disabled in AppContext)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [{ data: staffRows, error: staffErr }, { data: queueRows, error: queueErr }, { data: completedRows }] = await Promise.all([
          supabase.from('manicurists').select('*'),
          supabase.from('queue_entries').select('*'),
          supabase.from('completed_services').select('*'),
        ]);
        if (staffErr || queueErr) {
          console.error('[staff poll] DB error:', staffErr?.message || queueErr?.message);
          return;
        }
        if (staffRows && queueRows) {
          dispatch({
            type: 'LOAD_STATE',
            state: {
              manicurists: staffRows.map((r: any) => ({
                id: r.id, name: r.name, color: r.color, phone: r.phone || '',
                skills: r.skills || [], clockedIn: r.clocked_in,
                clockInTime: r.clock_in_time ? new Date(r.clock_in_time).getTime() : null,
                totalTurns: Number(r.total_turns) || 0,
                currentClient: r.current_client_id || null,
                status: r.status || 'available',
                hasFourthPositionSpecial: r.has_fourth_position_special || false,
                hasCheck2: r.has_check2 || false, hasCheck3: r.has_check3 || false,
                hasWax: r.has_wax || false, hasWax2: r.has_wax2 || false, hasWax3: r.has_wax3 || false,
                timeAdjustments: r.time_adjustments || {}, pinCode: r.pin_code || '',
                breakStartTime: r.break_start_time ? new Date(r.break_start_time).getTime() : null,
                smsOptIn: r.sms_opt_in || false,
              })),
              queue: queueRows.map((r: any) => ({
                id: r.id, clientName: r.client_name,
                services: r.services || [],
                arrivedAt: new Date(r.arrived_at).getTime(),
                status: r.status || 'waiting',
                assignedManicuristId: r.assigned_manicurist_id || null,
                startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
                completedAt: r.completed_at ? new Date(r.completed_at).getTime() : null,
                turnValue: Number(r.turn_value) || 0,
                serviceRequests: r.service_requests || [],
                requestedManicuristId: r.requested_manicurist_id || null,
                isRequested: r.is_requested || false,
                isAppointment: r.is_appointment || false,
                extraTimeMs: Number(r.extra_time_ms) || 0,
              })),
              completed: (completedRows || []).map((r: any) => ({
                id: r.id, clientName: r.client_name || '',
                services: r.services || [], manicuristId: r.manicurist_id || '',
                manicuristName: r.manicurist_name || '',
                manicuristColor: r.manicurist_color || '',
                startedAt: r.started_at ? new Date(r.started_at).getTime() : Date.now(),
                completedAt: new Date(r.completed_at).getTime(),
                turnValue: Number(r.turn_value) || 0,
                requestedServices: r.requested_services || [],
              })),
            },
          });
        }
      } catch (e) {
        console.error('[staff poll] error:', e);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [dispatch]);

  // Get live data for this manicurist from state
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
  const [audioReady, setAudioReady] = useState(false);
  const prevStatusRef = useRef(manicurist.status);
  const prevQueuePosRef = useRef(queuePosition);
  const audioContextRef = useRef<AudioContext | null>(null);
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep AudioContext alive on iOS by playing a silent tone every 15 seconds.
  // iOS suspends AudioContext after ~30s of silence, which blocks alert sounds.
  const startKeepalive = useCallback(() => {
    if (keepaliveRef.current) return; // already running
    keepaliveRef.current = setInterval(() => {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== 'running') return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.001; // inaudible
        osc.frequency.value = 1;
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.05);
      } catch (_) { /* ignore */ }
    }, 15000);
  }, []);

  // Cleanup keepalive on unmount
  useEffect(() => {
    return () => {
      if (keepaliveRef.current) clearInterval(keepaliveRef.current);
    };
  }, []);

  const playAssignedSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime;

      // Urgent bright chime — "YOUR TURN!" — plays twice
      const playChime = (offset: number) => {
        const notes = [
          { freq: 784, time: 0, dur: 0.12 },     // G5
          { freq: 988, time: 0.12, dur: 0.12 },   // B5
          { freq: 1175, time: 0.24, dur: 0.15 },  // D6
          { freq: 1568, time: 0.40, dur: 0.25 },  // G6 (hold)
          { freq: 1175, time: 0.70, dur: 0.10 },  // D6
          { freq: 1568, time: 0.82, dur: 0.35 },  // G6 (hold longer)
        ];
        for (const n of notes) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = n.freq;
          osc.type = 'sine';
          gain.gain.setValueAtTime(0, t + offset + n.time);
          gain.gain.linearRampToValueAtTime(0.3, t + offset + n.time + 0.02);
          gain.gain.linearRampToValueAtTime(0, t + offset + n.time + n.dur);
          osc.start(t + offset + n.time);
          osc.stop(t + offset + n.time + n.dur + 0.01);
        }
      };
      playChime(0);
      playChime(1.4);
      playChime(2.8);
    } catch (e) {
      console.log('Audio alert failed:', e);
    }
  }, [soundEnabled]);

  const playNextUpSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime;

      // Gentle rising arpeggio — "YOU'RE NEXT" — softer, plays twice
      const playArp = (offset: number) => {
        const notes = [
          { freq: 523, time: 0, dur: 0.20 },     // C5
          { freq: 659, time: 0.20, dur: 0.20 },   // E5
          { freq: 784, time: 0.40, dur: 0.20 },   // G5
          { freq: 1047, time: 0.60, dur: 0.45 },  // C6 (hold)
        ];
        for (const n of notes) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = n.freq;
          osc.type = 'triangle';
          gain.gain.setValueAtTime(0, t + offset + n.time);
          gain.gain.linearRampToValueAtTime(0.2, t + offset + n.time + 0.03);
          gain.gain.linearRampToValueAtTime(0, t + offset + n.time + n.dur);
          osc.start(t + offset + n.time);
          osc.stop(t + offset + n.time + n.dur + 0.01);
        }
      };
      playArp(0);
      playArp(1.3);
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
      playAssignedSound();
    }
    prevStatusRef.current = manicurist.status;
  }, [manicurist.status, manicurist.currentClient, state.queue, playAssignedSound]);

  // Detect becoming next up (queue position changed to 1)
  useEffect(() => {
    if (prevQueuePosRef.current !== 1 && queuePosition === 1) {
      setAlert({ type: 'nextup' });
      playNextUpSound();
    }
    prevQueuePosRef.current = queuePosition;
  }, [queuePosition, playNextUpSound]);

  // Auto-dismiss alert after 30 seconds
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(null), 30000);
    return () => clearTimeout(timer);
  }, [alert]);

  // Activate AudioContext on first tap (iOS requires user gesture) and start keepalive
  function handleScreenTap() {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        setAudioReady(true);
        startKeepalive();
        // Play a tiny confirmation blip so we know audio is working
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          gain.gain.value = 0.05;
          osc.frequency.value = 600;
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.05);
        } catch (_) { /* ignore */ }
      });
    } else if (ctx.state === 'running' && !audioReady) {
      setAudioReady(true);
      startKeepalive();
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
        {/* Audio activation banner — shows until user taps to activate */}
        {!audioReady && soundEnabled && (
          <button
            onClick={handleScreenTap}
            className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 text-white rounded-2xl p-4 text-center shadow-md active:scale-[0.98] transition-transform"
          >
            <Volume2 size={28} className="mx-auto mb-2" />
            <p className="font-bebas text-2xl tracking-[2px]">TAP TO ACTIVATE SOUND</p>
            <p className="font-mono text-[10px] text-white/70 mt-1">Required for alert sounds on iPhone</p>
          </button>
        )}
        {audioReady && soundEnabled && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-2 text-center">
            <p className="font-mono text-[10px] text-emerald-600 font-semibold">SOUND ACTIVE — alerts will play automatically</p>
          </div>
        )}
        {manicurist.phone && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-2 flex items-center justify-between">
            <p className="font-mono text-[10px] text-gray-500 font-semibold">
              SMS ALERTS — {manicurist.smsOptIn ? 'you will receive a text when assigned' : 'tap to enable text notifications'}
            </p>
            <button
              onClick={async () => {
                const newVal = !manicurist.smsOptIn;
                await supabase.from('manicurists').update({ sms_opt_in: newVal }).eq('id', manicurist.id);
                dispatch({ type: 'UPDATE_MANICURIST', id: manicurist.id, updates: { smsOptIn: newVal } });
              }}
              className={`ml-3 shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none ${
                manicurist.smsOptIn ? 'bg-emerald-500' : 'bg-gray-300'
              }`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-200 ${
                manicurist.smsOptIn ? 'translate-x-5' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
        )}

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

        {/* Services History */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          {/* Header with date navigation */}
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs font-semibold text-gray-900">Services</p>
              <span className="font-mono text-[10px] text-gray-400 font-semibold">
                {isToday ? completedToday.length : historyEntries.length} completed
              </span>
            </div>
            <div className="flex items-center justify-between mt-2">
              <button
                onClick={() => shiftDate(-1)}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold text-gray-700">
                  {formatDateLabel(selectedDate)}
                </span>
                {!isToday && (
                  <button
                    onClick={() => setSelectedDate(todayStr)}
                    className="px-2 py-0.5 rounded-md bg-pink-100 text-pink-600 font-mono text-[10px] font-semibold hover:bg-pink-200 transition-colors"
                  >
                    Today
                  </button>
                )}
              </div>
              <button
                onClick={() => shiftDate(1)}
                disabled={isToday}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Entries */}
          {historyLoading ? (
            <div className="px-4 py-8 text-center">
              <p className="font-mono text-xs text-gray-400">Loading...</p>
            </div>
          ) : (() => {
            const entries = isToday ? completedToday : historyEntries;
            if (entries.length === 0) {
              return (
                <div className="px-4 py-8 text-center">
                  <CheckCircle size={24} className="mx-auto text-gray-200 mb-2" />
                  <p className="font-mono text-xs text-gray-400">
                    {isToday ? 'No services completed yet today' : 'No services recorded for this day'}
                  </p>
                </div>
              );
            }
            return (
              <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
                {entries.map((entry) => (
                  <div key={entry.id} className="px-4 py-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {entry.services.map((s, i) => {
                          const isRequested = entry.requestedServices?.includes(s);
                          return (
                            <span key={`${s}-${i}`} className="inline-flex items-center gap-1">
                              <span className="inline-block px-2 py-0.5 rounded-md bg-pink-50 border border-pink-100 font-mono text-[10px] text-pink-600 font-semibold">
                                {s}
                              </span>
                              {isRequested && (
                                <span className="font-mono text-[9px] font-bold bg-purple-500 text-white rounded px-1 py-0.5 leading-none">
                                  R
                                </span>
                              )}
                            </span>
                          );
                        })}
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
            );
          })()}
        </div>
      </div>
    </div>
  );
}
