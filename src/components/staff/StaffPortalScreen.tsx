import { useState, useMemo } from 'react';
import { LogOut, Bell, BellOff, CheckCircle, Clock } from 'lucide-react';
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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full ring-2 ring-white shadow"
              style={{ backgroundColor: manicurist.color }}
            />
            <div>
              <h1 className="font-bebas text-xl tracking-[1px] text-gray-900 leading-none">{manicurist.name}</h1>
              <span className={`font-mono text-[10px] font-semibold tracking-wider uppercase ${statusColor}`}>
                {statusLabel}
              </span>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 font-mono text-xs font-semibold transition-all"
          >
            <LogOut size={14} />
            LOGOUT
          </button>
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
                  Get notified when a client is assigned to you
                </p>
              </div>
              <button
                onClick={handleEnablePush}
                disabled={pushStatus === 'subscribing'}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs font-semibold transition-all ${
                  pushStatus === 'subscribed' || getPermissionState() === 'granted'
                    ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                    : pushStatus === 'error'
                    ? 'bg-red-50 text-red-500 border border-red-200'
                    : 'bg-indigo-500 text-white hover:bg-indigo-600 active:scale-[0.98]'
                }`}
              >
                {pushStatus === 'subscribed' || getPermissionState() === 'granted'
                  ? <><Bell size={14} /> ENABLED</>
                  : pushStatus === 'subscribing'
                  ? 'ENABLING...'
                  : pushStatus === 'error'
                  ? 'FAILED'
                  : <><BellOff size={14} /> ENABLE</>
                }
              </button>
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
