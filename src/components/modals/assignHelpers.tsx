import { CheckCircle } from 'lucide-react';
import { isWaxService, waxRotationCompare, WAX } from '../../utils/salonRules';
import type { QueueEntry, SalonService, ServiceType, Manicurist, Appointment, CompletedEntry } from '../../types';
import { getTodayLA, getAlmostDoneWindowMs } from '../../utils/time';
import { buildQueueBusyIndex, reconcileBusyFromQueue } from '../../lib/manicuristStatus';

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

    // Only entries the booking marks clientRequest: true are real customer
    // requests. This used to accept any populated manicuristIds, trusting
    // check-in to strip them off non-request entries — an invariant that lives
    // in a different file and stopped holding. requestedId drives BOTH the
    // pre-selected tech and the half-turn credit in MultiServiceAssign, so a
    // booking parked in a tech's column was being paid 0.5 instead of its full
    // catalog turn (2026-08-22).
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
      if (r.clientRequest !== true) continue;
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
  if (remaining <= getAlmostDoneWindowMs()) return Math.max(0, remaining);
  return null;
}

export function getEligibleForService(service: ServiceType, manicurists: Manicurist[], salonServices?: SalonService[], queue?: QueueEntry[]): (Manicurist & { _almostDone?: boolean })[] {
  const wax = salonServices ? isWaxService(service, salonServices) : false;
  // Correct the manicurist->queue desync BEFORE filtering. A dropped status
  // write can leave a row at 'available' while its queue entry is still
  // inProgress; without this the tech is offered the next client while she is
  // mid-service (PANDA, 2026-08-14 — busy on the floor panel, which already
  // reconciled, and simultaneously available here, which did not).
  // Reconciling up front also fixes the `almostDone` branch below, which
  // needs a trustworthy `status`/`currentClient` to measure remaining time.
  const busyIndex = queue ? buildQueueBusyIndex(queue) : null;
  const roster = busyIndex
    ? manicurists.map((m) => reconcileBusyFromQueue(m, busyIndex))
    : manicurists;

  const available = roster
    .filter((m) => m.clockedIn && m.status === 'available')
    .filter((m) => m.skills.includes(service))
    .map(m => ({ ...m, _almostDone: false }));

  const almostDone = (queue && salonServices)
    ? roster
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

// `queue` is optional only for backwards compatibility — pass it wherever you
// can. Without it the eligibility check falls back to the raw manicurist row,
// which can wrongly offer a tech who is actually mid-service.
export function getSuggestedForService(service: ServiceType, manicurists: Manicurist[], salonServices: SalonService[], excludeIds: Set<string> = new Set(), queue?: QueueEntry[]): Manicurist | null {
  // Only techs who can take the client NOW. getEligibleForService also lists
  // ALMOST DONE techs (shown amber, not clickable); one of those sorting first
  // used to "win" the suggestion, and since the row can't show RECOMMENDED on
  // an almost-done tech, nobody got highlighted at all (Tiffany / Kelly,
  // 2026-10-29: Joe almost done ahead of Kelly on the rotation).
  const eligible = getEligibleForService(service, manicurists, salonServices, queue)
    .filter((m) => !excludeIds.has(m.id) && !m._almostDone);
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

/** How far ahead the assign list and the floor board warn about a tech's next
 *  booked service. Tony raised this from 30 to 45 on 2026-09-03 so a
 *  45-minute walk-in can be weighed against an appointment that far out.
 *  Shared by all three pill sites so they cannot drift apart. */
export const APPT_PILL_WINDOW_MINS = 45;

// Minutes until this manicurist's NEXT still-active service today, or null
// when they have nothing scheduled in the foreseeable window. Used to surface
// an "appt in N min" pill on the manicurist's row in the assign list so the
// receptionist can weigh a walk-in against work already promised to her and
// decide to skip or assign. "On the appointment" means any per-service
// request naming her — and the minutes come from THAT request's own
// startTime, never from the appointment header.
export function getMinsToNextAppt(
  manicuristId: string,
  appointments: Appointment[],
  includePast = false,
  queue: QueueEntry[] = [],
  completed: CompletedEntry[] = [],
  /** The client being assigned right now: their own booking is not a claim
   *  on the tech against themselves. */
  excludeApptId: string | null = null,
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

  // Suppress the warning once THIS tech is on the appointment or done with it
  // — no point flashing "Appt N late" at her mid-service / post-DONE (Mia and
  // Katelyn, 2026-05-27 / 05-28). Links come from the queue entry's
  // originalAppointment snapshot and completed_services.originalAppointmentId.
  //
  // A client who has only checked in (queue entry still WAITING) does NOT
  // count. That used to clear the pill too, so the moment Kelly Cain checked
  // in for MIA at 1:12 PM (2026-11-05) the warning vanished and MIA wore
  // RECOMMENDED for Shana, a walk-in 13 seconds ahead of her. A requested
  // client waiting in the lobby is the most urgent case for the pill.
  //
  // If every linked entry has started or finished and none is still waiting,
  // the visit went to other techs (or a split is fully under way): handled.
  const mineApptIds = new Set<string>();
  const startedApptIds = new Set<string>();
  const waitingApptIds = new Set<string>();
  for (const q of queue) {
    const id = q.originalAppointment?.id;
    if (!id) continue;
    if (q.status === 'waiting') waitingApptIds.add(id);
    if (q.status === 'inProgress') {
      startedApptIds.add(id);
      if (q.assignedManicuristId === manicuristId) mineApptIds.add(id);
    }
  }
  for (const c of completed) {
    if (c.voided || !c.originalAppointmentId) continue;
    startedApptIds.add(c.originalAppointmentId);
    if (c.manicuristId === manicuristId) mineApptIds.add(c.originalAppointmentId);
  }
  const handledApptIds = new Set<string>(mineApptIds);
  for (const id of startedApptIds) {
    if (!waitingApptIds.has(id)) handledApptIds.add(id);
  }

  let minDelta: number | null = null;
  for (const a of appointments) {
    if (a.date !== todayLA) continue;
    if (a.status !== 'scheduled' && a.status !== 'checked-in') continue;
    if (handledApptIds.has(a.id)) continue;
    if (excludeApptId && a.id === excludeApptId) continue;
    // Only honor REQUESTED appointments: ones where the client explicitly
    // asked for this manicurist. Column placements (a.manicuristId, or a
    // serviceRequest without clientRequest=true) are bookings parked under
    // a tech for layout — they're not a commitment to that person, so we
    // skip them. Otherwise every appointment in someone's column would set
    // off the warning even when the client doesn't care who does the work.
    const requestedEntries = (a.serviceRequests || []).filter(
      (r) => r.clientRequest === true && (r.manicuristIds || []).includes(manicuristId),
    );
    if (requestedEntries.length === 0) continue;
    // Take the time off the ENTRY, not off `a.time`. The appointment header
    // time belongs to the booking's primary tech; a second tech on the same
    // booking has her own startTime and it is routinely different. Reading
    // the header here told CHRISTINA's row 10:45 for a Gel Builder that
    // started at 10:00 (Julie Falk, 2026-09-03) — 45 minutes clears the
    // cutoff below, so the pill rendered NOTHING and the row still wore
    // RECOMMENDED. Over the previous 30 days 78 entries were overstated this
    // way, by 49 minutes on average.
    //
    // One appointment can also put two entries on one tech at different
    // times, so every matching entry is measured, not just the first.
    for (const r of requestedEntries) {
      const t = (r.startTime || '').trim() || a.time || '00:00';
      const [h, m] = t.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) continue;
      const delta = h * 60 + m - nowMins;
      if (!includePast && delta < 0) continue; // skip overdue when not asked for
      if (minDelta === null || Math.abs(delta) < Math.abs(minDelta)) minDelta = delta;
    }
  }
  return minDelta;
}

// Techs RECOMMENDED should pass over for `client`: someone else who asked for
// them by name is already waiting in the queue, or they have a requested
// appointment inside the pill window (up to APPT_PILL_WINDOW_MINS late — an
// older one is a probable no-show and should not block her all afternoon).
//
// 2026-11-05 1:12 PM: Shana walked in 13 seconds ahead of Kelly Cain, a 1:15
// booking who requested MIA. MIA was lowest on turns and got RECOMMENDED for
// Shana's 45-minute Gel Pedicure while Kelly sat waiting for her.
//
// A soft rule: callers fall back to plain rotation when it would leave nobody
// to recommend, and the tech stays in the list to be picked by hand.
export function getCommittedElsewhereIds(
  client: QueueEntry,
  queue: QueueEntry[],
  manicurists: Manicurist[],
  appointments: Appointment[],
  completed: CompletedEntry[],
): Set<string> {
  const out = new Set<string>();
  const clientVisit = client.parentQueueId ?? client.id;
  for (const q of queue) {
    if (q.status !== 'waiting') continue;
    if (q.id === client.id || (q.parentQueueId ?? q.id) === clientVisit) continue;
    for (const r of q.serviceRequests ?? []) {
      if (r.clientRequest !== true) continue;
      for (const id of r.manicuristIds ?? []) out.add(id);
    }
    if (q.isRequested && q.requestedManicuristId) out.add(q.requestedManicuristId);
  }
  const ownApptId = client.originalAppointment?.id ?? null;
  for (const m of manicurists) {
    if (!m.clockedIn || out.has(m.id)) continue;
    const mins = getMinsToNextAppt(m.id, appointments, true, queue, completed, ownApptId);
    if (mins !== null && mins < APPT_PILL_WINDOW_MINS && mins > -APPT_PILL_WINDOW_MINS) out.add(m.id);
  }
  return out;
}
