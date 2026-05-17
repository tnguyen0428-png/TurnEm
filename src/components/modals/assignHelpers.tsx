import { CheckCircle } from 'lucide-react';
import { isWaxService, waxRotationCompare, WAX } from '../../utils/salonRules';
import type { QueueEntry, SalonService, ServiceType, Manicurist, Appointment } from '../../types';
import { getTodayLA } from '../../utils/time';

export function ServiceHistory({ m }: { m: Manicurist }) {
  const checks = [m.hasFourthPositionSpecial, m.hasCheck2, m.hasCheck3].filter(Boolean).length;
  const waxes = [m.hasWax, m.hasWax2, m.hasWax3].filter(Boolean).length;
  if (checks === 0 && waxes === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: checks }).map((_, i) => (
        <CheckCircle key={`c${i}`} size={11} className="text-red-400" />
      ))}
      {waxes > 0 && (
        <span className="font-mono text-[10px] font-bold text-amber-400">
          {'W'.repeat(waxes)}
        </span>
      )}
    </div>
  );
}

export function getClientDurationMs(manicurist: Manicurist, queue: QueueEntry[], salonServices: SalonService[]): number {
  if (!manicurist.currentClient) return 0;
  const client = queue.find(c => c.id === manicurist.currentClient);
  if (!client) return 0;
  const adj = manicurist.timeAdjustments || {};
  return client.services.reduce((sum, svcName) => {
    const svc = salonServices.find(s => s.name === svcName);
    const baseDuration = svc?.duration ?? 30;
    const adjustment = adj[svcName] || 0;
    return sum + Math.max(baseDuration + adjustment, 5);
  }, 0) * 60000;
}

export function formatServiceList(services: string[]): string {
  const map = new Map<string, number>();
  for (const s of services) map.set(s, (map.get(s) || 0) + 1);
  return Array.from(map.entries())
    .map(([s, count]) => (count > 1 ? `${s} x${count}` : s))
    .join(' + ');
}

export function getDistinctServices(
  client: QueueEntry,
  salonServices: SalonService[]
): { service: ServiceType; index: number; requestedId: string | null }[] {
  let catPriority: string[] = [];
  let svcPriority: Record<string, string[]> = {};
  try {
    const rawCat = localStorage.getItem('turnem_category_priority');
    if (rawCat) catPriority = JSON.parse(rawCat);
    const rawSvc = localStorage.getItem('turnem_service_priority');
    if (rawSvc) svcPriority = JSON.parse(rawSvc);
  } catch {}

  const sorted = [...client.services].sort((a, b) => {
    const aSvc = salonServices.find(s => s.name === a);
    const bSvc = salonServices.find(s => s.name === b);
    const aCat = aSvc?.category ?? '';
    const bCat = bSvc?.category ?? '';

    const aCatRank = catPriority.indexOf(aCat);
    const bCatRank = catPriority.indexOf(bCat);
    const aCatEff = aCatRank === -1 ? Infinity : aCatRank;
    const bCatEff = bCatRank === -1 ? Infinity : bCatRank;
    if (aCatEff !== bCatEff) return aCatEff - bCatEff;

    const catOrder = svcPriority[aCat] ?? [];
    const aRank = catOrder.indexOf(a);
    const bRank = catOrder.indexOf(b);
    const aEff = aRank === -1 ? (aSvc?.sortOrder ?? Infinity) : aRank;
    const bEff = bRank === -1 ? (bSvc?.sortOrder ?? Infinity) : bRank;
    return aEff - bEff;
  });

  const result: { service: ServiceType; index: number; requestedId: string | null }[] = [];
  const serviceCountMap = new Map<string, number>();
  const requestedManicuristUsage = new Map<string, number>();

  for (const s of sorted) {
    const idx = serviceCountMap.get(s) ?? 0;
    serviceCountMap.set(s, idx + 1);

    // Upstream paths (addApptToQueue, handleCheckIn) clear manicuristIds on
    // non-request entries, so any populated manicuristIds here is a real
    // customer request.
    //
    // Two shapes of serviceRequests are supported and must both surface every
    // requested manicurist instead of only the first:
    //   A. Multiple ServiceRequest entries for the same service name, each
    //      carrying a single manicuristId. E.g. two Gel Pedicures both
    //      requesting Kayla → [{service:'Gel Pedi', manicuristIds:['kayla']},
    //                          {service:'Gel Pedi', manicuristIds:['kayla']}].
    //   B. A single ServiceRequest entry whose manicuristIds array has length
    //      N for N occurrences. Legacy shape.
    // Flatten both into a single ordered list of manicuristIds, then walk it
    // by the per-service occurrence counter. The previous code used
    // Array.find() which only returned the first matching entry — for shape
    // A with N>1 occurrences, occurrences past the first dropped their
    // requestedId.
    const flatRequested: string[] = [];
    for (const r of (client.serviceRequests || [])) {
      if (r.service !== s) continue;
      if (!Array.isArray(r.manicuristIds)) continue;
      for (const id of r.manicuristIds) {
        if (id) flatRequested.push(id);
      }
    }

    const usageKey = s;
    const usageCount = requestedManicuristUsage.get(usageKey) ?? 0;

    if (usageCount < flatRequested.length) {
      const requestedId = flatRequested[usageCount];
      result.push({ service: s, index: idx, requestedId });
      requestedManicuristUsage.set(usageKey, usageCount + 1);
    } else {
      result.push({ service: s, index: idx, requestedId: null });
      requestedManicuristUsage.set(usageKey, usageCount + 1);
    }
  }
  return result;
}

