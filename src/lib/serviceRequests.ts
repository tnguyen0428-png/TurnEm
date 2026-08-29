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
 * Service name -> the DISTINCT manicurists actually performing it on one
 * appointment right now (live queue entries + non-voided completed rows).
 * Deduped by manicurist: a service that is both in the queue and already has a
 * completed row (the DONE-but-ticket-open window) is ONE worker, not two.
 */
export type BackedWorkers = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Reassign the next pending manicurist(s) for each service name onto the
 * FIRST matching, NOT-client-requested occurrences in `requests`, in array
 * order. A client-requested entry is never overwritten by a pending
 * assignment for a DIFFERENT manicurist — a customer's requested slot must
 * never be swept up by an unrelated reassignment just because it shares a
 * service name with the slot actually being moved. But when a pending
 * assignment names the SAME manicurist the request already has (the caller
 * is fulfilling that exact request, e.g. SPLIT_AND_ASSIGN's per-row fan-out
 * doesn't distinguish "fulfilling a request" from "reassigning a plain
 * slot"), it's consumed as already-satisfied rather than left over — leaving
 * it unconsumed made the caller append a second, duplicate entry for a
 * request that was already correctly represented (Brianna Bouchard/
 * Christina, Melissa Nelson/Brian, 2026-08-08: assigning a request alongside
 * other services in the same round doubled the requested slot).
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
  backed?: ReadonlyMap<string, ReadonlyArray<{ manicuristId: string }>>,
): { next: ServiceRequest[]; remaining: Map<string, string[]> } {
  const queues = new Map<string, string[]>(
    Array.from(pending, ([svc, ids]) => [svc, [...ids]]),
  );

  // Is this slot held by a manicurist who is ACTUALLY performing that service
  // on this appointment right now (live queue entry or non-voided completed
  // row)? Such a slot must not be handed to a different tech — see the two-pass
  // note below. Without `backed` this is always false and the function behaves
  // exactly as it did before the preference existed.
  const heldByWorker = (r: ServiceRequest): boolean => {
    if (!backed) return false;
    const holder = r.manicuristIds?.[0];
    if (!holder) return false;
    return !!backed.get(r.service)?.some((w) => w.manicuristId === holder);
  };

  const next = requests.slice();
  // Occupied, non-requested slots passed over in pass A. Kept in array order.
  const deferred: number[] = [];

  // ── Pass A — prefer a FREE slot ─────────────────────────────────────────
  // Erinn, 2026-08-26: a booking with two "Gel Pedicure" slots — KIMBERLY
  // mid-service in the first, a Z-TEMPS placeholder in the second. Assigning
  // TAMMY walked the array in order, overwrote KIMBERLY's slot because the
  // names matched, and left the placeholder untouched. The book then showed
  // TAMMY + Z-TEMPS while KIMBERLY, still working, appeared nowhere. Array
  // order is not visual order, so which slot got taken looked arbitrary.
  //
  // A slot held by a real worker now gets the same treatment a clientRequest
  // slot already had: consumable only by its OWN manicurist (an idempotent
  // re-assign of the same tech), never stolen by a different one.
  for (let i = 0; i < next.length; i++) {
    const r = next[i];
    const q = queues.get(r.service);
    if (!q || q.length === 0) continue;
    if (r.clientRequest === true || heldByWorker(r)) {
      // Only consume a pending assignment that matches this slot's current
      // manicurist — that's the request/assignment being fulfilled, not an
      // unrelated reassignment trying to steal the slot.
      const idx = q.indexOf(r.manicuristIds?.[0] ?? '');
      if (idx === -1) {
        // A clientRequest slot is NEVER overwritten (Linda Platten x
        // Macy→Brian, 2026-08-07). A merely-occupied one may be, but only
        // after every free slot has been used — see pass B.
        if (r.clientRequest !== true) deferred.push(i);
        continue;
      }
      q.splice(idx, 1);
      continue;
    }
    next[i] = { ...r, manicuristIds: [q.shift()!], startTime: undefined };
  }

  // ── Pass B — no free slot was left ──────────────────────────────────────
  // Fall back to the original behaviour and overwrite an occupied slot in
  // array order. This keeps the NUMBER of assignments consumed identical to
  // before: the preference changes only WHICH slot is chosen, never how many.
  // That matters because leftovers flow back to callers as `remaining`, and
  // one of them appends a new entry for each — which is how a phantom extra
  // block gets minted (Dee Dee 2026-08-22, a third pedicure slot).
  for (const i of deferred) {
    const r = next[i];
    const q = queues.get(r.service);
    if (!q || q.length === 0) continue;
    next[i] = { ...r, manicuristIds: [q.shift()!], startTime: undefined };
  }

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
 *
 * `apptServices` is the appointment's OWN services[] as a LIST, not a Set.
 * It used to be a Set, which made the gate presence-only: with
 * services[] = ["Pedicure"] and two techs each doing a pedicure, this pushed
 * a second request and left the row at 1 service / 2 requests. That shape is
 * exactly what AppointmentBookView's getApptSvcs() renders as an extra
 * phantom block — its rescue path draws every serviceRequests entry that
 * services[] doesn't cover (Dee Dee 2026-08-22: a third pedicure slot, two of
 * them stacked on KATELYN). Capping the push instead would have hidden a tech
 * who really is on the floor, so we keep the entry and return a services[]
 * grown to match: the two arrays stay in lockstep, which is the invariant
 * reconcileServiceRequests relies on to tell a real slot from a stale one.
 */
