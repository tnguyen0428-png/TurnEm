import type { Manicurist, QueueEntry, SalonService, ServiceType } from '../types';

function getServiceTurnValue(service: string, salonServices: SalonService[]): number {
  const svc = salonServices.find((s) => s.name === service);
  return svc?.turnValue ?? 0;
}

function getServiceSortOrder(service: string, salonServices: SalonService[]): number {
  const svc = salonServices.find((s) => s.name === service);
  return svc?.sortOrder ?? Infinity;
}

function getServicesPrioritySorted(
  services: ServiceType[],
  salonServices: SalonService[]
): ServiceType[] {
  return [...services].sort(
    (a, b) => getServiceSortOrder(a, salonServices) - getServiceSortOrder(b, salonServices)
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
  salonServices: SalonService[] = []
): Manicurist[] {
  const prioritized = salonServices.length > 0
    ? getServicesPrioritySorted(services, salonServices)
    : services;

  const available = manicurists
    .filter((m) => m.clockedIn)
    .filter((m) => m.status === 'available');

  const highestPriorityService = prioritized[0];
  const multiService = prioritized.length > 1;

  return available
    .filter((m) => prioritized.some((s) => m.skills.includes(s)))
    .sort((a, b) => {
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

function getHighestServiceTurnValue(
  services: ServiceType[],
  salonServices: SalonService[]
): number {
  let best = 0;
  for (const s of services) {
    const tv = getServiceTurnValue(s, salonServices);
    if (tv > best) best = tv;
  }
  return best;
}

function getLowestSortOrder(
  services: ServiceType[],
  salonServices: SalonService[]
): number {
  let best = Infinity;
  for (const s of services) {
    const svc = salonServices.find((sv) => sv.name === s);
    const order = svc?.sortOrder ?? Infinity;
    if (order < best) best = order;
  }
  return best;
}

export function getPriorityQueue(
  queue: QueueEntry[],
  manicurists: Manicurist[],
  salonServices: SalonService[] = []
): (QueueEntry & { suggestedManicurist: Manicurist | null })[] {
  const waiting = queue.filter((c) => c.status === 'waiting');

  function hasRequestedManicurist(c: QueueEntry): boolean {
    return (c.serviceRequests || []).some(r => r.manicuristIds && r.manicuristIds.length > 0);
  }

  const sorted = [...waiting].sort((a, b) => {
    // 1. Appointments always first
    if (a.isAppointment !== b.isAppointment) return a.isAppointment ? -1 : 1;
    // 2. Requested clients before non-requested
    const aReq = hasRequestedManicurist(a);
    const bReq = hasRequestedManicurist(b);
    if (aReq !== bReq) return aReq ? -1 : 1;
    // 3. Within each tier: earliest arrival first
    return a.arrivedAt - b.arrivedAt;
  });

  const claimed = new Set<string>();
  return sorted.map((client) => {
    const suggestion = getSuggestedManicurist(client.services, manicurists, salonServices, claimed);
    if (suggestion) claimed.add(suggestion.id);
    return { ...client, suggestedManicurist: suggestion };
  });
}
