import { Clock } from 'lucide-react';
import { useCountdown } from '../../hooks/useCountdown';

interface CountdownBadgeProps {
  startedAt: number | null;
  totalDurationMs: number;
  status: string;
}

export default function CountdownBadge({ startedAt, totalDurationMs, status }: CountdownBadgeProps) {
  const { display, isFinishingUp } = useCountdown(startedAt, totalDurationMs);

  if (status !== 'busy' || !startedAt) return null;

  if (isFinishingUp) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[10px] font-semibold bg-red-200 text-red-900 animate-pulse tabular-nums">
        <Clock size={9} />
        Finishing up
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
