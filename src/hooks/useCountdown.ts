import { useSyncExternalStore } from 'react';
import { subscribeToClock, getClockNow } from './sharedClock';
import { getAlmostDoneWindowMs } from '../utils/time';

interface CountdownResult {
  remainingMs: number | null;
  display: string;
  isFinishingUp: boolean;
  isAlmostDone: boolean;
}

export function useCountdown(startedAt: number | null, totalDurationMs: number): CountdownResult {
  // Single shared 1Hz clock — no per-instance setInterval.
  const now = useSyncExternalStore(subscribeToClock, getClockNow, getClockNow);

  if (startedAt === null) {
    return { remainingMs: null, display: '', isFinishingUp: false, isAlmostDone: false };
  }

  const remainingMs = startedAt + totalDurationMs - now;
  const isFinishingUp = remainingMs <= 0;
  // Measured against the shared clock rather than Date.now(), so the window
  // widens the moment that clock ticks past the cutoff — no stale render.
  const isAlmostDone = !isFinishingUp && remainingMs <= getAlmostDoneWindowMs(now);

  let display: string;
  if (isFinishingUp) {
    display = 'Finishing up';
  } else {
    const totalSecs = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    display = `${mins}:${String(secs).padStart(2, '0')}`;
  }

  return { remainingMs, display, isFinishingUp, isAlmostDone };
}
