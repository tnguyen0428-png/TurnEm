interface BadgeProps {
  label: string;
  variant: 'green' | 'blue' | 'amber' | 'orange' | 'purple' | 'pink' | 'red' | 'gray' | 'indigo';
  size?: 'sm' | 'md';
}

const VARIANT_CLASSES: Record<BadgeProps['variant'], string> = {
  green: 'bg-emerald-100 text-emerald-700',
  blue: 'bg-blue-100 text-blue-700',
  amber: 'bg-amber-100 text-amber-700',
  orange: 'bg-orange-100 text-orange-700',
  purple: 'bg-purple-100 text-purple-700',
  pink: 'bg-pink-100 text-pink-700',
  red: 'bg-red-100 text-red-700',
  gray: 'bg-gray-100 text-gray-600',
  indigo: 'bg-indigo-100 text-indigo-700',
};

export default function Badge({ label, variant, size = 'sm' }: BadgeProps) {
  const sizeClass = size === 'sm' ? 'text-[10px] px-2 py-0.5' : 'text-xs px-2.5 py-1';
  return (
    <span className={`inline-flex items-center rounded-full font-mono font-semibold tracking-wide uppercase ${sizeClass} ${VARIANT_CLASSES[variant]}`}>
      {label}
    </span>
  );
}
