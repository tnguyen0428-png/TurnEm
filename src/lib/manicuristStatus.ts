import type { Manicurist, QueueEntry } from '../types';

// Central home for "is this manicurist actually in service right now".
//
// A manicurist row can sit at status 'available' / currentClient null while
// their queue entry is still `inProgress` and assigned to them — a dropped
// status/currentClient write. That desync is a long-standing condition here,
// not an edge case: it has been worked around independently in at least three
// places (Hana/Jackie 2026-06-06 repainting the floor card, Kelly x Ally
// 2026-06-16 making DONE fall back to the queue entry, and the matching
// CANCEL_SERVICE fallback).
//
// Every one of those workarounds derives the truth the same way — from the
// queue, never from the row — but each re-implemented it locally, and the
// ASSIGN pool never got one at all. So a tech mid-service showed BUSY on the
// floor panel (which compensated) and AVAILABLE in the assign modal (which
// did not), and got handed the next client. Consolidating here means the next
// consumer inherits the fix instead of having to remember it, the same way
// lib/serviceRequests.ts consolidated slot matching after it drifted across
// call sites.
//
// Derived only — these helpers never dispatch. The underlying row stays stale
// on purpose so this can't fight a realtime echo; every reader is expected to
// reconcile through here.

export interface QueueBusyIndex {
  inProgressByMani: Map<string, QueueEntry>;
  queueEntryById: Map<string, QueueEntry>;
}

export function buildQueueBusyIndex(queue: QueueEntry[]): QueueBusyIndex {
  const inProgressByMani = new Map<string, QueueEntry>();
  const queueEntryById = new Map<string, QueueEntry>();
  for (const c of queue) {
    queueEntryById.set(c.id, c);
    if (c.status !== 'inProgress' || !c.assignedManicuristId) continue;
    const existing = inProgressByMani.get(c.assignedManicuristId);
    // Prefer a real entry over an add-child (`…-add-…`) as the shown client.
    if (!existing || (/-add-/.test(existing.id) && !/-add-/.test(c.id))) {
      inProgressByMani.set(c.assignedManicuristId, c);
    }
  }
  return { inProgressByMani, queueEntryById };
}

// A `currentClient` pointing at an entry that belongs to a DIFFERENT tech is
// drift, not a second assignment: `currentClient` is one mutable field per
// manicurist and gets redirected onto another tech's card whenever a split
// child is reassigned (Maggie x Tommy/Kelly, 2026-08-12 — Tommy's pointer
// landed on Kelly's card, so his DONE completed and credited HER pedicure).
// The queue entry's own assignedManicuristId is the source of truth, so when
// the two disagree we believe the assignment. Deliberately narrow: only
// override when the pointed-at entry is explicitly assigned to someone else.
// A tech legitimately holding two of their own entries (a real one plus an
// add-child) keeps whichever their pointer names.
export function isPointerDrifted(m: Manicurist, index: QueueBusyIndex): boolean {
  if (!m.currentClient) return false;
  const pointed = index.queueEntryById.get(m.currentClient);
  return !!pointed?.assignedManicuristId && pointed.assignedManicuristId !== m.id;
}

/** True when the queue says this manicurist is mid-service, whatever their row says. */
export function isBusyByQueue(manicuristId: string, index: QueueBusyIndex): boolean {
  return index.inProgressByMani.has(manicuristId);
}

/**
 * Return the manicurist with status/currentClient corrected from the queue.
 * Never downgrades a real 'break'/'busy' status — it only promotes a wrongly
 * 'available' row to busy, and repoints a drifted pointer.
 */
export function reconcileBusyFromQueue(m: Manicurist, index: QueueBusyIndex): Manicurist {
  const qc = index.inProgressByMani.get(m.id);
  if (!qc) return m;
  const drifted = isPointerDrifted(m, index);
  if (m.status !== 'available') {
    // Never override a real break/busy status, but still repoint a drifted
    // pointer so the card renders the entry actually assigned to them.
    return drifted ? { ...m, currentClient: qc.id } : m;
  }
  return {
    ...m,
    status: 'busy' as const,
    currentClient: drifted ? qc.id : (m.currentClient ?? qc.id),
  };
}
