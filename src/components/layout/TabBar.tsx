import { ClipboardList, Clock, CalendarCheck, Settings2, LogOut, Receipt } from 'lucide-react';
import type { ViewType } from '../../types';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../state/AuthContext';

const TABS: { id: ViewType; label: string; icon: typeof ClipboardList }[] = [
  { id: 'queue',        label: 'QUEUE',     icon: ClipboardList },
  { id: 'appointments', label: 'APPTS',     icon: CalendarCheck },
  { id: 'register',     label: 'REGISTER',  icon: Receipt },
  { id: 'history',      label: 'HISTORY',   icon: Clock },
  { id: 'blueprint',    label: 'BLUEPRINT', icon: Settings2 },
];

const BLUEPRINT_VIEWS: ViewType[] = ['blueprint', 'staff', 'services', 'criteria', 'calendar'];

function useIsTabActive() {
  const { state } = useApp();
  return (id: ViewType) =>
    id === 'blueprint' ? BLUEPRINT_VIEWS.includes(state.view) : state.view === id;
}

// Layout by width:
//   phone  (< md)  — slim top bar (logo + logout); tabs live in MobileTabBar
//                    along the bottom, where a thumb can reach them.
//   tablet (md–xl) — mid-size logo with labelled tabs in the top bar (icon
//                    stacked over label below lg so all five fit an iPad in
//                    portrait). The old 288px logo pushed the tabs off the
//                    right edge of an iPad, and with the scrollbar hidden there
//                    was no sign they were there (Tony 2026-09-29).
//   desktop (xl+)  — the original large logo.
export default function TabBar() {
  const { dispatch } = useApp();
  const { user, signOut } = useAuth();
  const isActive = useIsTabActive();

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-3 md:px-6">
        <div className="flex items-center justify-between gap-2 h-14 md:h-24 xl:h-48">
          <div className="flex items-center flex-shrink-0 pointer-events-none select-none">
            <img
              src="/Turn_Em_Logo.png"
              alt="Turn Em"
              className="h-14 w-auto md:h-20 lg:h-24 xl:h-72 object-contain"
            />
          </div>
          {/* Centred via the inner mx-auto rather than justify-center, which
              would clip the first tab instead of scrolling if space ran out. */}
          <div className="hidden md:flex flex-1 min-w-0 overflow-x-auto hide-scrollbar">
            <div className="flex items-center gap-1 mx-auto">
            {TABS.map((tab) => {
              const active = isActive(tab.id);
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => dispatch({ type: 'SET_VIEW', view: tab.id })}
                  className={`flex flex-col lg:flex-row items-center gap-0.5 lg:gap-1.5 px-2.5 lg:px-3 py-2 lg:py-2.5 rounded-md font-bebas text-xs lg:text-sm xl:text-xs tracking-[1.2px] transition-all duration-200 whitespace-nowrap flex-shrink-0 ${
                    active
                      ? 'bg-pink-50 text-pink-600'
                      // hover:bg-gray-50 was too faint to register as a
                      // rollover (Tony 2026-08-30). Pink-tinted like the
                      // active state so the tab under the pointer clearly
                      // reads as "this is what you're about to open".
                      : 'text-gray-400 hover:text-pink-600 hover:bg-pink-100 hover:ring-1 hover:ring-pink-300 hover:ring-inset'
                  }`}
                >
                  <Icon size={16} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {user && (
              <span className="font-mono text-[10px] text-gray-400 hidden xl:block truncate max-w-[140px]">
                {user.email}
              </span>
            )}
            <button
              onClick={signOut}
              className="flex items-center gap-1 px-3 py-2 rounded-lg border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 font-mono text-[10px] font-semibold transition-all"
              title="Sign out"
            >
              <LogOut size={14} />
              <span className="md:hidden lg:inline">LOGOUT</span>
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}

// Phone-only bottom tab bar. Rendered as the last flex child of the app shell
// (not position:fixed) so it never covers the bottom of a screen's content.
export function MobileTabBar() {
  const { dispatch } = useApp();
  const isActive = useIsTabActive();

  return (
    <nav className="md:hidden flex-shrink-0 bg-white border-t border-gray-200 z-40">
      <div className="grid grid-cols-5">
        {TABS.map((tab) => {
          const active = isActive(tab.id);
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => dispatch({ type: 'SET_VIEW', view: tab.id })}
              className={`flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] font-bebas text-[11px] tracking-[1px] ${
                active ? 'text-pink-600 bg-pink-50' : 'text-gray-400'
              }`}
            >
              <Icon size={20} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
