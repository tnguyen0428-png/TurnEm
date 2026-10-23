import type { Manicurist, ServiceCategory } from '../types';

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

/** Skill / time-adjustment changes for saving a service: applies the "staff
 *  who do this service" checkboxes (only for `listedIds`) and carries a rename
 *  from oldName to newName. Both fields are keyed by service NAME. Returns only
 *  the manicurists that actually change. */
export function staffSkillUpdates(
  manicurists: Manicurist[],
  listedIds: Set<string>,
  wantedIds: Set<string>,
  oldName: string | null,
  newName: string,
): { id: string; skills: string[]; timeAdjustments: Record<string, number> }[] {
  const renamed = !!oldName && oldName !== newName;
  const out: { id: string; skills: string[]; timeAdjustments: Record<string, number> }[] = [];
  for (const m of manicurists) {
    let skills = renamed && m.skills.includes(oldName!)
      ? m.skills.map((sk) => (sk === oldName ? newName : sk))
      : m.skills;
    if (listedIds.has(m.id)) {
      const want = wantedIds.has(m.id);
      const has = skills.includes(newName);
      if (want && !has) skills = [...skills, newName];
      if (!want && has) skills = skills.filter((sk) => sk !== newName);
    }
    let timeAdjustments = m.timeAdjustments;
    if (renamed && timeAdjustments && oldName! in timeAdjustments) {
      timeAdjustments = Object.fromEntries(
        Object.entries(timeAdjustments).map(([k, v]) => [k === oldName ? newName : k, v]),
      );
    }
    if (skills !== m.skills || timeAdjustments !== m.timeAdjustments) {
      out.push({ id: m.id, skills, timeAdjustments });
    }
  }
  return out;
}
