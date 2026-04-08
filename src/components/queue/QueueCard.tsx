import { UserPlus, Pencil, X, Clock, Timer } from 'lucide-react';
import type { QueueEntry, Manicurist, SalonService } from '../../types';
import Badge from '../shared/Badge';
import { formatWaitTime, formatTime } from '../../utils/time';

interface QueueCardProps {
  client: QueueEntry;
  rank: number;
  isNext?: boolean;
  isDeferred?: boolean;
  manicurists: Manicurist[];
  salonServices: SalonService[];
  onAssign: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function groupServices(services: string[], salonServices: SalonService[]): [string, number][] {
  const orderMap = new Map(salonServices.map((s) => [s.name, s.sortOrder]));
  const map = new Map<string, number>();
  for (const s of services) map.set(s, (map.get(s) || 0) + 1);
  return Array.from(map.entries()).sort(
    (a, b) => (orderMap.get(a[0]) ?? Infinity) - (orderMap.get(b[0]) ?? Infinity)
  );
}

function getTurnBadgeVariant(value: number): 'green' | 'blue' | 'amber' | 'orange' | 'purple' | 'red' {
  if (value <= 0.5) return 'green';
  if (value <= 1.0) return 'blue';
  if (value <= 1.5) return 'amber';
  if (value <= 2.0) return 'orange';
  if (value <= 2.5) return 'purple';
  return 'red';
}

export default function QueueCard({ client, rank, isNext = false, isDeferred = false, manicurists, salonServices, onAssign, onEdit, onRemove }: QueueCardProps) {
  const requestedServices = (client.serviceRequests || []).filter((r) => r.manicuristIds && r.manicuristIds.length > 0);

  function getManicuristName(id: string) {
    const m = manicurists.find((x) => x.id === id);
    return m ? m.name : '?';
  }

  const isAppt = client.isAppointment;

  // Distinct requested manicurist IDs from serviceRequests
  const requestedManicuristIds = [...new Set(
    (client.serviceRequests || []).flatMap(r => r.manicuristIds || [])
  )];
  const hasRequested = requestedManicuristIds.length > 0;

  return (
    <div
      className={`group rounded-xl border p-4 hover:shadow-md transition-all duration-200 ${
        isDeferred
          ? 'bg-amber-50 border-amber-400 hover:border-amber-500 shadow-sm'
          : isAppt
          ? ''
          : hasRequested
          ? 'bg-purple-50/50 border-purple-300 hover:border-purple-400 shadow-sm'
          : isNext
            ? 'bg-emerald-50/60 border-emerald-300 hover:border-emerald-400 shadow-sm'
            : 'bg-rose-50/50 border-rose-200 hover:border-rose-300 shadow-sm'
      }`}
      style={isAppt && !isDeferred ? { background: '#e6f1fb', border: '0.5px solid #85b7eb' } : undefined}
    >
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isNext ? 'bg-emerald-100' : 'bg-gray-50'
        }`}>
          <span className={`font-bebas text-lg ${isNext ? 'text-emerald-600' : 'text-gray-400'}`}>#{rank}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3
              className={`font-mono text-sm font-semibold truncate ${isAppt ? '' : 'text-gray-900'}`}
              style={isAppt ? { color: '#0c447c' } : undefined}
            >
              {client.clientName}
            </h3>
            {isNext && <Badge label="NEXT" variant="green" />}
            {requestedManicuristIds.map(id => {
              const m = manicurists.find(x => x.id === id);
              if (!m) return null;
              const isReady = isDeferred && m.status === 'available';
              return isReady ? (
                <span key={id} className="inline-flex items-center gap-1 rounded font-mono font-bold tracking-wide uppercase text-[9px] px-2 py-0.5 bg-amber-500 text-white animate-pulse">
                  <Timer size={9} />
                  ASSIGN TO {m.name} NOW
                </span>
              ) : (
                <span key={id} className={`inline-flex items-center rounded font-mono font-bold tracking-wide uppercase text-[9px] px-2 py-0.5 ${isDeferred ? 'bg-amber-400 text-white' : 'bg-purple-500 text-white'}`}>
                  WAITING FOR {m.name}
                </span>
              );
            })}
            {isAppt && (
              <span
                className="inline-flex items-center rounded-full font-mono font-semibold tracking-wide uppercase text-[10px] px-2 py-0.5"
                style={{ background: '#378add', color: 'white' }}
              >
                APPT
              </span>
            )}
            {client.isRequested && <Badge label="REQ" variant="pink" />}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {groupServices(client.services, salonServices).map(([s, count]) => (
              <Badge
                key={s}
                label={count > 1 ? `${s} x${count}` : s}
                variant={getTurnBadgeVariant(client.turnValue)}
              />
            ))}
            <Badge
              label={`${client.turnValue} turns`}
              variant={getTurnBadgeVariant(client.turnValue)}
            />
            <span
              className={`flex items-center gap-1 text-[10px] font-mono ${isAppt ? '' : 'text-gray-400'}`}
              style={isAppt ? { color: '#185fa5' } : undefined}
            >
              <Clock size={10} />
              {formatWaitTime(client.arrivedAt)}
            </span>
            <span
              className={`text-[10px] font-mono ${isAppt ? '' : 'text-gray-300'}`}
              style={isAppt ? { color: '#185fa5' } : undefined}
            >
              {formatTime(client.arrivedAt)}
            </span>
          </div>
          {requestedServices.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {requestedServices.map((r, i) => (
                <span
                  key={`${r.service}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-pink-50 border border-pink-100 font-mono text-[10px] text-pink-600"
                >
                  {r.service} &rarr; {r.manicuristIds.map((id) => getManicuristName(id)).join(', ')}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="p-1.5 rounded-lg bg-blue-50 text-blue-500 hover:bg-blue-100 transition-colors"
            title="Edit"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={onAssign}
            className="p-1.5 rounded-lg bg-pink-50 text-pink-500 hover:bg-pink-100 transition-colors"
            title="Assign"
          >
            <UserPlus size={14} />
          </button>
          <button
            onClick={onRemove}
            className="p-1.5 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 transition-colors"
            title="Remove"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
