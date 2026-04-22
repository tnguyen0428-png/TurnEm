import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { LogOut, Bell, CheckCircle, Clock, Volume2, VolumeX } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { supabase } from '../../lib/supabase';
import { formatTime } from '../../utils/time';
import type { Manicurist } from '../../types';

interface StaffPortalScreenProps {
  manicurist: Manicurist;
  onLogout: () => void;
}

export default function StaffPortalScreen({ manicurist: initialManicurist, onLogout }: StaffPortalScreenProps) {
  const { state, dispatch } = useApp();

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
                isAppointment: !!r.is_appointment,
                isRequested: !!r.is_requested,
              })),
            },
          });
        }
      } catch {
        // swallow polling errors silently — staff UI stays clean
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

  // Activate AudioContext on any tap (iOS requires user gesture) and start keepalive
  function handleScreenTap() {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        startKeepalive();
      });
    } else if (ctx.state === 'running') {
      startKeepalive();
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
        <div className="max-w-lg mx-auto px-4 py-3">
          {/* Top row: logo left (1/3 width), manicurist name right */}
          <div className="flex items-center mb-3">
            <img
              src="/Turn_Em_Logo.jpg"
              alt="TurnEM"
              className="w-1/3 h-auto object-contain"
            />
            <div className="flex-1 flex items-center justify-end gap-2">
              <div
                className="w-3.5 h-3.5 rounded-full ring-2 ring-white shadow"
                style={{ backgroundColor: manicurist.color }}
              />
              <h1 className="font-bebas text-2xl tracking-[1px] text-gray-900 leading-none">{manicurist.name}</h1>
            </div>
          </div>
          {/* Bottom row: sound toggle + logout */}
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleScreenTap();
                setSoundEnabled(!soundEnabled);
              }}
              className={`flex items-center gap-1 px-2.5 py-2 rounded-lg border font-mono text-xs font-semibold transition-all ${
                soundEnabled
                  ? 'border-emerald-200 text-emerald-600 bg-emerald-50'
                  : 'border-gray-200 text-gray-400 bg-gray-50'
              }`}
            >
              {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
              {soundEnabled ? 'SOUND ON' : 'SOUND OFF'}
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
          <div className="bg-white rounded-2xl border border-gray-100 p-3 text-center shadow-sm">
            <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider uppercase mb-1">TOTAL TURNS</p>
            <p className="font-bebas text-2xl text-gray-900 leading-none">{manicurist.totalTurns.toFixed(1)}</p>
          </div>

          {/* Queue Position */}
          <div className="bg-white rounded-2xl border border-gray-100 p-3 text-center shadow-sm">
            <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider uppercase mb-1">QUEUE POSITION</p>
            {manicurist.status === 'busy' ? (
              <p className="font-bebas text-xl text-red-500 leading-none mt-1">BUSY</p>
            ) : manicurist.status === 'break' ? (
              <p className="font-bebas text-xl text-amber-500 leading-none mt-1">BREAK</p>
            ) : !manicurist.clockedIn ? (
              <p className="font-bebas text-xl text-gray-300 leading-none mt-1">OFF</p>
            ) : queuePosition ? (
              <>
                <p className="font-bebas text-2xl text-gray-900 leading-none">#{queuePosition}</p>
                <p className={`font-mono text-[10px] font-semibold tracking-wider uppercase mt-1 ${statusColor}`}>
                  {statusLabel}
                </p>
              </>
            ) : (
              <p className="font-bebas text-xl text-gray-300 leading-none mt-1">—</p>
            )}
          </div>
        </div>

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
              {completedToday.map((entry) => {
                const requested = new Set(entry.requestedServices || []);
                const hasRequest = !!entry.isRequested || requested.size > 0;
                const isAppt = !!entry.isAppointment;
                return (
                  <div key={entry.id} className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      {/* R badge column — reserved width so rows align whether or not a request exists */}
                      <div className="w-6 shrink-0 pt-0.5 flex justify-center">
                        {hasRequest && (
                          <span
                            className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-red-500 text-white font-mono text-[10px] font-bold leading-none"
                            title="Requested service"
                          >
                            R
                          </span>
                        )}
                      </div>
                      {/* Client + services + meta */}
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-xs font-bold text-gray-900 truncate mb-1">
                          {entry.clientName || 'Walk-in'}
                        </p>
                        <div className="flex items-center gap-1 flex-wrap mb-1.5">
                          {entry.services.map((s, i) => {
                            const serviceRequested = requested.has(s) || (!!entry.isRequested && !isAppt);
                            // Color precedence: requested (red) > appointment (blue) > walk-in (pink)
                            const chipClass = serviceRequested
                              ? 'bg-red-50 border-red-200 text-red-600'
                              : isAppt
                                ? 'bg-blue-50 border-blue-200 text-blue-600'
                                : 'bg-pink-50 border-pink-100 text-pink-600';
                            return (
                              <span
                                key={`${s}-${i}`}
                                className={`inline-block px-2 py-0.5 rounded-md font-mono text-[10px] font-semibold border ${chipClass}`}
                              >
                                {s}
                              </span>
                            );
                          })}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-[11px] font-bold text-gray-900">
                            {entry.turnValue} turns
                          </span>
                          <span className="flex items-center gap-1 font-mono text-[10px] text-gray-400">
                            <Clock size={9} />
                            {formatTime(entry.completedAt)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
