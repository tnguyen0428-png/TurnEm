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
    // We cast to the LA timezone in Postgres via a raw filter on the text
    // representation, since Supabase JS client doesn't expose AT TIME ZONE.
    // The date range covers the full UTC day-span for LA local midnight–midnight.
    const { data: rows, error: fetchError } = await supabase
      .from("completed_services")
      .select("*")
      .gte(
        "completed_at",
        new Date(`${todayLA}T00:00:00-08:00`).toISOString(), // PST start (safe for both PST/PDT)
      )
      .lt(
        "completed_at",
        new Date(`${todayLA}T00:00:00-07:00`).toISOString(), // PDT end next day
      );

    // The range above over-selects by one hour around the DST boundary.
    // Filter precisely in JS using Intl.
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

    // Inline helpers so we can run the retention purges whether or not we
    // have anything to archive for today.
    async function purgeOldCompletedServices(): Promise<{
      purged: number;
      error?: string;
    }> {
      const cutoff = new Date(
        Date.now() - COMPLETED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data, error } = await supabase
        .from("completed_services")
        .delete()
        .lt("completed_at", cutoff)
        .select("id");
      if (error) {
        console.error(
          `[nightly-save-history] Purge error (older than ${COMPLETED_RETENTION_DAYS}d):`,
          error.message,
        );
        return { purged: 0, error: error.message };
      }
      console.log(
        `[nightly-save-history] ✓ Purged ${data?.length ?? 0} completed_services rows older than ${COMPLETED_RETENTION_DAYS} days (cutoff ${cutoff})`,
      );
      return { purged: data?.length ?? 0 };
    }

    /**
     * Delete daily_history rows whose `date` (YYYY-MM-DD) is older than
     * HISTORY_RETENTION_DAYS days from today's LA date. We compute the cutoff
     * date string in LA time so it lines up with how rows are keyed.
     */
    async function purgeOldDailyHistory(): Promise<{
      purged: number;
      error?: string;
    }> {
      // Compute the cutoff date string in LA time (YYYY-MM-DD). Anything with
      // date < cutoffDate gets dropped.
      const cutoffMs =
        Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
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
        console.error(
          `[nightly-save-history] daily_history purge error (older than ${HISTORY_RETENTION_DAYS}d):`,
          error.message,
        );
        return { purged: 0, error: error.message };
      }
      console.log(
        `[nightly-save-history] ✓ Purged ${data?.length ?? 0} daily_history rows older than ${HISTORY_RETENTION_DAYS} days (cutoff ${cutoffDate})`,
      );
      return { purged: data?.length ?? 0 };
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

    // Map DB rows → CompletedEntry (camelCase + ms timestamps), matching the
    // shape loadInitialData reads back from daily_history.entries.
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
    }));

    // Upsert one row per date — onConflict matches the UNIQUE(date) constraint.
    const { error: upsertError } = await supabase
      .from("daily_history")
      .upsert(
        { id: crypto.randomUUID(), date: todayLA, entries },
        { onConflict: "date" },
      );

    if (upsertError) {
      console.error("[nightly-save-history] Upsert error:", upsertError.message);
      return new Response(JSON.stringify({ error: upsertError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(
      `[nightly-save-history] ✓ Saved ${entries.length} entries for ${todayLA}`,
    );

    // ── Retention purge ──────────────────────────────────────────────────
    // Drop completed_services rows older than COMPLETED_RETENTION_DAYS, and
    // age out daily_history rows older than HISTORY_RETENTION_DAYS. Errors are
    // logged but do not fail the response — archival already succeeded.
    const completedPurge = await purgeOldCompletedServices();
    const historyPurge = await purgeOldDailyHistory();

    return new Response(
      JSON.stringify({
        ok: true,
        date: todayLA,
        saved: entries.length,
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