/**
 * `blockedServices` names services this appointment must NOT gain from the
 * queue — a human explicitly removed them while work was on the floor (see
 * droppedBackedServicesRef in AppContext). It only applies to services the
 * booking doesn't already list; an extra occurrence of a service still on the
 * booking is a second tech doing it, not a resurrection.
 */
export function addMissingServiceRequests(
  currentReqs: ServiceRequest[],
  desired: Map<string, string[]>,
  apptServices: ReadonlyArray<ServiceType>,
  blockedServices?: ReadonlySet<string>,
): { next: ServiceRequest[]; nextServices: ServiceType[]; changed: boolean; servicesChanged: boolean } {
  const coveredCount = countByService(currentReqs);
  const wantedCount = countByService(apptServices.map((s) => ({ service: s })));
  const next = [...currentReqs];
  const nextServices = [...apptServices];
  let changed = false;
  let servicesChanged = false;
  for (const [svc, mids] of desired) {
    // A service the booking doesn't list at all. This used to be skipped
    // outright, so a service the customer added at the chair could never
    // reach the booking and never got a block — 27 tickets since 07/01, the
    // larger half of the missing-block problem (Ruthie Samson 08/29: TOMMY's
    // Gel Pedicure billed, credited 1.5 turns, and invisible on the board).
    //
    // The skip existed because a queue entry could still be carrying a name
    // that checkout had renamed away, and adding it back resurrected a
    // phantom (Debbie Ma x Brian, 2026-08-05). The rename now updates the
    // queue entry too, so a live entry naming a service the booking lacks
    // means a genuine add — with one exception, a service a human explicitly
    // removed while work was on the floor, which is what blockedServices
    // carries. Everything in `desired` is already backed by a live queue
    // entry with an assigned manicurist; that IS the evidence.
    if ((wantedCount.get(svc) ?? 0) === 0 && blockedServices?.has(svc)) continue;
    // One entry per DISTINCT manicurist. Two queue rows for the same tech on
    // the same service are one slot, and minting a second entry for it is how
    // a duplicate block gets born.
    const distinct = Array.from(new Set(mids));
    const already = coveredCount.get(svc) ?? 0;
    const toAdd = distinct.slice(already); // only the uncovered assignments
    if (toAdd.length === 0) continue;
    for (const mid of toAdd) {
      next.push({ service: svc as ServiceType, manicuristIds: [mid], clientRequest: false });
      changed = true;
    }
    const covered = already + toAdd.length;
    coveredCount.set(svc, covered);
    // Grow services[] to cover the entries we just added, so the row never
    // lands in the requests-outnumber-services state that renders a phantom.
    for (let i = wantedCount.get(svc) ?? 0; i < covered; i++) {
      nextServices.push(svc);
      servicesChanged = true;
    }
    if (covered > (wantedCount.get(svc) ?? 0)) wantedCount.set(svc, covered);
  }
  return { next, nextServices, changed, servicesChanged };
}

/**
 * Drop any serviceRequests entry beyond what `services[]` currently wants,
 * per service name — e.g. a checkout rename that shrinks services[] should
 * drop the matching stale request instead of leaving a phantom slot behind.
 *
 * `backedWorkers` makes this safe to run on writes that DON'T carry a new
 * services[] (see the UPDATE_APPOINTMENT choke point). Without it the prune is
 * blind in two ways that only bite once you run it that often:
 *
 *  1. It would prune below the work actually on the floor. So the count it
 *     prunes to is `max(services[] count, distinct workers)` — a stale short
 *     services[] can never take a block off a tech mid-service, which is the
 *     Sara Feaver / Desiree Reyna failure mode.
 *  2. It keeps occurrences in array order, so when it DOES have to drop one it
 *     could drop the real slot and keep the stale twin. With `backedWorkers`,
 *     entries naming a manicurist who is genuinely doing that service claim
 *     their slot first (one slot per manicurist — a second entry for the same
 *     tech is a duplicate, not a second slot), and only then does array order
 *     decide the rest. Dee Dee 2026-08-22 was exactly this: entries
 *     [KATELYN, KATELYN, LEO] against 1 service — plain array order would have
 *     kept both KATELYNs and dropped LEO, who was mid-pedicure.
 *
 * Callers with no work context (e.g. TicketModal's rename scrub) omit it and
 * get the original in-order, services[]-only behaviour.
 */
export function reconcileServiceRequests(
  services: ServiceType[],
  requests: ServiceRequest[],
  backedWorkers?: BackedWorkers,
): ServiceRequest[] {
  const countNeeded = countByService(services.map((s) => ({ service: s })));
  if (backedWorkers) {
    for (const [svc, workers] of backedWorkers) {
      if (workers.size > (countNeeded.get(svc) ?? 0)) countNeeded.set(svc, workers.size);
    }
  }

  const used = new Map<string, number>();
  const keep = new Array<boolean>(requests.length).fill(false);
  const claim = (i: number): boolean => {
    const svc = requests[i].service;
    const have = used.get(svc) ?? 0;
    if (have >= (countNeeded.get(svc) ?? 0)) return false; // nothing wants this occurrence — drop it
    used.set(svc, have + 1);
    keep[i] = true;
    return true;
  };

  if (backedWorkers) {
    const taken = new Set<string>();
    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      const workers = backedWorkers.get(r.service);
      if (!workers) continue;
      const mid = (r.manicuristIds ?? []).find((m) => workers.has(m) && !taken.has(`${r.service}\u0000${m}`));
      if (mid && claim(i)) taken.add(`${r.service}\u0000${mid}`);
    }
  }
  for (let i = 0; i < requests.length; i++) {
    if (!keep[i]) claim(i);
  }
  return requests.filter((_, i) => keep[i]);
}
