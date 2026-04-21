import { Clock } from 'lucide-react';
import { useCountdown } from '../../hooks/useCountdown';

interface CountdownBadgeProps {
  startedAt: number | null;
  totalDurationMs: number;
  status: string;
}

export default function CountdownBadge({ startedAt, totalDurationMs, status }: CountdownBadgeProps) {
  const { display, isFinishingUp, isAlmostDone } = useCountdown(startedAt, totalDurationMs);

  if (status !== 'busy' || !startedAt) return null;

  if (isFinishingUp) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-mono text-[11px] font-bold bg-red-500 text-white animate-pulse tabular-nums shadow-sm">
        <Clock size={10} />
        Finishing up
      </span>
    );
  }

  if (isAlmostDone) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-mono text-[11px] font-bold bg-orange-500 text-white tabular-nums shadow-sm">
        <Clock size={10} />
        {display} — Almost done
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-amber-100 text-amber-900 tabular-nums">
      <Clock size={9} />
      {display}
    </span>
  );
}
