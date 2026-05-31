import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * No-op auth lock. Replaces supabase-js's default Web Locks coordination,
 * which is intended to dedupe token refresh across multiple tabs but in
 * practice can deadlock the entire auth subsystem if any single auth call
 * hangs (the lock is held for the full duration of the promise). When that
 * happens, every subsequent getSession()/signIn()/signUp() in any tab queues
 * forever and the app is stuck on "Checking session..." or hangs sign-in
 * until the user navigates to a different origin and back.
 *
 * We don't run multiple tabs of the same logged-in user simultaneously in a
 * way that requires refresh-coordination, so dropping the lock is safe and
 * eliminates the deadlock class of bug entirely.
 */
const noLock = async <R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> => fn();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    lock: noLock,
  },
});

/**
 * Paginate a Supabase select query to bypass PostgREST's default 1000-row Range
 * cap. supabase-js sets `Range: 0-999` on every request unless an explicit
 * `.range()` is provided; without pagination a table that crosses 1000 rows
 * silently truncates and rows go missing in the UI (appointments crossed this
 * threshold on 2026-05-30 and dropped ~50 of today's bookings).
 *
 * Call with a builder factory that returns a fresh query each iteration:
 *
 *     const { data, error } = await fetchAllRows(() =>
 *       supabase.from('appointments').select('*').order('created_at')
 *     );
 *
 * The factory pattern is required because supabase-js builders are thenables
 * that get consumed when awaited — each page needs a brand-new builder.
 *
 * Iteration is capped at 50 pages (50k rows) defensively to avoid hanging if
 * an upstream bug ever makes pages return non-empty forever.
 */
export async function fetchAllRows<T = Record<string, unknown>>(
  buildQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<{ data: T[] | null; error: unknown }> {
  const PAGE = 1000;
  const all: T[] = [];
  let from = 0;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { data: all, error: null };
}
