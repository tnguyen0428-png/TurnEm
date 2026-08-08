import type { ServiceRequest, ServiceType } from '../types';

// Central home for every write path that has to figure out "which
// serviceRequests entry does this queue-side change apply to". These entries
// are keyed only by service name — there's no stable per-slot id — so a
// booking with two same-named services (a multi-tech party, or a service
// split across two techs) is inherently ambiguous by name alone. Every call
// site used to re-implement its own name+count guessing, each with a
// slightly different bug: Sara Feaver 6/30 (services[] shrank, slots
// vanished), Connie 7/29 (stale request re-rendered after rename), Carrie
// 6/30 and Megan Smith 7/30 (reassigning one slot swept up an unrelated
// one), Debbie Ma 8/05 (stale queue entry resurrected a renamed-away slot),
// Annalee 8/07 (a split's second tech got dropped), Linda Platten 8/07 (an
// unrequested reassignment overwrote a client's requested slot). Consolidating
// the matching logic here means the next fix only has to happen once.

function countByService(items: ReadonlyArray<{ service: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.service, (counts.get(item.service) ?? 0) + 1);
  return counts;
}

/**
 * Reassign the next pending manicurist(s) for each service name onto the
 * FIRST matching, NOT-client-requested occurrences in `requests`, in array
 * order. Client-requested entries are always skipped — a customer's
 * requested slot must never be swept up by an unrelated reassignment just
 * because it shares a service name with the slot actually being moved.
 *
 * `pending` is a FIFO queue of manicurist ids per service name: pass a
 * single-element array for a plain reassignment, or several for a multi-tech
 * split fan-out — each consumed in array order. Clears `startTime` on any
 * entry it moves so the service re-stacks from the appointment's own time in
 * its new column.
 *
 * Returns the updated array plus whatever `pending` entries went unconsumed
 * (fewer matching non-request occurrences existed than assignments to make)
 * so a caller that needs to append new entries for those can do so.
 */
export function relocateServiceRequests(
  requests: ServiceRequest[],
  pending: Map<string, string[]>,
): { next: ServiceRequest[]; remaining: Map<string, string[]> } {
  const queues = new Map<string, string[]>(
    Array.from(pending, ([svc, ids]) => [svc, [...ids]]),
  );
  const next = requests.map((r) => {
    if (r.clientRequest === true) return r;
    const q = queues.get(r.service);
    if (!q || q.length === 0) return r;
    const manicuristId = q.shift()!;
    return { ...r, manicuristIds: [manicuristId], startTime: undefined };
  });
  const remaining = new Map<string, string[]>();
  for (const [svc, ids] of queues) {
    if (ids.length > 0) remaining.set(svc, ids);
  }
  return { next, remaining };
}

/**
 * Add a serviceRequests entry for every queue-desired (service, manicuristId)
 * pair not already represented on the appointment. Count-aware per service
 * name, not presence-only — two techs can legitimately share a service name
 * (a split), and each needs its own entry rather than being treated as
 * "already covered" by the first. Gated on `apptServices` so a service
 * deliberately renamed/removed from the appointment can't be silently
 * re-added just because a stale queue entry still lists the old name. Never
 * removes or reorders existing entries.
 */
export function addMissingServiceRequests(
  currentReqs: ServiceRequest[],
  desired: Map<string, string[]>,
  apptServices: ReadonlySet<string>,
): { next: ServiceRequest[]; changed: boolean } {
  const coveredCount = countByService(currentReqs);
  const next = [...currentReqs];
  let changed = false;
  for (const [svc, mids] of desired) {
    if (!apptServices.has(svc)) continue;
    const already = coveredCount.get(svc) ?? 0;
    const toAdd = mids.slice(already); // only the uncovered assignments
    for (const mid of toAdd) {
      next.push({ service: svc as ServiceType, manicuristIds: [mid], clientRequest: false });
      changed = true;
    }
    if (toAdd.length > 0) coveredCount.set(svc, already + toAdd.length);
  }
  return { next, changed };
}

/**
 * Drop any serviceRequests entry beyond what `services[]` currently wants,
 * per service name — e.g. a checkout rename that shrinks services[] should
 * drop the matching stale request instead of leaving a phantom slot behind.
 */
export function reconcileServiceRequests(
  services: ServiceType[],
  requests: ServiceRequest[],
): ServiceRequest[] {
  const countNeeded = countByService(services.map((s) => ({ service: s })));
  const used = new Map<string, number>();
  const result: ServiceRequest[] = [];
  for (const r of requests) {
    const have = used.get(r.service) ?? 0;
    const needed = countNeeded.get(r.service) ?? 0;
    if (have >= needed) continue; // services[] no longer wants this occurrence — drop it
    used.set(r.service, have + 1);
    result.push(r);
  }
  return result;
}
