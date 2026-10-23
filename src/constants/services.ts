import type { ServiceCategory, ServiceType } from '../types';

// Legacy fallback turn values for old service names. New services come from
// the salon_services table via the salonServices state slice.
export const SERVICE_TURN_VALUES: Record<ServiceType, number> = {
  'Manicure': 0.5,
  'Pedicure': 1.0,
  'Acrylics/Full': 1.5,
  'Fills': 1.0,
  'Waxing': 0.5,
};

// In-memory fallback for the service_categories table (seeded by
// 20261023120000_service_categories.sql — keep the two in sync). Used only
// when the fetch fails or returns no rows; never written to the DB.
export const DEFAULT_SERVICE_CATEGORIES: ServiceCategory[] = [
  { id: 'acrylic-fill', name: 'Acrylic Fill', color: 'rose', sortOrder: 0, isLocked: false },
  { id: 'acrylic-full-set', name: 'Acrylic Full Set', color: 'rose', sortOrder: 1, isLocked: false },
  { id: 'healthy-nails', name: 'Healthy Nails', color: 'emerald', sortOrder: 2, isLocked: false },
  { id: 'manicures', name: 'Manicures', color: 'sky', sortOrder: 3, isLocked: false },
  { id: 'pedicures', name: 'Pedicures', color: 'sky', sortOrder: 4, isLocked: false },
  { id: 'combo', name: 'Combo', color: 'amber', sortOrder: 5, isLocked: true },
  { id: 'kids-services', name: 'Kids Services', color: 'pink', sortOrder: 6, isLocked: false },
  { id: 'a-la-carte-add-ons', name: 'A La Carte & Add-Ons', color: 'teal', sortOrder: 7, isLocked: false },
  { id: 'wax-services', name: 'Wax Services', color: 'orange', sortOrder: 8, isLocked: true },
  { id: 'special-request', name: 'Special Request', color: 'purple', sortOrder: 9, isLocked: false },
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
