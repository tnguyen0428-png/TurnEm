import { useState, useMemo } from 'react';
import { Clock, User, ChevronDown, CalendarDays, Pencil } from 'lucide-react';
import Badge, { getTurnBadgeVariant } from '../shared/Badge';
import type { CompletedEntry } from '../../types';

// The CLIENT / SERVICE / TURNS / MANICURIST table.
//
// Extracted out of HistoryScreen (2026-08-30) so the queue's CLOCK-IN LIST
// can show the same rows without importing the whole History screen — that
// screen is its own lazy chunk, and pulling it into the queue would drag
// ~25kB of calendar/edit-modal code into the default view. Shared rather than
// copied so the two can never drift: a row that reads one way in History must
// read the same way in the queue.

function groupServices(services: string[]): [string, number][] {
  const map = new Map<string, number>();
  for (const s of services) map.set(s, (map.get(s) || 0) + 1);
  return Array.from(map.entries());
}

type SortMode = 'time' | 'client' | 'manicurist';

// One row of the table. The pencil opens the edit modal where the user can
// change services / manicurist / turn value, mark a request, or void the row.
// Voided rows render grayed out with a strikethrough turn value.
function ServiceRow({
  entry,
  onEdit,
}: {
  entry: CompletedEntry;
  onEdit?: (entry: CompletedEntry) => void;
}) {
  const isVoided = !!entry.voided;
  const isEdited = !!entry.edited;
  // In-service rows are synthesized from the active queue so the history list
  // visibly reconciles with the per-manicurist turn totals (which already
  // count in-flight credits via m.totalTurns). Pencil/edit is suppressed —
  // editing an in-flight visit happens at the queue card / ticket modal, not
  // in history.
  const isInService = entry.completedAt === null;

  return (
    <tr
      className={`border-b border-gray-50 transition-colors ${
        isVoided ? 'bg-gray-50/40 hover:bg-pink-100/60' : 'hover:bg-pink-100/60'
      }`}
    >
      <td className={`px-4 py-3 font-mono text-xs font-semibold ${isVoided ? 'text-gray-400' : 'text-gray-900'}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <span>{entry.clientName}</span>
          {isInService && (
            <span className="font-mono text-[9px] font-bold text-emerald-700 bg-emerald-100 border border-emerald-200 rounded-full px-1.5 py-0.5 tracking-wider">
              IN SERVICE
            </span>
          )}
          {isVoided && (
            <span className="font-mono text-[9px] font-bold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-0.5 tracking-wider">
              VOID
            </span>
          )}
          {isEdited && !isVoided && !isInService && (
            <span className="font-mono text-[9px] font-bold text-sky-700 bg-sky-100 border border-sky-200 rounded-full px-1.5 py-0.5 tracking-wider">
              EDIT
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className={`flex items-center gap-1.5 flex-wrap ${isVoided ? 'opacity-60' : ''}`}>
          {groupServices(entry.services).map(([s, count]) => {
            const wasRequested =
              Array.isArray(entry.requestedServices) &&
              entry.requestedServices.length > 0 &&
              entry.requestedServices.includes(s as typeof entry.requestedServices[number]);
            return (
              <span key={s} className="inline-flex items-center gap-1">
                {wasRequested && (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white font-bold text-[9px]">
                    R
                  </span>
                )}
                <Badge
                  label={count > 1 ? `${s} x${count}` : s}
                  variant={getTurnBadgeVariant(entry.turnValue)}
                />
              </span>
            );
          })}
        </div>
      </td>
      <td className={`px-4 py-3 font-mono text-xs font-bold ${isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
        {entry.turnValue}
      </td>
      <td className="px-4 py-3">
        <span className={`flex items-center gap-2 ${isVoided ? 'opacity-60' : ''}`}>
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: entry.manicuristColor }}
          />
          <span className={`font-mono text-xs font-bold ${isVoided ? 'text-gray-400' : 'text-gray-900'}`}>
            {entry.manicuristName}
          </span>
        </span>
      </td>
      <td className="pr-3 pl-1 py-3 w-10 text-right">
        {onEdit && !isInService && (
          <button
            onClick={() => onEdit(entry)}
            type="button"
            aria-label="Edit service"
            className="p-1.5 rounded-lg text-gray-300 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          >
            <Pencil size={14} />
          </button>
        )}
      </td>
    </tr>
  );
}

interface HistoryTableProps {
  entries: CompletedEntry[];
  onEdit?: (entry: CompletedEntry) => void;
}

export default function HistoryTable({ entries, onEdit }: HistoryTableProps) {
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [manicuristFilter, setManicuristFilter] = useState<string>('all');

  const manicuristNames = useMemo(() => {
    const fromEntries = entries.map((c) => c.manicuristName);
    return Array.from(new Set(fromEntries)).sort();
  }, [entries]);

  const sortedEntries = useMemo(() => {
    let list = [...entries];
    if (manicuristFilter !== 'all') {
      list = list.filter((c) => c.manicuristName === manicuristFilter);
    }
    // In-progress entries have completedAt = null; fall back to startedAt so
    // they sort sensibly alongside finished work (with the in-progress entry
    // appearing as if "completed now" within the manicurist's section).
    const ts = (c: CompletedEntry) => c.completedAt ?? c.startedAt ?? 0;
    if (sortMode === 'time') {
      list.sort((a, b) => ts(b) - ts(a));
    } else if (sortMode === 'client') {
      list.sort((a, b) => a.clientName.localeCompare(b.clientName));
    } else {
      list.sort((a, b) => a.manicuristName.localeCompare(b.manicuristName) || ts(b) - ts(a));
    }
    return list;
  }, [entries, sortMode, manicuristFilter]);

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-gray-400 tracking-wider font-semibold">SORT</span>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {(['time', 'client', 'manicurist'] as SortMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setSortMode(mode)}
                className={`flex items-center gap-1 px-2.5 py-1.5 font-mono text-[10px] font-semibold transition-colors ${
                  sortMode === mode
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:bg-gray-50'
                }`}
              >
                {mode === 'time' && <Clock size={10} />}
                {mode === 'client' && <User size={10} />}
                {mode === 'manicurist' && <CalendarDays size={10} />}
                {mode.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {manicuristNames.length > 1 && (
          <div className="flex items-center gap-1.5 relative">
            <span className="font-mono text-[10px] text-gray-400 tracking-wider font-semibold">FILTER</span>
            <div className="relative">
              <select
                value={manicuristFilter}
                onChange={(e) => setManicuristFilter(e.target.value)}
                className="appearance-none pl-2.5 pr-7 py-1.5 rounded-lg border border-gray-200 font-mono text-[10px] font-semibold text-gray-700 bg-white focus:outline-none focus:border-gray-400 cursor-pointer"
              >
                <option value="all">ALL STAFF</option>
                {manicuristNames.map((n) => (
                  <option key={n} value={n}>{n.toUpperCase()}</option>
                ))}
              </select>
              <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </div>
        )}
        <span className="ml-auto font-mono text-[10px] text-gray-400">{sortedEntries.length} entries</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">CLIENT</th>
              <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">SERVICE</th>
              <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">TURNS</th>
              <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">MANICURIST</th>
              <th className="w-10" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => (
              <ServiceRow
                key={entry.id}
                entry={entry}
                onEdit={onEdit}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
