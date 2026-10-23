// Tailwind classes for each service-category color key (service_categories.color).
// Every class is a full literal string on purpose: Tailwind's purge only keeps
// classes it can see verbatim, so `bg-${color}-500` would silently vanish.
export interface CategoryColorClasses {
  icon: string;
  tabActive: string;
  tabInactive: string;
  swatch: string;
}

export const CATEGORY_PALETTE: Record<string, CategoryColorClasses> = {
  rose:    { icon: 'bg-rose-50 text-rose-500',       tabActive: 'bg-rose-500 text-white',    tabInactive: 'bg-white text-rose-600 hover:bg-rose-50',       swatch: 'bg-rose-500' },
  emerald: { icon: 'bg-emerald-50 text-emerald-500', tabActive: 'bg-emerald-500 text-white', tabInactive: 'bg-white text-emerald-600 hover:bg-emerald-50', swatch: 'bg-emerald-500' },
  sky:     { icon: 'bg-sky-50 text-sky-500',         tabActive: 'bg-sky-500 text-white',     tabInactive: 'bg-white text-sky-600 hover:bg-sky-50',         swatch: 'bg-sky-500' },
  amber:   { icon: 'bg-amber-50 text-amber-500',     tabActive: 'bg-amber-500 text-white',   tabInactive: 'bg-white text-amber-600 hover:bg-amber-50',     swatch: 'bg-amber-500' },
  pink:    { icon: 'bg-pink-50 text-pink-500',       tabActive: 'bg-pink-500 text-white',    tabInactive: 'bg-white text-pink-600 hover:bg-pink-50',       swatch: 'bg-pink-500' },
  teal:    { icon: 'bg-teal-50 text-teal-500',       tabActive: 'bg-teal-500 text-white',    tabInactive: 'bg-white text-teal-600 hover:bg-teal-50',       swatch: 'bg-teal-500' },
  orange:  { icon: 'bg-orange-50 text-orange-500',   tabActive: 'bg-orange-500 text-white',  tabInactive: 'bg-white text-orange-600 hover:bg-orange-50',   swatch: 'bg-orange-500' },
  purple:  { icon: 'bg-purple-50 text-purple-500',   tabActive: 'bg-purple-500 text-white',  tabInactive: 'bg-white text-purple-600 hover:bg-purple-50',   swatch: 'bg-purple-500' },
  gray:    { icon: 'bg-gray-50 text-gray-500',       tabActive: 'bg-gray-500 text-white',    tabInactive: 'bg-white text-gray-600 hover:bg-gray-50',       swatch: 'bg-gray-500' },
  red:     { icon: 'bg-red-50 text-red-500',         tabActive: 'bg-red-500 text-white',     tabInactive: 'bg-white text-red-600 hover:bg-red-50',         swatch: 'bg-red-500' },
  lime:    { icon: 'bg-lime-50 text-lime-500',       tabActive: 'bg-lime-500 text-white',    tabInactive: 'bg-white text-lime-600 hover:bg-lime-50',       swatch: 'bg-lime-500' },
  indigo:  { icon: 'bg-indigo-50 text-indigo-500',   tabActive: 'bg-indigo-500 text-white',  tabInactive: 'bg-white text-indigo-600 hover:bg-indigo-50',   swatch: 'bg-indigo-500' },
  fuchsia: { icon: 'bg-fuchsia-50 text-fuchsia-500', tabActive: 'bg-fuchsia-500 text-white', tabInactive: 'bg-white text-fuchsia-600 hover:bg-fuchsia-50', swatch: 'bg-fuchsia-500' },
  slate:   { icon: 'bg-slate-50 text-slate-500',     tabActive: 'bg-slate-500 text-white',   tabInactive: 'bg-white text-slate-600 hover:bg-slate-50',     swatch: 'bg-slate-500' },
};

export function paletteFor(color: string | undefined): CategoryColorClasses {
  return (color && CATEGORY_PALETTE[color]) || CATEGORY_PALETTE.gray;
}
