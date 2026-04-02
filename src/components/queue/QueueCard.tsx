import { UserPlus, Pencil, X, Clock } from 'lucide-react';
import type { QueueEntry, Manicurist, SalonService } from '../../types';
import Badge from '../shared/Badge';
import { formatWaitTime, formatTime } from '../../utils/time';

interface QueueCardProps {
  client: QueueEntry;
  rank: number;
  isNext?: boolean;
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

function getTurnBadgeVariant(value: number): 'green' | 'blue' | 'amber' {
  if (value <= 0.5) return 'green';
  if (value <= 1.0) return 'blue';
  return 'amber';
}

export default function QueueCard({ client, rank, isNext = false, manicurists, salonServices, onAssign, onEdit, onRemove }: QueueCardProps) {
  const requestedServices = (client.serviceRequests || []).filter((r) => r.manicuristIds && r.manicuristIds.length > 0);

  function getManicuristName(id: string) {
    const m = manicurists.find((x) => x.id === id);
    return m ? m.name : '?';
  }

  return (
    <div className={`group rounded-xl border p-4 hover:shadow-md transition-all duration-200 ${
      isNext
        ? 'bg-emerald-50/60 border-emerald-300 hover:border-emerald-400 shadow-sm'
        : 'bg-white border-gray-100 hover:border-pink-200'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isNext ? 'bg-emerald-100' : 'bg-gray-50'
        }`}>
          <span className={`font-bebas text-lg ${isNext ? 'text-emerald-600' : 'text-gray-400'}`}>#{rank}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-mono text-sm font-semibold text-gray-900 truncate">
              {client.clientName}
            </h3>
            {isNext && <Badge label="NEXT" variant="green" />}
            {client.isAppointment && <Badge label="APPT" variant="blue" />}
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
            <span className="flex items-center gap-1 text-[10px] font-mono text-gray-400">
              <Clock size={10} />
              {formatWaitTime(client.arrivedAt)}
            </span>
            <span className="text-[10px] font-mono text-gray-300">
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
