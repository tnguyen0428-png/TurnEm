import { useState, useEffect } from 'react';

interface CountdownResult {
  remainingMs: number | null;
  display: string;
  isFinishingUp: boolean;
}

export function useCountdown(startedAt: number | null, totalDurationMs: number): CountdownResult {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (startedAt === null) {
    return { remainingMs: null, display: '', isFinishingUp: false };
  }

  const remainingMs = startedAt + totalDurationMs - now;
  const isFinishingUp = remainingMs <= 0;

  let display: string;
  if (isFinishingUp) {
    display = 'Finishing up';
  } else {
    const totalSecs = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    display = `${mins}:${String(secs).padStart(2, '0')}`;
  }

  return { remainingMs, display, isFinishingUp };
}
