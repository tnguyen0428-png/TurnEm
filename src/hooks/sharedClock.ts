// sharedClock — single 1Hz "now" pulse the timer hooks subscribe to.
//
// Before this module existed, every component using useElapsedTime or
// useCountdown spun up its own setInterval. On the queue tab that meant
// ~18 timers firing every second (one per ManicuristCard) plus more for
// any countdown badges. Each tick fired a setState in that component.
//
// This module exposes the contract React's useSyncExternalStore wants
// (subscribe + snapshot) backed by a single shared interval. The interval
// only runs while at least one subscriber is attached, and stops when the
// last consumer unmounts.

let listeners = new Set<() => void>();
let now = Date.now();
let intervalId: ReturnType<typeof setInterval> | null = null;

function tick() {
  now = Date.now();
  // Copy the set so listener side-effects don't mutate iteration order.
  for (const fn of Array.from(listeners)) fn();
}

export function subscribeToClock(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    // Align first tick to the start of the next wall-clock second so all
    // consumers visibly tick in sync. Within ~16ms we then settle into
    // the steady 1s cadence.
    const msIntoSecond = Date.now() % 1000;
    const delay = msIntoSecond === 0 ? 1000 : 1000 - msIntoSecond;
    const timeoutId = setTimeout(() => {
      tick();
      intervalId = setInterval(tick, 1000);
    }, delay);
    // Treat the initial setTimeout as the active timer so we can clear it
    // on early unsubscribe.
    intervalId = timeoutId as unknown as ReturnType<typeof setInterval>;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      clearTimeout(intervalId as unknown as ReturnType<typeof setTimeout>);
      intervalId = null;
    }
  };
}

export function getClockNow(): number {
  return now;
}
