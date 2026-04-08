import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
}

export default function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="text-gray-300 mb-4">{icon}</div>
      <p className="font-mono text-sm font-semibold text-gray-400 mb-1">{title}</p>
      {description && (
        <p className="font-mono text-xs text-gray-400">{description}</p>
      )}
    </div>
  );
}
