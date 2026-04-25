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
