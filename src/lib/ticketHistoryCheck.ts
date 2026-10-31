// Live check: does every closed ticket agree with the turn records (History)?
//
// The ticket, the queue and History each keep their own copy of a visit, and
// a handful of edit paths have let them drift (a service welded onto the wrong
// tech's row, a request R that never reached History). Turn order is decided
// during the day, so a nightly report finds these too late. The Register runs
// this continuously over today's closed tickets and shows any mismatch while
// it can still be fixed.
//
// Read-only and deliberately conservative: it only reports, never repairs,
// and skips the shapes it can't judge (two-staff lines, unassigned lines).

import type { Appointment, CompletedEntry, SalonService, Ticket } from '../types';
import { getVisitId } from './tickets';

export interface TicketHistoryMismatch {
  ticketId: string;
  ticketNumber: number;
  clientName: string;
  staffName: string;
  service: string;
  kind: 'missing_in_history' | 'extra_in_history' | 'request_not_recorded' | 'turn_mismatch';
  /** turn_mismatch only: what History credits vs what the turn rule gives. */
  recordedTurn?: number;
  expectedTurn?: number;
}

// Freshly closed tickets get a moment for the checkout's own completion
// writes to land before they are judged.
const GRACE_MS = 20_000;

const norm = (s: string | null | undefined) => (s ?? '').trim();

export function findTicketHistoryMismatches(
  tickets: Ticket[],
  completed: CompletedEntry[],
  appointments: Appointment[],
  salonServices: SalonService[],
  staffNameById: Map<string, string>,
  now: number = Date.now(),
): TicketHistoryMismatch[] {
  const out: TicketHistoryMismatch[] = [];
  const live = completed.filter((c) => !c.voided);

  for (const t of tickets) {
    if (t.status !== 'closed') continue;
    if (t.closedAt && now - new Date(t.closedAt).getTime() < GRACE_MS) continue;

    const serviceItems = t.items.filter((it) => it.kind === 'service' && norm(it.name));
    if (serviceItems.length === 0) continue;

    // Every visit this ticket bills (merged tickets can carry several).
    const visits = new Set<string>();
    if (t.queueEntryId) visits.add(getVisitId(t.queueEntryId.split('#')[0]));
    for (const it of serviceItems) {
      if (it.queueEntryId) visits.add(getVisitId(it.queueEntryId.split('#')[0]));
    }
    if (visits.size === 0) continue;
    const rows = live.filter((c) => visits.has(getVisitId(c.id)));

    // Names on two-staff lines split credit under their own rules — skip them.
    const shared = new Set(serviceItems.filter((it) => it.staff2Id).map((it) => norm(it.name)));

    // Per tech: services on the ticket vs services in History (count-aware).
    const ticketCount = new Map<string, Map<string, number>>();
    const historyCount = new Map<string, Map<string, number>>();
    const bump = (m: Map<string, Map<string, number>>, staff: string, svc: string) => {
      const inner = m.get(staff) ?? new Map<string, number>();
      inner.set(svc, (inner.get(svc) ?? 0) + 1);
      m.set(staff, inner);
    };
    for (const it of serviceItems) {
      if (!it.staff1Id || it.staff2Id) continue;
      bump(ticketCount, it.staff1Id, norm(it.name));
    }
    for (const r of rows) {
      if (!r.manicuristId) continue;
      for (const s of r.services) {
        if (shared.has(norm(s))) continue;
        bump(historyCount, r.manicuristId, norm(s));
      }
    }

    const push = (
      staffId: string,
      service: string,
      kind: TicketHistoryMismatch['kind'],
      extra: Partial<TicketHistoryMismatch> = {},
    ) =>
      out.push({
        ticketId: t.id,
        ticketNumber: t.ticketNumber,
        clientName: t.clientName,
        staffName: staffNameById.get(staffId) ?? staffId,
        service,
        kind,
        ...extra,
      });

    const staffIds = new Set([...ticketCount.keys(), ...historyCount.keys()]);
    for (const staffId of staffIds) {
      const onTicket = ticketCount.get(staffId) ?? new Map<string, number>();
      const inHistory = historyCount.get(staffId) ?? new Map<string, number>();
      for (const [svc, n] of onTicket) {
        if ((inHistory.get(svc) ?? 0) < n) push(staffId, svc, 'missing_in_history');
      }
      for (const [svc, n] of inHistory) {
        if ((onTicket.get(svc) ?? 0) < n) push(staffId, svc, 'extra_in_history');
      }
    }

    // Each History row's turn must follow the turn rule for what it records:
    // catalog value, or the request rate (Combo 1 / anything else 0.5) for a
    // requested service. A row flagged isRequested with no per-service list is
    // a whole-visit request. Rows with a service missing from the catalog or
    // on a two-staff line are skipped — the rule can't judge them. Checked
    // against 30 days of archive before shipping: 3 hits in 2,539 rows, each a
    // genuine error (a request paid as a full turn, among them).
    for (const r of rows) {
      if (!r.manicuristId || r.services.length === 0) continue;
      if (r.services.some((sv) => shared.has(norm(sv)))) continue;
      const req = (r.requestedServices ?? []).map(norm);
      const wholeVisit = !!r.isRequested && req.length === 0;
      let expected = 0;
      let judgeable = true;
      for (const sv of r.services) {
        const cat = salonServices.find((c) => c.name === norm(sv));
        if (!cat) { judgeable = false; break; }
        const base = Number(cat.turnValue) || 0;
        if (base <= 0) continue;
        expected += wholeVisit || req.includes(norm(sv)) ? (cat.category === 'Combo' ? 1 : 0.5) : base;
      }
      const recorded = Number(r.turnValue) || 0;
      if (judgeable && Math.abs(recorded - expected) > 0.001) {
        push(r.manicuristId, r.services.join(' + '), 'turn_mismatch', { recordedTurn: recorded, expectedTurn: expected });
      }
    }

    // The booking's R (what the book and the ticket show) must reach History.
    const appt = t.appointmentId ? appointments.find((a) => a.id === t.appointmentId) : undefined;
    for (const req of appt?.serviceRequests ?? []) {
      if (req.clientRequest !== true) continue;
      const svc = norm(req.service);
      for (const staffId of req.manicuristIds ?? []) {
        // Only when that tech actually did that service on this ticket.
        if (!(ticketCount.get(staffId)?.get(svc))) continue;
        const recorded = rows.some(
          (r) => r.manicuristId === staffId && (r.requestedServices ?? []).some((s) => norm(s) === svc),
        );
        if (!recorded) push(staffId, svc, 'request_not_recorded');
      }
    }
  }
  return out;
}
