import { useState, useRef, useEffect } from 'react';
import { Plus, LogIn, UserPlus } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import ManicuristCard from './ManicuristCard';

export default function ManicuristPanel() {
  const { state, dispatch } = useApp();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const clockedIn = state.manicurists.filter((m) => m.clockedIn);
  const notClockedIn = state.manicurists.filter((m) => !m.clockedIn);
  const total = clockedIn.length;
  const totalTurns = clockedIn.reduce((sum, m) => sum + m.totalTurns, 0);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setShowMenu(false);
      }
    }
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  function handleQuickClockIn(id: string) {
    dispatch({ type: 'CLOCK_IN', id });
    setShowMenu(false);
  }

  function handleNewManicurist() {
    setShowMenu(false);
    dispatch({ type: 'SET_MODAL', modal: 'addStaff' });
  }

  const turnOrder = clockedIn
    .filter((m) => m.status === 'available')
    .sort((a, b) => {
      if (Math.floor(a.totalTurns) !== Math.floor(b.totalTurns)) return Math.floor(a.totalTurns) - Math.floor(b.totalTurns);
      const aTime = a.clockInTime ?? Infinity;
      const bTime = b.clockInTime ?? Infinity;
      return aTime - bTime;
    });

  const rankMap = new Map<string, number>();
  turnOrder.forEach((m, i) => rankMap.set(m.id, i + 1));

  const sortedClockedIn = [...clockedIn].sort((a, b) => {
    const rankA = rankMap.get(a.id) ?? Infinity;
    const rankB = rankMap.get(b.id) ?? Infinity;
    if (rankA !== rankB) return rankA - rankB;
    if (a.status === 'busy' && b.status !== 'busy') return -1;
    if (a.status !== 'busy' && b.status === 'busy') return 1;
    if (a.status === 'break' && b.status !== 'break') return 1;
    if (a.status !== 'break' && b.status === 'break') return -1;
    return 0;
  });

  const waxServiceNames = new Set(
    state.salonServices.filter((s) => s.category === 'Wax Services').map((s) => s.name)
  );

  function getClientForManicurist(clientId: string | null) {
    if (!clientId) return null;
    return state.queue.find((c) => c.id === clientId) ?? null;
  }

  function clientHasWaxService(clientId: string | null): boolean {
    if (!clientId) return false;
    const client = state.queue.find((c) => c.id === clientId);
    if (!client) return false;
    return client.services.some((s) => waxServiceNames.has(s));
  }

  function getClientDurationMs(clientId: string | null, manicurist?: typeof state.manicurists[0]): number {
    if (!clientId) return 0;
    const client = state.queue.find((c) => c.id === clientId);
    if (!client) return 0;
    const adj = manicurist?.timeAdjustments || {};
    return client.services.reduce((sum, svcName) => {
      const svc = state.salonServices.find((s) => s.name === svcName);
      const baseDuration = svc?.duration ?? 30;
      const adjustment = adj[svcName] || 0;
      return sum + Math.max(baseDuration + adjustment, 5);
    }, 0) * 60000;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="font-bebas text-lg tracking-[2px] text-gray-900">MANICURISTS</h2>
          <span className="font-mono text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
            {total} clocked in
          </span>
          {total > 0 && (
            <span className="font-mono text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">
              {totalTurns.toFixed(1)} turns
            </span>
          )}
        </div>
        <div className="relative">
          <button
            ref={buttonRef}
            onClick={() => setShowMenu(!showMenu)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs font-semibold active:scale-[0.98] transition-all ${
              showMenu
                ? 'bg-pink-600 text-white'
                : 'bg-pink-500 text-white hover:bg-pink-600'
            }`}
          >
            <Plus size={13} className={`transition-transform duration-200 ${showMenu ? 'rotate-45' : ''}`} />
            ADD MANICURISTS
          </button>

          {showMenu && (
            <div
              ref={menuRef}
              className="absolute right-0 top-full mt-2 w-64 bg-white rounded-xl border border-gray-200 shadow-xl shadow-gray-200/50 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150"
            >
              {notClockedIn.length > 0 && (
                <div>
                  <div className="px-3 pt-3 pb-1.5">
                    <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider">CLOCK IN</p>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {notClockedIn.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => handleQuickClockIn(m.id)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors text-left group"
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bebas text-sm shrink-0"
                          style={{ backgroundColor: m.color }}
                        >
                          {m.name.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-mono text-xs font-semibold text-gray-800 truncate">{m.name}</p>
                          <p className="font-mono text-[10px] text-gray-400 truncate">
                            {m.skills.slice(0, 2).join(', ')}
                            {m.skills.length > 2 && ` +${m.skills.length - 2}`}
                          </p>
                        </div>
                        <LogIn size={14} className="text-gray-300 group-hover:text-emerald-500 transition-colors shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {notClockedIn.length > 0 && (
                <div className="border-t border-gray-100" />
              )}

              <button
                onClick={handleNewManicurist}
                className="w-full flex items-center gap-3 px-3 py-3 hover:bg-pink-50 transition-colors text-left group"
              >
                <div className="w-8 h-8 rounded-lg bg-pink-100 flex items-center justify-center shrink-0">
                  <UserPlus size={14} className="text-pink-500" />
                </div>
                <p className="font-mono text-xs font-semibold text-pink-600">New Manicurist</p>
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {total === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-16 px-4">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
              <Plus size={20} className="text-gray-400" />
            </div>
            <p className="font-mono text-sm text-gray-500 font-semibold mb-1">No one clocked in</p>
            <p className="font-mono text-[11px] text-gray-400">
              Tap + ADD to clock in staff or add a new manicurist
            </p>
          </div>
        ) : (
          <div className="p-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
            {sortedClockedIn.map((m, idx) => {
              const rank = rankMap.get(m.id) ?? null;
              return (
                <ManicuristCard
                  key={m.id}
                  manicurist={m}
                  currentClient={getClientForManicurist(m.currentClient)}
                  clientHasWax={clientHasWaxService(m.currentClient)}
                  clientDurationMs={getClientDurationMs(m.currentClient, m)}
                  isFirst={idx === 0}
                  isLast={idx === sortedClockedIn.length - 1}
                  turnRank={rank}
                  totalRanked={turnOrder.length}

                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
