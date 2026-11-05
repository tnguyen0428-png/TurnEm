import type { CompletedEntry, Manicurist, QueueEntry } from '../types';

// Today's history rows, derived from live app state.
//
// Extracted out of HistoryScreen (2026-08-30) when the queue's CLOCK-IN LIST
// grew the same table. Two screens deriving "what happened today" from the
// same raw state independently is exactly how the turn/request rules have
// drifted before — one writer gets a fix and the other doesn't. One
// implementation, both callers.

// Synthesize "in service" rows from currently-assigned queue entries so the
// list visibly reconciles with the manicurist cards and the per-manicurist
// turn bars (which already count in-flight credits via m.totalTurns). Each
// in-flight visit becomes a CompletedEntry with completedAt=null; the table's
// ServiceRow renders an IN SERVICE pill for those and hides the edit pencil.
export function buildInServiceEntries(
  queue: QueueEntry[],
  manicurists: Manicurist[],
): CompletedEntry[] {
  const manicuristById = new Map(manicurists.map((m) => [m.id, m]));
  const rows: CompletedEntry[] = [];
  for (const q of queue) {
    if (q.status !== 'inProgress') continue;
    if (!q.assignedManicuristId) continue;
    const m = manicuristById.get(q.assignedManicuristId);
    if (!m) continue;
    rows.push({
      id: q.id,
      clientName: q.clientName,
      services: q.services,
      turnValue: q.turnValue,
      manicuristId: m.id,
      manicuristName: m.name,
      manicuristColor: m.color,
      startedAt: q.startedAt ?? q.arrivedAt,
      completedAt: null,
      requestedServices: (q.serviceRequests ?? [])
        .filter((sr) => sr.clientRequest === true)
        .map((sr) => sr.service),
      isAppointment: q.isAppointment,
      isRequested: q.isRequested,
      edited: false,
      voided: false,
    });
  }
  return rows;
}

// In-flight work plus finished work, voided rows hidden.
//
// Voided rows used to render grayed out with a strikethrough so users could
// see what was edited, but when a service is upgraded at checkout (e.g. Kathy
// 2026-05-30: Kid's Gel Pedi voided + Gel Pedicure inserted via
// `-add-mani-XX`), the staff card ends up showing TWO entries for what was
// logically one service. The voided row stays in the DB (audit trail intact)
// and per-manicurist turn totals already exclude voided rows, so dropping them
// from the visible list just makes the UI match what actually happened.
export function buildTodayEntries(
  queue: QueueEntry[],
  manicurists: Manicurist[],
  completed: CompletedEntry[],
): CompletedEntry[] {
  return mergeTodayEntries(buildInServiceEntries(queue, manicurists), completed);
}

// One row per id. A service added on a ticket (`${visit}-add-${staff}`) gets
// its completed_services row written on ticket SAVE while its queue entry stays
// live until DONE / checkout, so for that window the same id is both in
// service and completed — History showed it twice (Lisa Hansen #21 × TAMMY ×
// Gel Pedicure, 2026-11-05). The live row wins: the tech's card is still BUSY
// and the book block is still in-service gray. Turn totals already dedupe the
// same way (recomputeTotalTurns skips a queue entry whose id is completed).
export function mergeTodayEntries(
  inService: CompletedEntry[],
  completed: CompletedEntry[],
): CompletedEntry[] {
  const liveIds = new Set(inService.map((e) => e.id));
  return [
    ...inService,
    ...completed.filter((e) => !e.voided && !liveIds.has(e.id)),
  ];
}
