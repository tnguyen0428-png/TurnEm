import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { LogOut, Bell, BellOff, CheckCircle, Clock, Volume2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { supabase, fetchAllRows } from '../../lib/supabase';
import {
  getPermissionState,
  isPushSupported,
  isDeviceSubscribed,
  subscribeForPush,
  unsubscribeFromPush,
} from '../../utils/pushNotifications';
import { formatTime, getLocalDateStr, getBusinessDayLA } from '../../utils/time';
import type { Manicurist, CompletedEntry } from '../../types';
import DailySchedulePanel from './DailySchedulePanel';

interface StaffPortalScreenProps {
  manicurist: Manicurist;
  onLogout: () => void;
}

// visit_id = leading UUID of the completed_services / queue_entries id.
// For non-split entries this equals the id itself; for SPLIT_AND_ASSIGN
// children it strips the `-mani-N` / `-waiting` / `-add-N` suffix down to
// the parent.
function getVisitId(id: string): string {
  const m = id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : id;
}

interface FallbackInput {
  id: string;
  /** Bucket this entry shares with its siblings — `${visit}|${staff}`, plus a
   *  date when the caller spans more than one day. */
  visitKey: string;
  priceCents: number | null;
  voided?: boolean;
  /** Catalog value of this entry's services, used only to split a shared
   *  remainder between two unpriced siblings. */
  catalogCents: number;
}

/**
 * Money for entries whose `price_cents` snapshot never got written.
 *
 * The only live figure available is the ticket total for `${visit}|${staff}`,
 * and that is the WRONG GRAIN: it sums every line that tech has on the visit.
 * Handing it to an unpriced entry double-counts whatever its priced siblings
 * already contributed — MIA, visit 08b9cd80, 2026-08-16: Polish Change Hand
 * $20 (priced) + Kid's Pedicure $28 (unpriced) reported as $20 + $48 = $68
 * against a $48 receipt, and her day read $378 against the blueprint's $358.
 *
 * So divide the REMAINDER instead: visit total minus what the priced siblings
 * already claimed. With one unpriced entry — the ordinary case — it lands on
 * exactly that entry's own lines. The invariant either way is that the sum
 * over a (visit, staff) bucket equals the receipt, so the day total can never
 * drift from the blueprint again.
 *
 * Buckets with no ticket at all are left out of the result entirely; the
 * caller falls through to catalog price for those.
 */
function allocateVisitFallbacks(
  entries: FallbackInput[],
  visitTotalCents: Map<string, number>,
): Map<string, number> {
  const claimed = new Map<string, number>();
  const pending = new Map<string, FallbackInput[]>();

  for (const e of entries) {
    // A voided entry reserves nothing. Voiding is how staff RE-DO a row: the
    // original is voided and a replacement added, both pointing at the one
    // ticket line. Letting the voided copy claim that line's money starves
    // the replacement — KELLY, Sharon's $67 Pedi & Mani, 2026-08-15, which
    // read $0 on a ticket that collected $67.
    if (e.voided) continue;
    if (e.priceCents != null) {
      claimed.set(e.visitKey, (claimed.get(e.visitKey) ?? 0) + e.priceCents);
      continue;
    }
    const list = pending.get(e.visitKey);
    if (list) list.push(e);
    else pending.set(e.visitKey, [e]);
  }

  const out = new Map<string, number>();
  for (const [key, list] of pending) {
    const total = visitTotalCents.get(key);
    if (total == null) continue;
    const remainder = Math.max(0, total - (claimed.get(key) ?? 0));
    if (list.length === 1) {
      out.set(list[0].id, remainder);
      continue;
    }
    // Two or more unpriced siblings share one bucket: split by catalog value
    // so a $28 pedicure and a $15 polish change don't come out equal. The
    // last one absorbs the rounding so the bucket still sums to the receipt.
    const weightTotal = list.reduce((s, e) => s + e.catalogCents, 0);
    let handedOut = 0;
    list.forEach((e, i) => {
      const share = i === list.length - 1
        ? remainder - handedOut
        : weightTotal > 0
          ? Math.round((remainder * e.catalogCents) / weightTotal)
          : Math.floor(remainder / list.length);
      out.set(e.id, share);
      handedOut += share;
    });
  }
  return out;
}

export default function StaffPortalScreen({ manicurist: initialManicurist, onLogout }: StaffPortalScreenProps) {
  const { state, dispatch } = useApp();
  // "Today" on the staff portal is the business day = the LA calendar day.
  // An earlier design shifted it back 9 hours so late-night close-out counted
  // under the day the work was performed, but that was REMOVED on 2026-05-22
  // because anything done between midnight and 9 AM then showed up under
  // "yesterday" (see getBusinessDayLA in utils/time.ts). The archive cron runs
  // 23:59 LA, one minute before the flip, so a finished day is already in
  // daily_history and staff page back one day to see it.
  const [selectedDate, setSelectedDate] = useState<string>(getBusinessDayLA());
  const [historyEntries, setHistoryEntries] = useState<CompletedEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Push notification state for this device. `pushSubscribed` reflects whether
  // the browser currently has a PushSubscription; we mirror it on mount and
  // after toggle. `pushBusy` disables the button during the async dance.
  const [pushSubscribed, setPushSubscribed] = useState<boolean>(false);
  const [pushBusy, setPushBusy] = useState<boolean>(false);

  useEffect(() => {
    isDeviceSubscribed().then(setPushSubscribed);
  }, []);

  // Business-day "today" — the LA calendar day, rolling over at midnight.
  // See getBusinessDayLA in utils/time.ts for why the old 9-hour shift went.
  const todayStr = getBusinessDayLA();
  const isToday = selectedDate === todayStr;

  useEffect(() => {
    if (isToday) { setHistoryEntries([]); return; }
    setHistoryLoading(true);
    supabase
      .from('daily_history')
      .select('entries')
      .eq('date', selectedDate)
      .maybeSingle()
      .then(({ data }) => {
        const entries: CompletedEntry[] = (data?.entries || [])
          .filter((e: CompletedEntry) => e.manicuristId === initialManicurist.id)
          .sort((a: CompletedEntry, b: CompletedEntry) =>
            (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0));
        setHistoryEntries(entries);
        setHistoryLoading(false);
      });
  }, [selectedDate, isToday, initialManicurist.id]);

  function shiftDate(days: number) {
    const d = new Date(selectedDate + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const next = getLocalDateStr(d);
    if (next <= todayStr) setSelectedDate(next);
  }

  // ── Week view ──────────────────────────────────────────────────────────
  // Weeks run Sunday → Saturday, matching how the salon reads a week
  // ("Week 08/02/2026 - 08/08/2026" is Sun 8/2 through Sat 8/8).
  // DONE button on the in-progress banner. Two-tap: the first tap arms it, the
  // second commits — a single mis-tap on a phone in a pocket must not complete
  // a service. `doneBusy` blocks a double-fire while the writes are in flight.
  const [doneArmed, setDoneArmed] = useState(false);
  const [doneBusy, setDoneBusy] = useState(false);
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day');
  const [weekStart, setWeekStart] = useState<string>(() => startOfWeek(getBusinessDayLA()));
  const [weekRows, setWeekRows] = useState<{ date: string; services: number; dollars: number; turns: number }[]>([]);
  const [weekLoading, setWeekLoading] = useState(false);

  function startOfWeek(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() - d.getDay()); // getDay(): 0 = Sunday
    return getLocalDateStr(d);
  }
  function addDaysStr(dateStr: string, days: number): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return getLocalDateStr(d);
  }
  const weekEnd = addDaysStr(weekStart, 6);
  // Can't page forward past the week containing today.
  const atCurrentWeek = weekStart >= startOfWeek(todayStr);

  function shiftWeek(weeks: number) {
    const next = addDaysStr(weekStart, weeks * 7);
    if (next <= startOfWeek(todayStr)) setWeekStart(next);
  }
  function formatMDY(dateStr: string): string {
    return new Date(dateStr + 'T12:00:00')
      .toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  }

  // Load one week of this manicurist's totals. Past days come from the
  // archived daily_history rows (whose entries carry priceCents through the
  // nightly archive); the current business day is still live in
  // completedToday, so it is summed from state rather than re-fetched.
  useEffect(() => {
    if (viewMode !== 'week') return;
    let cancelled = false;
    setWeekLoading(true);

    const days = Array.from({ length: 7 }, (_, i) => addDaysStr(weekStart, i))
      .filter((d) => d <= todayStr);

    void (async () => {
      // The receipt is the source of truth for money (see entryTotalDollars),
      // so the week reads tickets for its whole range rather than trusting the
      // archived priceCents snapshot alone. Without this the week and the day
      // view disagree on any archived row whose snapshot is null — 28.9% of
      // 2026-08-13, the day the close-timing race bit hardest.
      const [{ data }, { data: tRows }] = await Promise.all([
        supabase.from('daily_history').select('date, entries').in('date', days),
        supabase.from('tickets')
          .select('id, business_date, queue_entry_id')
          .in('business_date', days)
          .in('status', ['open', 'closed']),
      ]);
      if (cancelled) return;

      const visitByTicket = new Map<string, { date: string; visit: string }>();
      for (const t of (tRows ?? []) as Array<{ id: string; business_date: string; queue_entry_id: string | null }>) {
        if (t.queue_entry_id) visitByTicket.set(t.id, { date: t.business_date, visit: t.queue_entry_id });
      }
      const amounts = new Map<string, number>(); // `${date}|${visit}|${staff}` -> cents
      if (visitByTicket.size > 0) {
        const { data: iRows } = await supabase
          .from('ticket_items')
          .select('ticket_id, staff1_id, ext_price_cents')
          .in('ticket_id', Array.from(visitByTicket.keys()));
        if (cancelled) return;
        for (const i of (iRows ?? []) as Array<{ ticket_id: string; staff1_id: string | null; ext_price_cents: number }>) {
          const meta = visitByTicket.get(i.ticket_id);
          if (!meta || !i.staff1_id) continue;
          const key = `${meta.date}|${meta.visit}|${i.staff1_id}`;
          amounts.set(key, (amounts.get(key) ?? 0) + (i.ext_price_cents ?? 0));
        }
      }

      {
        // Mirrors entryTotalDollars so the week and the day view can never
        // disagree: the archived priceCents snapshot is per-entry and is
        // preferred, and a missing one is filled from the SHARE of the
        // `${date}|${visit}|${staff}` bucket its priced siblings have not
        // already claimed. Handing an unpriced entry the whole bucket instead
        // is what put MIA at $378 against a $358 blueprint on 2026-08-16 —
        // her priced sibling's $20 got counted twice. See
        // allocateVisitFallbacks.
        const mine = (data ?? []).flatMap((row) =>
          ((row as { date: string; entries: CompletedEntry[] }).entries ?? [])
            .filter((e) => e.manicuristId === initialManicurist.id)
            .map((e) => ({ date: (row as { date: string }).date, entry: e })),
        );
        const fallbacks = allocateVisitFallbacks(
          mine.map(({ date, entry }) => ({
            id: `${date}|${entry.id}`,
            visitKey: `${date}|${getVisitId(entry.id)}|${entry.manicuristId}`,
            priceCents: entry.priceCents ?? null,
            voided: entry.voided,
            catalogCents: Math.round(archivedEntryDollars(entry) * 100),
          })),
          amounts,
        );

        const byDate = new Map<string, { services: number; dollars: number; turns: number }>();
        for (const { date, entry: e } of mine) {
          if (e.voided) continue;
          const hit = byDate.get(date) ?? { services: 0, dollars: 0, turns: 0 };
          hit.services += e.services?.length || 1;
          hit.turns += Number(e.turnValue) || 0;
          if (e.priceCents != null) {
            hit.dollars += e.priceCents / 100;
          } else {
            const share = fallbacks.get(`${date}|${e.id}`);
            hit.dollars += typeof share === 'number' ? share / 100 : archivedEntryDollars(e);
          }
          byDate.set(date, hit);
        }
        setWeekRows(days.map((date) => {
          if (date === todayStr) {
            // Live day — use the same amount logic the day view uses so the
            // two never disagree for today.
            let services = 0;
            let dollars = 0;
            let turns = 0;
            for (const e of completedToday) {
              if (e.voided) continue;
              services += e.services?.length || 1;
              turns += Number(e.turnValue) || 0;
              dollars += entryTotalDollars(e);
            }
            return { date, services, dollars, turns };
          }
          const hit = byDate.get(date);
          return { date, services: hit?.services ?? 0, dollars: hit?.dollars ?? 0, turns: hit?.turns ?? 0 };
        }));
        setWeekLoading(false);
      }
    })();

    return () => { cancelled = true; };
    // completedToday / entryTotalDollars are recomputed on every render; the
    // week only needs to reload when the range or the mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, weekStart, todayStr, initialManicurist.id]);

  function formatDateLabel(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
    const mdy = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
    return `${weekday} ${mdy}`;
  }
  // Live data for staff mode: subscribe to realtime changes on the same three
  // tables admin syncs, plus an initial fetch on mount. Replaces the previous
  // unconditional 3s poll, so the staff browser only round-trips when
  // something actually changed.
  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const [
          { data: staffRows, error: staffErr },
          { data: queueRows, error: queueErr },
          { data: completedRows },
          { data: serviceRows },
          { data: appointmentRows },
        ] = await Promise.all([
          // Paginate so PostgREST's 1000-row default Range cap can't silently
          // truncate any table — same fix that prevented appointments from
          // dropping on the main app (2026-05-30).
          fetchAllRows(() => supabase.from('manicurists').select('*')),
          fetchAllRows(() => supabase.from('queue_entries').select('*')),
          fetchAllRows(() => supabase.from('completed_services').select('*')),
          fetchAllRows(() => supabase.from('salon_services').select('*').order('sort_order')),
          fetchAllRows(() => supabase.from('appointments').select('*')),
        ]);
        if (cancelled) return;
        if (staffErr || queueErr) {
          console.error('[staff refresh] DB error:', (staffErr as { message?: string } | null)?.message || (queueErr as { message?: string } | null)?.message);
          return;
        }
        if (staffRows && queueRows) {
          dispatch({
            type: 'LOAD_STATE',
            state: {
              manicurists: staffRows.map((r: any) => ({
                id: r.id, name: r.name, color: r.color, phone: r.phone || '',
                skills: r.skills || [], clockedIn: r.clocked_in,
                clockInTime: r.clock_in_time ? new Date(r.clock_in_time).getTime() : null,
                totalTurns: Number(r.total_turns) || 0,
                currentClient: r.current_client_id || null,
                status: r.status || 'available',
                hasFourthPositionSpecial: r.has_fourth_position_special || false,
                hasCheck2: r.has_check2 || false, hasCheck3: r.has_check3 || false,
                hasWax: r.has_wax || false, hasWax2: r.has_wax2 || false, hasWax3: r.has_wax3 || false,
                timeAdjustments: r.time_adjustments || {}, pinCode: r.pin_code || '',
                breakStartTime: r.break_start_time ? Number(r.break_start_time) : null,
                smsOptIn: r.sms_opt_in || false,
              })),
              queue: queueRows.map((r: any) => ({
                id: r.id, clientName: r.client_name,
                services: r.services || [],
                arrivedAt: new Date(r.arrived_at).getTime(),
                status: r.status || 'waiting',
                assignedManicuristId: r.assigned_manicurist_id || null,
                startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
                completedAt: r.completed_at ? new Date(r.completed_at).getTime() : null,
                turnValue: Number(r.turn_value) || 0,
                serviceRequests: r.service_requests || [],
                requestedManicuristId: r.requested_manicurist_id || null,
                isRequested: r.is_requested || false,
                isAppointment: r.is_appointment || false,
                extraTimeMs: Number(r.extra_time_ms) || 0,
              })),
              completed: (completedRows || []).map((r: any) => ({
                id: r.id, clientName: r.client_name || '',
                services: r.services || [], manicuristId: r.manicurist_id || '',
                manicuristName: r.manicurist_name || '',
                manicuristColor: r.manicurist_color || '',
                startedAt: r.started_at ? new Date(r.started_at).getTime() : Date.now(),
                completedAt: new Date(r.completed_at).getTime(),
                turnValue: Number(r.turn_value) || 0,
                requestedServices: r.requested_services || [],
                // Carry the audit/display flags the POS History uses so the
                // staff list and turn count match the admin view. CRITICAL:
                // `voided` MUST be mapped — recomputeTotalTurns skips rows where
                // voided is truthy, but an UNMAPPED voided reads as `undefined`
                // (falsy), so voided rows were silently counted and listed as
                // normal services. That's why Panda showed 5.0 (4.5 real + a
                // 0.5 voided "LATE" row) instead of 4.5.
                isAppointment: !!r.is_appointment,
                isRequested: !!r.is_requested,
                edited: !!r.edited,
                voided: !!r.voided,
                // Real checkout price written by trg_sync_completed_service_prices
                // on ticket close. Preferred over catalog price in entryTotalDollars.
                priceCents: r.price_cents == null ? null : Number(r.price_cents),
              })),
              // Service catalog — prices live here. Pulled into state.salonServices
              // so entryTotalDollars()'s fallback and any other catalog-reading
              // surface on the staff portal stays current with admin edits.
              salonServices: (serviceRows || []).map((r: any) => ({
                id: r.id, name: r.name, turnValue: Number(r.turn_value) || 0,
                duration: Number(r.duration) || 0, price: Number(r.price) || 0,
                isActive: r.is_active !== false, category: r.category || '',
                sortOrder: Number(r.sort_order) || 0,
                isFourthPositionSpecial: !!r.is_fourth_position_special,
              })),
              // Appointments — feeds today's schedule (DailySchedulePanel) and
              // any other appointment-aware UI. Replaces stale data if the
              // realtime channel happened to drop a message.
              appointments: (appointmentRows || []).map((r: any) => ({
                id: r.id,
                clientName: r.client_name || '',
                clientPhone: r.client_phone || '',
                service: r.service || '',
                services: r.services || (r.service ? [r.service] : []),
                serviceRequests: r.service_requests || [],
                manicuristId: r.manicurist_id || null,
                date: r.date,
                time: r.time,
                notes: r.notes || '',
                status: r.status || 'scheduled',
                createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
                sameTime: !!r.same_time,
                partyId: r.party_id || null,
                bookedByReceptionistId: r.booked_by_receptionist_id || null,
                lastEditedByReceptionistId: r.last_edited_by_receptionist_id || null,
                lastEditedAt: r.last_edited_at ? new Date(r.last_edited_at).getTime() : null,
              })),
            },
          });
        }
      } catch (e) {
        if (!cancelled) console.error('[staff refresh] error:', e);
      }
    }

    // Initial fetch on mount so the portal has data before the first event.
    void refresh();

    // We track the channel's subscription state so the fallback refresh
    // logic below can tell whether realtime is healthy. Mobile browsers
    // suspend WebSockets aggressively when the tab backgrounds; if the
    // channel drops we kick off a reconnect via re-subscribe.
    let channelHealthy = false;
    const channel = supabase
      .channel('staff-portal-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'manicurists' },        () => { void refresh(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_entries' },      () => { void refresh(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'completed_services' }, () => { void refresh(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'salon_services' },     () => { void refresh(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' },       () => { void refresh(); })
      .subscribe((status) => {
        channelHealthy = status === 'SUBSCRIBED';
        if (channelHealthy) void refresh();
      });

    // Mobile recovery: visibility/focus refetch + 30s defensive interval.
    function reconnectChannel() {
      try {
        channel.subscribe((status) => {
          channelHealthy = status === 'SUBSCRIBED';
          if (channelHealthy) void refresh();
        });
      } catch (e) {
        console.warn('[staff portal] resubscribe failed:', e);
      }
    }
    function onVisible() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh();
      if (!channelHealthy) reconnectChannel();
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const intervalId = window.setInterval(() => {
      void refresh();
      if (!channelHealthy) reconnectChannel();
    }, 30000);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(intervalId);
      supabase.removeChannel(channel);
    };
  }, [dispatch]);


  // Live amount lookup keyed by `${visit_id}|${staff_id}` → total cents on the
  // matching ticket. Declared up here (not inline with the useEffect that
  // populates it) so the setter binding is unambiguously in scope.
  const [ticketAmountMap, setTicketAmountMap] = useState<Map<string, number>>(new Map());


  // Live ticket-amount sync — fetches today's tickets + items, aggregates
  // by (visit_id, staff_id), and subscribes to changes. The aggregation uses
  // ticket.queue_entry_id (the visit id) and ticket_items.staff1_id, so the
  // amount shown in the services list always tracks what the cashier locked
  // in at checkout (including discounts and price overrides).
  useEffect(() => {
    let cancelled = false;

    async function refreshAmounts() {
      try {
        // Voided tickets MUST be excluded. A void means the transaction did
        // not happen, but ticket_items rows survive it (Katie's voided #23 and
        // #30 on 2026-08-13 kept 2 and 1 lines). While price_cents was the
        // primary source this was harmless — the snapshot won first — but
        // entryTotalDollars now reads this map FIRST, so an unfiltered fetch
        // would pay a tech for voided work.
        const { data: ticketRows, error: tErr } = await supabase
          .from('tickets')
          .select('id, queue_entry_id, business_date')
          .eq('business_date', selectedDate)
          .in('status', ['open', 'closed']);
        if (cancelled) return;
        if (tErr) { console.error('[staff amounts] tickets fetch:', tErr.message); return; }
        const visitByTicketId = new Map<string, string>();
        for (const t of (ticketRows ?? []) as Array<{ id: string; queue_entry_id: string | null }>) {
          if (t.queue_entry_id) visitByTicketId.set(t.id, t.queue_entry_id);
        }
        const ticketIds = Array.from(visitByTicketId.keys());
        if (ticketIds.length === 0) {
          if (!cancelled) setTicketAmountMap(new Map());
          return;
        }
        const { data: itemRows, error: iErr } = await supabase
          .from('ticket_items')
          .select('ticket_id, staff1_id, ext_price_cents')
          .in('ticket_id', ticketIds);
        if (cancelled) return;
        if (iErr) { console.error('[staff amounts] items fetch:', iErr.message); return; }
        const map = new Map<string, number>();
        for (const i of (itemRows ?? []) as Array<{ ticket_id: string; staff1_id: string | null; ext_price_cents: number }>) {
          const visitId = visitByTicketId.get(i.ticket_id);
          const staffId = i.staff1_id;
          if (!visitId || !staffId) continue;
          const key = `${visitId}|${staffId}`;
          map.set(key, (map.get(key) ?? 0) + (i.ext_price_cents ?? 0));
        }
        if (!cancelled) setTicketAmountMap(map);
      } catch (e) {
        if (!cancelled) console.error('[staff amounts] refresh error:', e);
      }
    }

    void refreshAmounts();

    const channel = supabase
      .channel('staff-ticket-amounts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' },      () => { void refreshAmounts(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ticket_items' }, () => { void refreshAmounts(); })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [selectedDate]);

  // Get live data for this manicurist from state
  const manicurist = state.manicurists.find((m) => m.id === initialManicurist.id) || initialManicurist;

  // Toggle push subscription for this device, bound to this manicurist.
  // Subscribe asks for permission + stores endpoint in push_subscriptions;
  // unsubscribe revokes and deletes the row.
  const handleTogglePush = useCallback(async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (pushSubscribed) {
        const res = await unsubscribeFromPush();
        if (!res.ok) {
          // Local `alert` state in this component shadows the global, so call window.alert.
          window.alert(`Could not disable notifications: ${res.error}`);
        } else {
          setPushSubscribed(false);
        }
      } else {
        if (!isPushSupported()) {
          window.alert(
            'Push notifications are not supported on this browser. On iPhone, install the app to your home screen first (Share → Add to Home Screen) and open it from there.'
          );
          return;
        }
        const res = await subscribeForPush(manicurist.id);
        if (!res.ok) {
          window.alert(`Could not enable notifications: ${res.error}`);
        } else {
          setPushSubscribed(true);
        }
      }
    } finally {
      setPushBusy(false);
    }
  }, [pushBusy, pushSubscribed, manicurist.id]);

  // Services completed during the current business day by this manicurist.
  // Filter by business-day (the LA calendar day). A service finished at 11 PM
  // belongs to that day and moves into history at the 23:59 archive.
  const completedToday = useMemo(() => {
    // In-progress entries (completedAt = null) fall back to startedAt for
    // the business-day check so they appear in today's list while the
    // manicurist is still working on them.
    return state.completed
      .filter((e) => {
        if (e.manicuristId !== manicurist.id) return false;
        const ts = e.completedAt ?? e.startedAt;
        return ts ? getBusinessDayLA(new Date(ts)) === todayStr : false;
      })
      .sort((a, b) => (b.completedAt ?? b.startedAt ?? 0) - (a.completedAt ?? a.startedAt ?? 0));
  }, [state.completed, manicurist.id, todayStr]);
  // The queue entry this manicurist is currently working on (if any).
  // Renders as a prominent emerald banner above the Services list. The
  // moment COMPLETE_SERVICE fires, the entry moves to state.completed and
  // the banner disappears (the completed row appears in the list below).
  //
  // Resilient lookup: prefer manicurist.currentClient (canonical pointer
  // on the manicurists row), fall back to state.queue scanning by
  // assignedManicuristId. The fallback covers the case where the
  // manicurists row's realtime echo hasn't arrived yet but the queue row
  // has already flipped to inProgress.
  const inProgressEntry = useMemo(() => {
    if (manicurist.currentClient) {
      const byId = state.queue.find(
        (c) => c.id === manicurist.currentClient && c.status === 'inProgress',
      );
      if (byId) return byId;
    }
    const byStaff = state.queue.find(
      (c) => c.assignedManicuristId === manicurist.id && c.status === 'inProgress',
    );
    return byStaff ?? null;
  }, [state.queue, manicurist.currentClient, manicurist.id]);

  // Disarm the DONE confirm on its own so a half-tapped button can't sit armed
  // in a pocket and complete on the next accidental touch. Also disarms if the
  // in-service client changes underneath (front desk reassigned mid-tap).
  useEffect(() => {
    if (!doneArmed) return;
    const t = setTimeout(() => setDoneArmed(false), 5000);
    return () => clearTimeout(t);
  }, [doneArmed, inProgressEntry?.id]);

  // Diagnostic — surfaces in Safari Web Inspector / Chrome remote debug.
  useEffect(() => {
    console.info('[staff portal] in-progress snapshot', {
      manicuristId: manicurist.id,
      manicuristName: manicurist.name,
      manicuristStatus: manicurist.status,
      currentClient: manicurist.currentClient,
      queueLen: state.queue.length,
      inProgressMatched: inProgressEntry?.id ?? null,
      inProgressClient: inProgressEntry?.clientName ?? null,
      inProgressServices: inProgressEntry?.services ?? null,
    });
  }, [manicurist.id, manicurist.name, manicurist.status, manicurist.currentClient, state.queue.length, inProgressEntry]);


  // Catalog-price fallback for the staff's services when a ticket hasn't
  // been written yet. salonServices.price is in dollars (not cents).
  const priceByService = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of state.salonServices ?? []) m.set(s.name, Number(s.price) || 0);
    return m;
  }, [state.salonServices]);

  // Catalog value of an entry's services, in cents.
  const catalogCents = useCallback((entry: CompletedEntry): number => {
    return (entry.services ?? []).reduce(
      (sum, name) => sum + Math.round((priceByService.get(name) ?? 0) * 100),
      0,
    );
  }, [priceByService]);

  // Fallback amounts for the day currently on screen, for the entries whose
  // price_cents snapshot is missing. See allocateVisitFallbacks: the ticket
  // map is per (visit, staff), so it can only be divided among siblings, never
  // handed to each of them.
  const dayFallbackCents = useMemo(() => {
    const entries = isToday ? completedToday : historyEntries;
    return allocateVisitFallbacks(
      entries.map((e) => ({
        id: e.id,
        visitKey: `${getVisitId(e.id)}|${e.manicuristId}`,
        priceCents: e.priceCents ?? null,
        voided: e.voided,
        catalogCents: catalogCents(e),
      })),
      ticketAmountMap,
    );
  }, [isToday, completedToday, historyEntries, ticketAmountMap, catalogCents]);

  function entryTotalDollars(entry: CompletedEntry): number {
    // price_cents IS the receipt amount, at the right grain: the close/insert
    // triggers sum ticket_items PER completed_services id, so it is this
    // entry's own money. Prefer it.
    //
    // Do NOT prefer ticketAmountMap here. That map is keyed
    // `${visitId}|${staffId}` and sums every line that tech has on the visit,
    // so a tech with two entries on one visit gets the whole visit's total
    // reported for EACH of them, and the day total doubles. Real case —
    // TAMMY, visit ef43ecfe, 2026-08-13: Manicure $32 + Polish Change Feet
    // $15. Per entry that is $32 and $15; the visit map returns $47 for both,
    // totalling $94. (Briefly shipped that way in ef5fb06 and reverted.)
    //
    // The null-price_cents hole that motivated the inversion is closed
    // properly instead, by trg_price_completed_service_on_insert, which prices
    // a row that lands after its ticket closed.
    if (entry.priceCents != null) return entry.priceCents / 100;
    // Fallback while a ticket is still open (no snapshot written yet), or for
    // a row the pricing triggers structurally cannot reach. The ticket map is
    // per (visit, staff), so what this entry gets is the share of that bucket
    // its priced siblings have NOT already claimed — see allocateVisitFallbacks.
    const fromTicket = dayFallbackCents.get(entry.id);
    if (typeof fromTicket === 'number') return fromTicket / 100;
    // Last resort: catalog price sum, for in-progress entries with no ticket
    // line yet and legacy rows from before price_cents existed.
    return (entry.services ?? []).reduce((sum, name) => sum + (priceByService.get(name) ?? 0), 0);
  }

  // Amount for an ARCHIVED entry (daily_history). Past days have no live
  // ticket to read, so the archived priceCents snapshot is the source — it is
  // exactly what the day view shows for the same date, so the week totals and
  // the day list can't disagree. Falls back to catalog price for legacy rows
  // archived before price_cents existed.
  function archivedEntryDollars(entry: CompletedEntry): number {
    if (entry.priceCents != null) return entry.priceCents / 100;
    return (entry.services ?? []).reduce((sum, name) => sum + (priceByService.get(name) ?? 0), 0);
  }

  // Turns for whatever period the list below is showing, so the headline
  // number and the services under it always describe the same days.
  //   today (day view) → the live counter, which includes in-progress work
  //   a past day       → that day's archived entries
  //   week view        → the visible week
  const turnsShown = (() => {
    if (viewMode === 'week') return weekRows.reduce((s, r) => s + r.turns, 0);
    if (isToday) return manicurist.totalTurns;
    return historyEntries.reduce((s, e) => s + (e.voided ? 0 : (Number(e.turnValue) || 0)), 0);
  })();

  // First name only: split on whitespace and take the first non-empty token.
  // Empty client names render as the generic "Walk-in" so the row still has
  // a leading anchor.
  function firstName(name: string): string {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return 'Walk-in';
    const head = trimmed.split(/\s+/)[0];
    return head || 'Walk-in';
  }

  // First name + last-initial: privacy-safe form used inside the YOUR TURN
  // alert. "John Smith" → "John S.", "John" → "John", "" → "Walk-in".
  function firstNameLastInitial(name: string): string {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return 'Walk-in';
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) return parts[0];
    const initial = (parts[parts.length - 1][0] ?? '').toUpperCase();
    return initial ? `${parts[0]} ${initial}.` : parts[0];
  }

  // Queue position: rank among clocked-in available manicurists by turn count
  const queuePosition = useMemo(() => {
    if (!manicurist.clockedIn) return null;
    if (manicurist.status !== 'available') return null;

    const available = state.manicurists
      .filter((m) => m.clockedIn && m.status === 'available')
      .sort((a, b) => {
        const aFloor = Math.floor(a.totalTurns);
        const bFloor = Math.floor(b.totalTurns);
        if (aFloor !== bFloor) return aFloor - bFloor;
        return (a.clockInTime ?? Infinity) - (b.clockInTime ?? Infinity);
      });

    const idx = available.findIndex((m) => m.id === manicurist.id);
    return idx === -1 ? null : idx + 1;
  }, [state.manicurists, manicurist]);

  // ---- In-app alert when assigned a client or becoming next up ----
  const [alert, setAlert] = useState<{ type: 'assigned' | 'nextup'; clientName?: string; services?: string[] } | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [audioReady, setAudioReady] = useState(false);
  const prevStatusRef = useRef(manicurist.status);
  const prevQueuePosRef = useRef(queuePosition);
  const audioContextRef = useRef<AudioContext | null>(null);
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep AudioContext alive on iOS by playing a silent tone every 15 seconds.
  // iOS suspends AudioContext after ~30s of silence, which blocks alert sounds.
  const startKeepalive = useCallback(() => {
    if (keepaliveRef.current) return; // already running
    keepaliveRef.current = setInterval(() => {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== 'running') return;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.001; // inaudible
        osc.frequency.value = 1;
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.05);
      } catch (_) { /* ignore */ }
    }, 15000);
  }, []);

  // Cleanup keepalive on unmount
  useEffect(() => {
    return () => {
      if (keepaliveRef.current) clearInterval(keepaliveRef.current);
    };
  }, []);

  const playAssignedSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime;

      // Urgent bright chime — "YOUR TURN!" — plays twice
      const playChime = (offset: number) => {
        const notes = [
          { freq: 784, time: 0, dur: 0.12 },     // G5
          { freq: 988, time: 0.12, dur: 0.12 },   // B5
          { freq: 1175, time: 0.24, dur: 0.15 },  // D6
          { freq: 1568, time: 0.40, dur: 0.25 },  // G6 (hold)
          { freq: 1175, time: 0.70, dur: 0.10 },  // D6
          { freq: 1568, time: 0.82, dur: 0.35 },  // G6 (hold longer)
        ];
        for (const n of notes) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = n.freq;
          osc.type = 'sine';
          gain.gain.setValueAtTime(0, t + offset + n.time);
          gain.gain.linearRampToValueAtTime(0.3, t + offset + n.time + 0.02);
          gain.gain.linearRampToValueAtTime(0, t + offset + n.time + n.dur);
          osc.start(t + offset + n.time);
          osc.stop(t + offset + n.time + n.dur + 0.01);
        }
      };
      playChime(0);
      playChime(1.4);
      playChime(2.8);
    } catch (e) {
      console.log('Audio alert failed:', e);
    }
  }, [soundEnabled]);

  const playNextUpSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime;

      // Gentle rising arpeggio — "YOU'RE NEXT" — softer, plays twice
      const playArp = (offset: number) => {
        const notes = [
          { freq: 523, time: 0, dur: 0.20 },     // C5
          { freq: 659, time: 0.20, dur: 0.20 },   // E5
          { freq: 784, time: 0.40, dur: 0.20 },   // G5
          { freq: 1047, time: 0.60, dur: 0.45 },  // C6 (hold)
        ];
        for (const n of notes) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = n.freq;
          osc.type = 'triangle';
          gain.gain.setValueAtTime(0, t + offset + n.time);
          gain.gain.linearRampToValueAtTime(0.2, t + offset + n.time + 0.03);
          gain.gain.linearRampToValueAtTime(0, t + offset + n.time + n.dur);
          osc.start(t + offset + n.time);
          osc.stop(t + offset + n.time + n.dur + 0.01);
        }
      };
      playArp(0);
      playArp(1.3);
    } catch (e) {
      console.log('Audio alert failed:', e);
    }
  }, [soundEnabled]);

  // Second-alert timer. When the manicurist gets assigned (or becomes next),
  // we fire the alert + sound immediately AND schedule a repeat 15s later so
  // the manicurist can't miss it. Holding the timer in a ref lets us cancel
  // if state changes (e.g. they start the service) before it fires.
  const secondAlertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelSecondAlert() {
    if (secondAlertTimerRef.current) {
      clearTimeout(secondAlertTimerRef.current);
      secondAlertTimerRef.current = null;
    }
  }

  // Detect assignment (status changed to busy)
  useEffect(() => {
    if (prevStatusRef.current !== 'busy' && manicurist.status === 'busy' && manicurist.currentClient) {
      const client = state.queue.find((c) => c.id === manicurist.currentClient);
      const safeName = firstNameLastInitial(client?.clientName || 'Client');
      const services = client?.services || [];
      const assignedClientId = manicurist.currentClient;
      setAlert({ type: 'assigned', clientName: safeName, services });
      playAssignedSound();
      // Repeat alert 15s later — only if this same client is still assigned.
      cancelSecondAlert();
      secondAlertTimerRef.current = setTimeout(() => {
        if (manicurist.status === 'busy' && manicurist.currentClient === assignedClientId) {
          setAlert({ type: 'assigned', clientName: safeName, services });
          playAssignedSound();
        }
        secondAlertTimerRef.current = null;
      }, 15000);
    }
    prevStatusRef.current = manicurist.status;
  }, [manicurist.status, manicurist.currentClient, state.queue, playAssignedSound]);

  // Detect becoming next up (queue position changed to 1)
  useEffect(() => {
    if (prevQueuePosRef.current !== 1 && queuePosition === 1) {
      setAlert({ type: 'nextup' });
      playNextUpSound();
      // Repeat 15s later — only if they're still next-up.
      cancelSecondAlert();
      secondAlertTimerRef.current = setTimeout(() => {
        if (queuePosition === 1) {
          setAlert({ type: 'nextup' });
          playNextUpSound();
        }
        secondAlertTimerRef.current = null;
      }, 15000);
    }
    prevQueuePosRef.current = queuePosition;
  }, [queuePosition, playNextUpSound]);

  // Clean up the pending second-alert timer on unmount.
  useEffect(() => {
    return () => cancelSecondAlert();
  }, []);

  // Auto-dismiss alert after 30 seconds
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert(null), 30000);
    return () => clearTimeout(timer);
  }, [alert]);

  // Activate AudioContext on first tap (iOS requires user gesture) and start keepalive
  function handleScreenTap() {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        setAudioReady(true);
        startKeepalive();
        // Play a tiny confirmation blip so we know audio is working
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          gain.gain.value = 0.05;
          osc.frequency.value = 600;
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.05);
        } catch (_) { /* ignore */ }
      });
    } else if (ctx.state === 'running' && !audioReady) {
      setAudioReady(true);
      startKeepalive();
    }
  }

  const statusLabel = manicurist.status === 'available' ? 'Available' :
    manicurist.status === 'busy' ? 'Busy' : 'On Break';
  const statusColor = manicurist.status === 'available' ? 'text-emerald-500' :
    manicurist.status === 'busy' ? 'text-red-500' : 'text-amber-500';

  return (
    <div className="h-screen overflow-y-auto overscroll-contain bg-gray-50" onClick={handleScreenTap}>
      {/* Full-screen alert overlay */}
      {alert && (
        <div
          className={`fixed inset-0 z-50 flex flex-col items-center justify-center p-8 ${
            alert.type === 'assigned'
              ? 'bg-gradient-to-b from-red-500 to-red-700'
              : 'bg-gradient-to-b from-emerald-500 to-emerald-700'
          }`}
          style={{ animation: 'pulse 1s ease-in-out infinite alternate' }}
          onClick={() => setAlert(null)}
        >
          <style>{`
            @keyframes pulse { from { opacity: 0.85; } to { opacity: 1; } }
            @keyframes bounceIn { 0% { transform: scale(0.5); opacity: 0; } 50% { transform: scale(1.1); } 100% { transform: scale(1); opacity: 1; } }
          `}</style>
          <div style={{ animation: 'bounceIn 0.5s ease-out' }} className="text-center">
            {alert.type === 'assigned' ? (
              <>
                <Bell size={64} className="text-white mx-auto mb-4" />
                <h2 className="font-bebas text-5xl text-white tracking-[3px] mb-3">YOUR TURN!</h2>
                <p className="font-mono text-lg text-white/90 font-semibold mb-2">
                  Client: {alert.clientName}
                </p>
                {alert.services && alert.services.length > 0 && (
                  <div className="flex flex-wrap justify-center gap-2 mt-3">
                    {alert.services.map((s) => (
                      <span key={s} className="px-3 py-1 rounded-full bg-white/20 text-white font-mono text-sm font-semibold">
                        {s}
                      </span>
                    ))}
                  </div>
                )}
                <p className="font-mono text-sm text-white/70 mt-6">Please head to your station</p>
              </>
            ) : (
              <>
                <div className="text-7xl mb-4">👆</div>
                <h2 className="font-bebas text-5xl text-white tracking-[3px] mb-3">YOU'RE NEXT!</h2>
                <p className="font-mono text-lg text-white/90 font-semibold">Get ready — you're next in line</p>
              </>
            )}
            <p className="font-mono text-xs text-white/50 mt-8">Tap anywhere to dismiss</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-lg mx-auto px-4 pt-3 pb-1 flex justify-center">
          <img
            src="/Turn_Em_Logo.jpg"
            alt="TurnEM Logo"
            className="h-56 w-auto object-contain"
          />
        </div>
        <div className="max-w-lg mx-auto px-4 pb-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full ring-2 ring-white shadow"
              style={{ backgroundColor: manicurist.color }}
            />
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-bebas text-xl tracking-[1px] text-gray-900 leading-none">{manicurist.name}</h1>
                <button
                  type="button"
                  onClick={handleTogglePush}
                  disabled={pushBusy}
                  title={
                    pushSubscribed
                      ? 'Notifications enabled — tap to disable'
                      : getPermissionState() === 'denied'
                      ? 'Notifications blocked in browser settings'
                      : 'Enable push notifications on this device'
                  }
                  className={`p-0.5 rounded transition-opacity ${pushBusy ? 'opacity-50' : 'opacity-100'}`}
                >
                  {pushSubscribed ? (
                    <Bell size={14} className="text-emerald-500" fill="currentColor" />
                  ) : (
                    <BellOff size={14} className="text-gray-400" />
                  )}
                </button>
              </div>
              <span className={`font-mono text-[10px] font-semibold tracking-wider uppercase ${statusColor}`}>
                {statusLabel}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                handleScreenTap();
                setSoundEnabled(!soundEnabled);
              }}
              className={`flex items-center gap-1 px-2.5 py-2 rounded-lg border font-mono text-xs font-semibold transition-all ${
                soundEnabled
                  ? 'border-emerald-200 text-emerald-600 bg-emerald-50'
                  : 'border-gray-200 text-gray-400'
              }`}
            >
              <Volume2 size={14} />
              {soundEnabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 font-mono text-xs font-semibold transition-all"
            >
              <LogOut size={14} />
              LOGOUT
            </button>
          </div>
        </div>
      </div>

      <div
        className="max-w-lg mx-auto px-4 py-5 space-y-4"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
      >
        {/* Audio activation banner — shows until user taps to activate */}
        {!audioReady && soundEnabled && (
          <button
            onClick={handleScreenTap}
            className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 text-white rounded-2xl p-4 text-center shadow-md active:scale-[0.98] transition-transform"
          >
            <Volume2 size={28} className="mx-auto mb-2" />
            <p className="font-bebas text-2xl tracking-[2px]">TAP TO ACTIVATE SOUND</p>
            <p className="font-mono text-[10px] text-white/70 mt-1">Required for alert sounds on iPhone</p>
          </button>
        )}
        {audioReady && soundEnabled && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl px-4 py-2 text-center">
            <p className="font-mono text-[10px] text-emerald-600 font-semibold">SOUND ACTIVE — alerts will play automatically</p>
          </div>
        )}
        {manicurist.phone && (
          <div className="bg-gray-50 border border-gray-200 rounded-2xl px-4 py-2 flex items-center justify-between">
            <p className="font-mono text-[10px] text-gray-500 font-semibold">
              SMS ALERTS — {manicurist.smsOptIn ? 'you will receive a text when assigned' : 'tap to enable text notifications'}
            </p>
            <button
              onClick={async () => {
                const newVal = !manicurist.smsOptIn;
                await supabase.from('manicurists').update({ sms_opt_in: newVal }).eq('id', manicurist.id);
                dispatch({ type: 'UPDATE_MANICURIST', id: manicurist.id, updates: { smsOptIn: newVal } });
              }}
              className={`ml-3 shrink-0 relative inline-flex h-4 w-7 items-center rounded-full transition-colors duration-200 focus:outline-none ${
                manicurist.smsOptIn ? 'bg-emerald-500' : 'bg-gray-300'
              }`}
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform duration-200 ${
                manicurist.smsOptIn ? 'translate-x-3.5' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
        )}

        {/* Daily Schedule pill — request appointments for today */}
        <DailySchedulePanel manicuristId={manicurist.id} />

        {/* Stats Row */}
        <div className="grid grid-cols-2 gap-3">
          {/* Total Turns */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4 text-center shadow-sm">
            <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider uppercase mb-1">
              {isToday && viewMode === 'day' ? 'TOTAL TURNS' : 'TURNS'}
            </p>
            {/* Follow whatever the list below is showing. This used to always
                print manicurist.totalTurns — the LIVE counter for today — so
                paging back to a past day left the big number on today's total
                while the services list underneath showed the older day. Katelyn
                on 2026-08-12: 7 customers listed for that day, 8.5 turns shown,
                which was that moment's live figure. Her real 8/12 total is 8.0.
                (Tony, 2026-08-14) */}
            <p className="font-bebas text-4xl text-gray-900 leading-none">{turnsShown.toFixed(1)}</p>
          </div>

          {/* Queue Position */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4 text-center shadow-sm">
            <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider uppercase mb-1">QUEUE POSITION</p>
            {manicurist.status === 'busy' ? (
              <p className="font-bebas text-2xl text-red-500 leading-none mt-1">BUSY</p>
            ) : manicurist.status === 'break' ? (
              <p className="font-bebas text-2xl text-amber-500 leading-none mt-1">BREAK</p>
            ) : !manicurist.clockedIn ? (
              <p className="font-bebas text-2xl text-gray-300 leading-none mt-1">OFF</p>
            ) : queuePosition ? (
              <p className="font-bebas text-4xl text-gray-900 leading-none">#{queuePosition}</p>
            ) : (
              <p className="font-bebas text-2xl text-gray-300 leading-none mt-1">—</p>
            )}
          </div>
        </div>

        {/* Break animation */}
        {manicurist.status === 'break' && (
          <div className="text-center py-2">
            <style>{`@keyframes floatBob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }`}</style>
            <img src="/lunch-break.webp" alt="Enjoy your break!" style={{ width: '180px', height: 'auto', display: 'inline-block', animation: 'floatBob 2s ease-in-out infinite' }} />
            <p className="font-bebas text-2xl text-sky-600 tracking-[3px] mt-1">ENJOY YOUR BREAK!</p>
            <button
              type="button"
              onClick={async () => {
                // Staff mode is read-only for the AppContext sync effect, so a
                // local-only dispatch never reaches Supabase and other devices
                // (front desk's "live" screen) never see the change. Mirror
                // the SMS-opt-in pattern: write directly to the DB so realtime
                // broadcasts it, then dispatch locally for an instant UI flip.
                await supabase
                  .from('manicurists')
                  .update({ status: 'available', break_start_time: null })
                  .eq('id', manicurist.id);
                dispatch({ type: 'END_BREAK', id: manicurist.id });
              }}
              className="mt-3 px-6 py-2.5 rounded-full bg-emerald-500 hover:bg-emerald-600 active:scale-[0.98] text-white font-mono text-sm font-bold tracking-wider shadow-sm transition-all"
              aria-label="End break and return to queue"
            >
              I'M BACK
            </button>
          </div>
        )}

        {/* In-progress banner — prominent green panel shown above the
            Services list whenever this manicurist has an active client.
            Mirrors the manicurist "ON" pill style at the top of the
            screen so it's instantly recognizable. */}
        {inProgressEntry && (
          <div className="bg-emerald-50 border-2 border-emerald-500 rounded-2xl shadow-sm p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2 py-0.5 rounded-full bg-emerald-500 text-white font-mono text-[10px] font-bold tracking-wider uppercase leading-none">
                In Service
              </span>
              <span className="font-mono text-base font-bold text-emerald-900 truncate max-w-[180px]">
                {firstName(inProgressEntry.clientName)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {inProgressEntry.services.map((s, i) => {
                const reqList = (inProgressEntry.serviceRequests ?? [])
                  .find((r) => r.service === s && r.clientRequest === true);
                const isRequested = !!reqList && (reqList.manicuristIds?.length ?? 0) > 0;
                return (
                  <span key={`${s}-${i}`} className="inline-flex items-center gap-1">
                    <span className="inline-block px-2.5 py-1 rounded-md bg-white border border-emerald-300 font-mono text-xs text-emerald-700 font-semibold">
                      {s}
                    </span>
                    {isRequested && (
                      <span className="font-mono text-[9px] font-bold bg-purple-500 text-white rounded px-1 py-0.5 leading-none">
                        R
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <span className="font-mono text-[11px] text-emerald-700 font-semibold">
                {(inProgressEntry.turnValue || 0).toFixed(1)} turns
              </span>
              {inProgressEntry.startedAt && (
                <span className="flex items-center gap-1 font-mono text-[11px] text-emerald-700 font-semibold">
                  <Clock size={11} />
                  started {formatTime(inProgressEntry.startedAt)}
                </span>
              )}
            </div>

            {/* DONE — completes this service straight from the phone.
                Two-tap to commit; see doneArmed. */}
            <button
              type="button"
              disabled={doneBusy}
              onClick={async () => {
                if (!doneArmed) { setDoneArmed(true); return; }
                if (doneBusy) return;
                setDoneBusy(true);
                try {
                  const entry = inProgressEntry;
                  // ─── MIRRORS reducer.ts COMPLETE_SERVICE — KEEP IN SYNC ───
                  // Staff mode never syncs state back to Supabase (see
                  // AppContext.tsx "Staff mode is read-only"), so a bare
                  // dispatch would stay on this device. We write the rows
                  // ourselves, then dispatch only to flip this screen. That
                  // makes this a SECOND writer of completed_services with its
                  // own copy of the turn-credit and request rules — chosen
                  // deliberately (Tony, 2026-08-26). Any rule change in the
                  // reducer has to be repeated here or the two will drift.
                  //
                  // Turn credit follows the ASSIGNED tech, not whoever tapped
                  // DONE — the same rule that keeps split work off the wrong
                  // manicurist.
                  const credit =
                    state.manicurists.find((m) => m.id === entry.assignedManicuristId) ?? manicurist;
                  // A service is a REQUEST only when the booking says
                  // clientRequest === true AND the credited tech is the one
                  // requested for it. manicuristIds alone is a parked column.
                  const requestedServices = (entry.serviceRequests ?? [])
                    .filter((r) => r.clientRequest === true && r.manicuristIds?.includes(credit.id))
                    .map((r) => r.service);
                  const wholeEntryRequested =
                    !!entry.isRequested && entry.requestedManicuristId === credit.id;
                  // Fall back to this tech's own requests when services[] is
                  // empty, so History never shows a blank service line.
                  const recordedServices =
                    entry.services && entry.services.length > 0
                      ? entry.services
                      : (entry.serviceRequests ?? [])
                          .filter((r) => r.manicuristIds?.includes(credit.id))
                          .map((r) => r.service);
                  const now = Date.now();
                  // id = the queue entry's own id, exactly as the reducer does,
                  // so a re-fire upserts in place instead of duplicating.
                  const { error: cErr } = await supabase.from('completed_services').upsert({
                    id: entry.id,
                    client_name: entry.clientName,
                    service: recordedServices[0] || '',
                    services: recordedServices,
                    turn_value: entry.turnValue,
                    manicurist_id: credit.id,
                    manicurist_name: credit.name,
                    manicurist_color: credit.color,
                    started_at: new Date(entry.startedAt ?? now).toISOString(),
                    completed_at: new Date(now).toISOString(),
                    requested_services: requestedServices,
                    is_appointment: !!entry.isAppointment,
                    is_requested: wholeEntryRequested,
                    edited: false,
                    voided: false,
                    original_appointment_id: entry.originalAppointment?.id ?? null,
                    manicurist_clock_in_time:
                      credit.clockInTime == null ? null : new Date(credit.clockInTime).toISOString(),
                  }, { onConflict: 'id' });
                  if (cErr) {
                    console.error('[staff portal] DONE: completed_services upsert failed', cErr);
                    setDoneArmed(false);
                    return;
                  }
                  // Only remove the queue entry once the completed row is
                  // safely written — never the other way round, or a failure
                  // here loses the service entirely.
                  const { error: qErr } = await supabase
                    .from('queue_entries').delete().eq('id', entry.id);
                  if (qErr) console.error('[staff portal] DONE: queue delete failed', qErr);
                  const { error: mErr } = await supabase
                    .from('manicurists')
                    .update({ status: 'available', current_client_id: null })
                    .eq('id', manicurist.id);
                  if (mErr) console.error('[staff portal] DONE: manicurist free failed', mErr);
                  dispatch({
                    type: 'COMPLETE_SERVICE',
                    manicuristId: manicurist.id,
                    queueEntryId: entry.id,
                  });
                  setDoneArmed(false);
                } finally {
                  setDoneBusy(false);
                }
              }}
              className={`mt-3 w-full px-6 py-3 rounded-xl active:scale-[0.98] text-white font-mono text-sm font-bold tracking-wider shadow-sm transition-all disabled:opacity-60 ${
                doneArmed ? 'bg-rose-500 hover:bg-rose-600' : 'bg-emerald-500 hover:bg-emerald-600'
              }`}
              aria-label={doneArmed ? 'Tap again to confirm finishing this service' : 'Finish this service'}
            >
              {doneBusy ? 'SAVING…' : doneArmed ? 'TAP AGAIN TO CONFIRM' : "I'M DONE"}
            </button>
          </div>
        )}

        {/* Services History */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          {/* Header with date navigation */}
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <p className="font-mono text-xs font-semibold text-gray-900">Services</p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-gray-400 font-semibold">
                  {viewMode === 'week'
                    ? `${weekRows.reduce((s, r) => s + r.services, 0)} completed`
                    : `${(isToday ? completedToday : historyEntries).reduce(
                        (sum, e) => sum + (e.voided ? 0 : (e.services?.length || 1)),
                        0,
                      )} completed`}
                </span>
                {/* Day / Week toggle */}
                <div className="flex rounded-lg bg-gray-100 p-0.5">
                  {(['day', 'week'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setViewMode(m)}
                      className={`px-2 py-0.5 rounded-md font-mono text-[10px] font-semibold uppercase transition-colors ${
                        viewMode === m ? 'bg-white text-pink-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {viewMode === 'week' && (
              <div className="flex items-center justify-between mt-2">
                <button
                  onClick={() => shiftWeek(-1)}
                  className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <div className="flex items-center gap-2">
                  <span className="font-bebas text-lg text-pink-600 tracking-wider">
                    Week {formatMDY(weekStart)} - {formatMDY(weekEnd)}
                  </span>
                  {!atCurrentWeek && (
                    <button
                      onClick={() => setWeekStart(startOfWeek(todayStr))}
                      className="px-2 py-0.5 rounded-md bg-pink-100 text-pink-600 font-mono text-[10px] font-semibold hover:bg-pink-200 transition-colors"
                    >
                      This week
                    </button>
                  )}
                </div>
                <button
                  onClick={() => shiftWeek(1)}
                  disabled={atCurrentWeek}
                  className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
            <div className={`flex items-center justify-between mt-2 ${viewMode === 'week' ? 'hidden' : ''}`}>
              <button
                onClick={() => shiftDate(-1)}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <div className="flex items-center gap-2">
                <span className="font-bebas text-xl text-pink-600 tracking-wider">
                  {formatDateLabel(selectedDate)}
                </span>
                {!isToday && (
                  <button
                    onClick={() => setSelectedDate(todayStr)}
                    className="px-2 py-0.5 rounded-md bg-pink-100 text-pink-600 font-mono text-[10px] font-semibold hover:bg-pink-200 transition-colors"
                  >
                    Today
                  </button>
                )}
              </div>
              <button
                onClick={() => shiftDate(1)}
                disabled={isToday}
                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          {/* Week view: one row per day, grand total at the bottom. Tapping a
              day drops into the normal day list for that date. */}
          {viewMode === 'week' ? (
            weekLoading ? (
              <div className="px-4 py-8 text-center">
                <p className="font-mono text-xs text-gray-400">Loading...</p>
              </div>
            ) : (
              <div>
                <div className="divide-y divide-gray-50">
                  {weekRows.map((r) => (
                    <button
                      key={r.date}
                      onClick={() => { setSelectedDate(r.date); setViewMode('day'); }}
                      className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-gray-50 transition-colors text-left"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-bold text-gray-900">
                          {new Date(r.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' })}
                          <span className="text-gray-400 font-semibold ml-1.5">{formatMDY(r.date)}</span>
                        </p>
                        <p className="font-mono text-[10px] text-gray-400 font-semibold mt-0.5">
                          {r.services} {r.services === 1 ? 'service' : 'services'}
                        </p>
                      </div>
                      <span className="font-bebas text-xl text-gray-900 leading-none">
                        ${r.dollars.toFixed(0)}
                      </span>
                    </button>
                  ))}
                  {weekRows.length === 0 && (
                    <div className="px-4 py-8 text-center">
                      <CheckCircle size={24} className="mx-auto text-gray-200 mb-2" />
                      <p className="font-mono text-xs text-gray-400">No services recorded this week</p>
                    </div>
                  )}
                </div>
                {weekRows.length > 0 && (
                  <div className="px-4 py-3 border-t-2 border-gray-200 bg-gray-50 flex items-center justify-between gap-3 rounded-b-2xl">
                    <div>
                      <p className="font-mono text-xs font-bold text-gray-900 uppercase tracking-wider">Total</p>
                      <p className="font-mono text-[10px] text-gray-400 font-semibold mt-0.5">
                        {weekRows.reduce((s, r) => s + r.services, 0)} services
                      </p>
                    </div>
                    <span className="font-bebas text-3xl text-pink-600 leading-none">
                      ${weekRows.reduce((s, r) => s + r.dollars, 0).toFixed(0)}
                    </span>
                  </div>
                )}
              </div>
            )
          ) : historyLoading ? (
            <div className="px-4 py-8 text-center">
              <p className="font-mono text-xs text-gray-400">Loading...</p>
            </div>
          ) : (() => {
            const entries = isToday ? completedToday : historyEntries;
            if (entries.length === 0) {
              return (
                <div className="px-4 py-8 text-center">
                  <CheckCircle size={24} className="mx-auto text-gray-200 mb-2" />
                  <p className="font-mono text-xs text-gray-400">
                    {isToday ? 'No services completed yet today' : 'No services recorded for this day'}
                  </p>
                </div>
              );
            }
            return (
              <div className="divide-y divide-gray-50">
                {entries.map((entry) => {
                  const total = entryTotalDollars(entry);
                  const isVoided = !!entry.voided;
                  return (
                    <div key={entry.id} className={`px-4 py-3 flex items-center justify-between gap-3 ${isVoided ? 'opacity-60' : ''}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-sm font-bold text-gray-900 mr-0.5 truncate max-w-[140px]">
                            {firstName(entry.clientName)}
                          </span>
                          {isVoided && (
                            <span className="font-mono text-[9px] font-bold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-0.5 tracking-wider">
                              VOID
                            </span>
                          )}
                          {entry.services.map((s, i) => {
                            // The R normally comes from the per-service list.
                            // Fall back to the entry-level isRequested flag when
                            // that list is empty: the multi-service cleanup in
                            // AppContext (guarding against a past bug that
                            // synthesised requested_services for EVERY service on
                            // a split entry) can't tell a synthetic set from a
                            // genuine one — a client who requests this tech really
                            // does have all their services requested — so it
                            // strips real requests too and the R vanished on every
                            // multi-service request. 7 of today's rows were
                            // flagged requested with an empty list; all 7
                            // confirmed genuine (Tony, 2026-08-14). The flag
                            // survives that cleanup, so it is the reliable signal.
                            // Safe by construction: one entry is one tech, so if
                            // the client requested them, every service on it is
                            // requested.
                            const hasReqList = (entry.requestedServices?.length ?? 0) > 0;
                            const isRequested = hasReqList
                              ? entry.requestedServices!.includes(s)
                              : !!entry.isRequested;
                            return (
                              <span key={`${s}-${i}`} className="inline-flex items-center gap-1">
                                <span className="inline-block px-2 py-0.5 rounded-md bg-pink-50 border border-pink-100 font-mono text-[10px] text-pink-600 font-semibold">
                                  {s}
                                </span>
                                {isRequested && (
                                  <span className="font-mono text-[9px] font-bold bg-purple-500 text-white rounded px-1 py-0.5 leading-none">
                                    R
                                  </span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`font-mono text-[10px] font-semibold ${isVoided ? 'text-gray-400 line-through' : 'text-gray-600'}`}>
                            {entry.turnValue} turns
                          </span>
                          {entry.completedAt == null ? (
                            <span className="font-mono text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-300 rounded px-1.5 py-0.5 leading-none uppercase tracking-wider">
                              In Progress
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 font-mono text-[10px] text-gray-500 font-semibold">
                              <Clock size={9} />
                              {formatTime(entry.completedAt)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <p className="font-mono text-sm font-bold text-gray-900 tabular-nums leading-none">
                          ${total.toFixed(0)}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div className="px-4 py-3 flex items-center justify-between bg-gray-50">
                  <span className="font-mono text-xs font-bold tracking-wider uppercase text-gray-600">
                    Total
                  </span>
                  <span className="font-mono text-base font-bold text-gray-900 tabular-nums">
                    ${entries.reduce((sum, e) => sum + (e.voided ? 0 : entryTotalDollars(e)), 0).toFixed(0)}
                  </span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
