import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Nightly History Save — runs daily at 21:00 America/Los_Angeles (via pg_cron).
 *
 * Reads all rows from completed_services whose completed_at falls on today's
 * date in the America/Los_Angeles timezone, maps them to the CompletedEntry
 * shape the front-end expects, then upserts a single row into daily_history
 * keyed by date.
 *
 * After archival, prunes:
 *   1. completed_services rows whose completed_at is older than
 *      COMPLETED_RETENTION_DAYS (10) days — keeps the live service list lean.
 *   2. daily_history rows whose date is older than HISTORY_RETENTION_DAYS
 *      (10) days — ages out the archive so it doesn't grow forever.
 *
 * Today's rows in completed_services are NOT cleared — the manual "clear" via
 * the UI is still the intended flow for end-of-day reset.
 */

/** How many days of completed_services rows to retain before nightly purge. */
const COMPLETED_RETENTION_DAYS = 10;

/** How many days of daily_history rows to retain before nightly purge. */
const HISTORY_RETENTION_DAYS = 10;

// MUST stay in sync with mapDbCompleted() in src/state/AppContext.tsx. This
// archive is one of the LAST writers each night (the merge below lets fresh
// rows win on conflict), so any field missing here is silently erased from the
// day's history even when a client already saved it correctly.
//
// That is exactly what happened before 2026-08-13: only the first nine fields
// plus manicuristClockInTime were mapped, so every archived entry lost
// priceCents, voided, edited, isAppointment, isRequested and requestedServices.
// Measured consequences:
//   • priceCents gone → the staff portal fell through to CATALOG list price for
//     every past day, understating staff earnings (~$2.6k across 8/02–8/08
//     alone; every tech low, never high, because upcharges are invisible to the
//     catalog — Gel Fill lists $40 but averaged $51.83).
//   • voided gone → an archived voided row reads back as `undefined` (falsy)
//     and is counted as real work and real turns.
// If you add a column to completed_services, add it here too.
interface CompletedEntry {
  id: string;
  clientName: string;
  services: string[];
  turnValue: number;
  manicuristId: string;
  manicuristName: string;
  manicuristColor: string;
  startedAt: number;   // ms since epoch
  completedAt: number; // ms since epoch
  // Frozen clock-in time of the crediting manicurist, so a past-day History
  // view can replay "Turns per Manicurist" in clock-in order regardless of
  // completion order. Was missing from this function entirely (only ever
  // lived on the client + completed_services column) — since
  // scheduled_morning_reset() runs ~2h after this function and OVERWRITES
  // daily_history.entries wholesale, whichever of the two ran last decided
  // the persisted order, and neither carried this field before, so the list
  // kept reshuffling every night no matter what the client-side fix did.
  manicuristClockInTime: number | null;
  requestedServices?: string[];
  isAppointment: boolean;
  isRequested: boolean;
  edited: boolean;
  /** Load-bearing: turn totals skip voided rows. Absent reads as false. */
  voided: boolean;
  /** Real checkout price snapshotted by trg_sync_completed_service_prices. */
  priceCents: number | null;
}

