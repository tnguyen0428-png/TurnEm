import type { Manicurist, QueueEntry, SalonService, ServiceType } from '../types';
import { getPriorityRank } from './priorityStorage';
import { getAlmostDoneMs } from '../components/modals/assignHelpers';

function getServicePriorityOrder(service: string, salonServices: SalonService[]): number {
  const svc = salonServices.find((s) => s.name === service);
  if (!svc) return Infinity;
  const allCats = Array.from(new Set(salonServices.map((s) => s.category).filter(Boolean)));
  return getPriorityRank(svc.name, svc.category, allCats);
}

function getServicesPrioritySorted(
  services: ServiceType[],
  salonServices: SalonService[]
): ServiceType[] {
  return [...services].sort(
    (a, b) => getServicePriorityOrder(a, salonServices) - getServicePriorityOrder(b, salonServices)
  );
}

export function isFourthPositionSpecialService(
  services: ServiceType[],
  salonServices: SalonService[]
): boolean {
  return services.some((s) => {
    const svc = salonServices.find((sv) => sv.name === s);
    return svc?.isFourthPositionSpecial === true;
  });
}

export function getEligibleManicurists(
  services: ServiceType[],
  manicurists: Manicurist[],
  salonServices: SalonService[] = [],
  queue: QueueEntry[] = []
): (Manicurist & { _almostDone?: boolean })[] {
  const prioritized = salonServices.length > 0
    ? getServicesPrioritySorted(services, salonServices)
    : services;

  const available = manicurists
    .filter((m) => m.clockedIn)
    .filter((m) => m.status === 'available')
    .filter((m) => prioritized.some((s) => m.skills.includes(s)))
    .map((m) => ({ ...m, _almostDone: false }));

  const almostDone = queue.length > 0
    ? manicurists
        .filter((m) => m.clockedIn && m.status === 'busy')
        .filter((m) => prioritized.some((s) => m.skills.includes(s)))
        .filter((m) => getAlmostDoneMs(m, queue, salonServices) !== null)
        .map((m) => ({ ...m, _almostDone: true }))
    : [];

  const combined = [...available, ...almostDone];

  const highestPriorityService = prioritized[0];
  const multiService = prioritized.length > 1;

  return combined.sort((a, b) => {
    if (multiService && highestPriorityService) {
      const aHasTop = a.skills.includes(highestPriorityService) ? 0 : 1;
      const bHasTop = b.skills.includes(highestPriorityService) ? 0 : 1;
      if (aHasTop !== bHasTop) return aHasTop - bHasTop;
    }
    const aFloor = Math.floor(a.totalTurns);
    const bFloor = Math.floor(b.totalTurns);
    if (aFloor !== bFloor) return aFloor - bFloor;
    const aTime = a.clockInTime ?? Infinity;
    const bTime = b.clockInTime ?? Infinity;
    return aTime - bTime;
  });
}

export function getSuggestedManicurist(
  services: ServiceType[],
  manicurists: Manicurist[],
  salonServices: SalonService[],
  excludeIds: Set<string> = new Set()
): Manicurist | null {
  const eligible = getEligibleManicurists(services, manicurists, salonServices).filter(
    (m) => !excludeIds.has(m.id)
  );
  if (eligible.length === 0) return null;

  const is4th = isFourthPositionSpecialService(services, salonServices);
  if (is4th) {
    return eligible[3] ?? eligible[eligible.length - 1];
  }
  return eligible[0];
}


export function getPriorityQueue(
  queue: QueueEntry[],
  manicurists: Manicurist[],
  salonServices: SalonService[] = []
): (QueueEntry & { suggestedManicurist: Manicurist | null; isDeferred: boolean })[] {
  const waiting = queue.filter((c) => c.status === 'waiting');

  function hasRequestedManicurist(c: QueueEntry): boolean {
    return (c.serviceRequests || []).some(r => r.manicuristIds && r.manicuristIds.length > 0);
  }

  // A "deferred" entry is waiting for a specific manicurist who is currently busy
  function isDeferredWaiting(c: QueueEntry): boolean {
    if (!c.requestedManicuristId) return false;
    const m = manicurists.find((x) => x.id === c.requestedManicuristId);
    return !!m && m.status === 'busy';
  }

  const sorted = [...waiting].sort((a, b) => {
    // 1. Deferred "waiting for busy staff" entries always first
    const aDeferred = isDeferredWaiting(a);
    const bDeferred = isDeferredWaiting(b);
    if (aDeferred !== bDeferred) return aDeferred ? -1 : 1;
    // 2. Appointments next
    if (a.isAppointment !== b.isAppointment) return a.isAppointment ? -1 : 1;
    // 3. Requested clients before non-requested
    const aReq = hasRequestedManicurist(a);
    const bReq = hasRequestedManicurist(b);
    if (aReq !== bReq) return aReq ? -1 : 1;
    // 4. Within each tier: earliest arrival first
    return a.arrivedAt - b.arrivedAt;
  });

  const claimed = new Set<string>();
  return sorted.map((client) => {
    const suggestion = getSuggestedManicurist(client.services, manicurists, salonServices, claimed);
    if (suggestion) claimed.add(suggestion.id);
    return { ...client, suggestedManicurist: suggestion, isDeferred: isDeferredWaiting(client) };
  });
}