export function getAlmostDoneMs(manicurist: Manicurist, queue: QueueEntry[], salonServices: SalonService[]): number | null {
  if (manicurist.status !== 'busy' || !manicurist.currentClient) return null;
  const client = queue.find(c => c.id === manicurist.currentClient);
  if (!client || !client.startedAt) return null;
  const durationMs = getClientDurationMs(manicurist, queue, salonServices);
  const elapsed = Date.now() - client.startedAt;
  const remaining = durationMs - elapsed;
  if (remaining <= 10 * 60 * 1000) return Math.max(0, remaining);
  return null;
}

export function getEligibleForService(service: ServiceType, manicurists: Manicurist[], salonServices?: SalonService[], queue?: QueueEntry[]): (Manicurist & { _almostDone?: boolean })[] {
  const wax = salonServices ? isWaxService(service, salonServices) : false;
  const available = manicurists
    .filter((m) => m.clockedIn && m.status === 'available')
    .filter((m) => m.skills.includes(service))
    .map(m => ({ ...m, _almostDone: false }));

  const almostDone = (queue && salonServices)
    ? manicurists
        .filter((m) => m.clockedIn && m.status === 'busy' && m.skills.includes(service))
        .filter((m) => getAlmostDoneMs(m, queue, salonServices) !== null)
        .map(m => ({ ...m, _almostDone: true }))
    : [];

  const combined = [...available, ...almostDone];

  return combined.sort((a, b) => {
    if (wax) return waxRotationCompare(a, b);
    if (Math.floor(a.totalTurns) !== Math.floor(b.totalTurns)) return Math.floor(a.totalTurns) - Math.floor(b.totalTurns);
    const aTime = a.clockInTime ?? Infinity;
    const bTime = b.clockInTime ?? Infinity;
    return aTime - bTime;
  });
}

export function getSuggestedForService(service: ServiceType, manicurists: Manicurist[], salonServices: SalonService[], excludeIds: Set<string> = new Set()): Manicurist | null {
  const eligible = getEligibleForService(service, manicurists, salonServices).filter((m) => !excludeIds.has(m.id));
  if (eligible.length === 0) return null;
  const svc = salonServices.find((s) => s.name === service);
  if (svc?.isFourthPositionSpecial) {
    return eligible[3] ?? eligible[eligible.length - 1];
  }
  if (svc?.category === WAX) {
    return [...eligible].sort(waxRotationCompare)[0];
  }
  return eligible[0];
}

// Minutes until this manicurist's NEXT still-active appointment today, or
// null when they have nothing scheduled in the foreseeable window. Used to
// surface a "⚠ appt in N min" warning pill at assignment time so the
// receptionist doesn't book a 45-minute walk-in onto someone whose
// appointment is about to walk through the door. "On the appointment"
// means either the appt's primary manicurist or any per-service request.
export function getMinsToNextAppt(
  manicuristId: string,
  appointments: Appointment[],
  includePast = false,
): number | null {
  const todayLA = getTodayLA();
  // Current time as minutes-since-midnight in LA.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const nh = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const nm = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const nowMins = nh * 60 + nm;

  let minDelta: number | null = null;
  for (const a of appointments) {
    if (a.date !== todayLA) continue;
    if (a.status !== 'scheduled' && a.status !== 'checked-in') continue;
    // Only honor REQUESTED appointments: ones where the client explicitly
    // asked for this manicurist. Column placements (a.manicuristId, or a
    // serviceRequest without clientRequest=true) are bookings parked under
    // a tech for layout — they're not a commitment to that person, so we
    // skip them. Otherwise every appointment in someone's column would set
    // off the warning even when the client doesn't care who does the work.
    const isRequested = (a.serviceRequests || []).some(
      (r) => r.clientRequest === true && (r.manicuristIds || []).includes(manicuristId),
    );
    if (!isRequested) continue;
    const [h, m] = (a.time || '00:00').split(':').map(Number);
    const apptMins = h * 60 + m;
    const delta = apptMins - nowMins;
    if (!includePast && delta < 0) continue; // skip overdue when not asked for
    if (minDelta === null || Math.abs(delta) < Math.abs(minDelta)) minDelta = delta;
  }
  return minDelta;
}
