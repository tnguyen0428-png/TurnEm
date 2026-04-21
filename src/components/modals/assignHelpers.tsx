import { CheckCircle } from 'lucide-react';
import { isWaxService, waxRotationCompare, WAX } from '../../utils/salonRules';
import type { QueueEntry, SalonService, ServiceType, Manicurist } from '../../types';

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

    const req = (client.serviceRequests || []).find((r) => r.service === s);

    if (req && req.manicuristIds && req.manicuristIds.length > 0) {
      const usageKey = req.manicuristIds.join(',');
      const usageCount = requestedManicuristUsage.get(usageKey) ?? 0;

      if (usageCount < req.manicuristIds.length) {
        const requestedId = req.manicuristIds[usageCount];
        result.push({ service: s, index: idx, requestedId });
        requestedManicuristUsage.set(usageKey, usageCount + 1);
      } else {
        result.push({ service: s, index: idx, requestedId: null });
      }
    } else {
      result.push({ service: s, index: idx, requestedId: null });
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
