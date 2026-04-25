import type { ServiceType } from '../types';

// Legacy fallback turn values for old service names. New services come from
// the salon_services table via the salonServices state slice.
export const SERVICE_TURN_VALUES: Record<ServiceType, number> = {
  'Manicure': 0.5,
  'Pedicure': 1.0,
  'Acrylics/Full': 1.5,
  'Fills': 1.0,
  'Waxing': 0.5,
};

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
  // Pinks & Reds
  '#ec4899', '#f43f5e', '#e11d48', '#ef4444', '#dc2626', '#fb7185',
  // Oranges & Ambers
  '#f97316', '#f59e0b', '#fbbf24', '#fb923c', '#ea580c',
  // Yellows & Limes
  '#eab308', '#a3e635', '#84cc16', '#65a30d',
  // Greens
  '#22c55e', '#10b981', '#059669', '#14b8a6', '#0d9488',
  // Blues & Cyans
  '#06b6d4', '#0ea5e9', '#3b82f6', '#2563eb', '#1d4ed8',
  // Indigos & Purples
  '#6366f1', '#4f46e5', '#8b5cf6', '#7c3aed', '#a855f7', '#9333ea',
  // Pinks & Fuchsias
  '#d946ef', '#c026d3', '#e879f9',
  // Neutrals & Slate
  '#64748b', '#475569', '#6b7280', '#0f172a',
];
