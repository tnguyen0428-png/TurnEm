import { useSyncExternalStore } from 'react';
import { subscribeToClock, getClockNow } from './sharedClock';

/**
 * Returns "M:SS" elapsed time since `startedAt`. Subscribes to a single
 * shared 1Hz clock — N consumers cost one setInterval, not N.
 */
export function useElapsedTime(startedAt: number | null): string {
  const now = useSyncExternalStore(subscribeToClock, getClockNow, getClockNow);

  if (startedAt === null) return '';

  const elapsedMs = Math.max(0, now - startedAt);
  const totalSecs = Math.floor(elapsedMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