/** Returns today's date string (YYYY-MM-DD) in the America/Los_Angeles timezone. */
function getTodayLA(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

Deno.serve(async (_req: Request) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[nightly-save-history] Missing env vars");
      return new Response(JSON.stringify({ error: "Missing env vars" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Service role bypasses RLS so we can read and write freely.
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const todayLA = getTodayLA(); // e.g. "2026-04-05"
    console.log(`[nightly-save-history] Saving history for ${todayLA}`);

    // Query completed_services rows whose completed_at is today in LA time.
    const { data: rows, error: fetchError } = await supabase
      .from("completed_services")
      .select("*")
      .gte(
        "completed_at",
        new Date(`${todayLA}T00:00:00-08:00`).toISOString(),
      )
      .lt(
        "completed_at",
        new Date(`${todayLA}T00:00:00-07:00`).toISOString(),
      );

    const todayRows = (rows ?? []).filter((row) => {
      const completedAt = new Date(row.completed_at as string);
      const dateInLA = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(completedAt);
      return dateInLA === todayLA;
    });

    if (fetchError) {
      console.error("[nightly-save-history] Fetch error:", fetchError.message);
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    async function purgeOldCompletedServices(): Promise<{ purged: number; error?: string }> {
      const cutoff = new Date(Date.now() - COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("completed_services")
        .delete()
        .lt("completed_at", cutoff)
        .select("id");
      if (error) {
        console.error(`[nightly-save-history] Purge error (older than ${COMPLETED_RETENTION_DAYS}d):`, error.message);
        return { purged: 0, error: error.message };
      }
      console.log(`[nightly-save-history] ✓ Purged ${data?.length ?? 0} completed_services rows older than ${COMPLETED_RETENTION_DAYS} days (cutoff ${cutoff})`);
      return { purged: data?.length ?? 0 };
    }

    async function purgeOldDailyHistory(): Promise<{ purged: number; error?: string }> {
      const cutoffMs = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const cutoffDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(cutoffMs));
      const { data, error } = await supabase
        .from("daily_history")
        .delete()
        .lt("date", cutoffDate)
        .select("id");
      if (error) {
        console.error(`[nightly-save-history] daily_history purge error (older than ${HISTORY_RETENTION_DAYS}d):`, error.message);
        return { purged: 0, error: error.message };
      }
      console.log(`[nightly-save-history] ✓ Purged ${data?.length ?? 0} daily_history rows older than ${HISTORY_RETENTION_DAYS} days (cutoff ${cutoffDate})`);
      return { purged: data?.length ?? 0 };
    }

    // Sort archived + merged entries by the crediting manicurist's frozen
    // clock-in stamp (nulls last), matching the client-side saveTodayHistory
    // ordering, so "Turns per Manicurist" replays in clock-in order regardless
    // of the order completed_services rows came back in.
    function sortByClockIn(list: CompletedEntry[]): CompletedEntry[] {
      return [...list].sort((a, b) => {
        const aTime = a.manicuristClockInTime ?? Number.POSITIVE_INFINITY;
        const bTime = b.manicuristClockInTime ?? Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
    }

    if (todayRows.length === 0) {
      console.log("[nightly-save-history] No completed services today — skipping upsert.");
      const completedPurge = await purgeOldCompletedServices();
      const historyPurge = await purgeOldDailyHistory();
      return new Response(
        JSON.stringify({
          ok: true,
          date: todayLA,
          saved: 0,
          purgedCompleted: completedPurge.purged,
          purgedHistory: historyPurge.purged,
          completedRetentionDays: COMPLETED_RETENTION_DAYS,
          historyRetentionDays: HISTORY_RETENTION_DAYS,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const entries: CompletedEntry[] = todayRows.map((row) => ({
      id: row.id as string,
      clientName: (row.client_name as string) ?? "Walk-in",
      services: (row.services as string[]) ?? (row.service ? [row.service as string] : []),
      turnValue: Number(row.turn_value ?? 0),
      manicuristId: (row.manicurist_id as string) ?? "",
      manicuristName: (row.manicurist_name as string) ?? "",
      manicuristColor: (row.manicurist_color as string) ?? "#9ca3af",
      startedAt: new Date(row.started_at as string).getTime(),
      completedAt: new Date(row.completed_at as string).getTime(),
      manicuristClockInTime: row.manicurist_clock_in_time
        ? new Date(row.manicurist_clock_in_time as string).getTime()
        : null,
      // Everything below was previously dropped. `.select("*")` above already
      // fetched these columns — only the mapping omitted them. See the note on
      // CompletedEntry; voided and priceCents in particular are load-bearing
      // for turn counts and staff earnings.
      requestedServices: (row.requested_services as string[]) ?? undefined,
      isAppointment: (row.is_appointment as boolean) || false,
      isRequested: (row.is_requested as boolean) || false,
      edited: (row.edited as boolean) || false,
      voided: (row.voided as boolean) || false,
      priceCents: row.price_cents == null ? null : Number(row.price_cents),
    }));

    // MERGE rather than overwrite. daily_history is one row per date; a blind
    // replace would erase any entries already saved (e.g. via the in-app "Save
    // Today" button or an earlier run) that aren't in completed_services right
    // now — a contributor to the 6/5 turn loss. Read the current row, union by
    // entry id, and let the freshly-archived rows win on conflict while never
    // dropping ids that were saved earlier.
    const { data: existingRow } = await supabase
      .from("daily_history")
      .select("entries")
      .eq("date", todayLA)
      .maybeSingle();
    const mergedById = new Map<string, CompletedEntry>();
    const existingEntries = (existingRow?.entries as CompletedEntry[] | null) ?? [];
    for (const e of existingEntries) {
      if (e && (e as { id?: string }).id) mergedById.set((e as { id: string }).id, e);
    }
    for (const e of entries) mergedById.set(e.id, e);
    const mergedEntries = sortByClockIn(Array.from(mergedById.values()));
    console.log(`[nightly-save-history] Merge: ${existingEntries.length} existing + ${entries.length} fresh → ${mergedEntries.length} total for ${todayLA}`);

    const { error: upsertError } = await supabase
      .from("daily_history")
      .upsert({ date: todayLA, entries: mergedEntries }, { onConflict: "date" });

    if (upsertError) {
      console.error("[nightly-save-history] Upsert error:", upsertError.message);
      return new Response(JSON.stringify({ error: upsertError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`[nightly-save-history] ✓ Saved ${mergedEntries.length} entries for ${todayLA}`);

    const completedPurge = await purgeOldCompletedServices();
    const historyPurge = await purgeOldDailyHistory();

    return new Response(
      JSON.stringify({
        ok: true,
        date: todayLA,
        saved: mergedEntries.length,
        purgedCompleted: completedPurge.purged,
        purgedHistory: historyPurge.purged,
        completedRetentionDays: COMPLETED_RETENTION_DAYS,
        historyRetentionDays: HISTORY_RETENTION_DAYS,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[nightly-save-history] Unexpected error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
