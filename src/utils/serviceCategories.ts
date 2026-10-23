import type { ServiceCategory } from '../types';

/** Why a category name can't be used, or null if it's fine. service_categories.name
 *  is UNIQUE in the DB, so duplicates are refused case-insensitively up front
 *  rather than surfacing later as a sync error. */
export function categoryNameProblem(
  categories: ServiceCategory[],
  name: string,
  exceptId?: string,
): 'empty' | 'duplicate' | null {
  const n = name.trim().toLowerCase();
  if (!n) return 'empty';
  if (categories.some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === n)) return 'duplicate';
  return null;
}

/** Slug id for a new category ('Gel X' → 'gel-x'), suffixed -2, -3… if taken. */
export function newCategoryId(name: string, categories: ServiceCategory[]): string {
  const base = name.trim().toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'category';
  const taken = new Set(categories.map((c) => c.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
