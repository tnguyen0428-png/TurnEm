import type { ServiceType } from '../types';

export const SERVICE_TURN_VALUES: Record<ServiceType, number> = {
  'Manicure': 0.5,
  'Pedicure': 1.0,
  'Acrylics/Full': 1.5,
  'Fills': 1.0,
  'Waxing': 0.5,
};

export const REQUESTED_PER_SERVICE_VALUE = 0.5;

export function getRequestedTurnValue(
  services: ServiceType[],
  salonServices: { name: string; turnValue: number }[] = []
): number {
  return services.reduce((sum, s) => {
    const dynamic = salonServices.find((sv) => sv.name === s);
    const val = dynamic?.turnValue ?? SERVICE_TURN_VALUES[s] ?? REQUESTED_PER_SERVICE_VALUE;
    return sum + (val >= 0.5 ? REQUESTED_PER_SERVICE_VALUE : val);
  }, 0);
}

export const ALL_SERVICES: ServiceType[] = [
  'Manicure',
  'Pedicure',
  'Acrylics/Full',
  'Fills',
  'Waxing',
];

export const SERVICE_CATEGORIES = [
  'Acrylic Fill',
  'Acrylic Full Set',
  'Healthy Nails',
  'Manicures',
  'Pedicures',
  'Combo',
  'Kids Services',
  'A La Carte & Add-Ons',
  'Wax Services',
  'Special Request',
];

export const STAFF_COLORS = [
  '#10b981',
  '#6366f1',
  '#f59e0b',
  '#ec4899',
  '#ef4444',
  '#3b82f6',
  '#8b5cf6',
  '#14b8a6',
];
