// clientNaming.ts
//
// Shared duplicate-name disambiguation for clients. The salon often doesn't
// store last names (unless it's a request), so two different people with the
// same first name legitimately coexist — on the floor and in the appointment
// book. To keep them distinguishable we auto-number the later one: a second
// "Christy" becomes "Christy 2", a third "Christy 3", etc.
//
// Used by both the floor ADD CLIENT modal and the appointment-book booking
// modal so the numbering rules stay identical in both places.

// Normalize a name for "same client" comparison: trim + collapse internal
// whitespace + lowercase. So "Sally  " === "sally" === "Sally".
export function normName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Strip a trailing " <digits>" suffix so "Sally 3" → "Sally". Lets us count
// duplicates against the bare base name regardless of which numbered variant
// was typed in.
export function stripSuffix(s: string): string {
  return s.trim().replace(/\s+\d+$/, '');
}

// Build the next free numbered name. If the bare base "Sally" already appears
// in `existing` (with or without numbered siblings), return the next free
// "Sally N" — N starts at 2 because the original counts as #1.
export function pickNextSuffix(baseName: string, existing: string[]): string {
  const bare = stripSuffix(baseName);
  const bareKey = normName(bare);
  if (!bareKey) return baseName.trim();
  const taken = new Set<number>();
  for (const n of existing) {
    if (normName(n) === bareKey) {
      taken.add(1);
      continue;
    }
    // Match "<base> <digits>" where <base> normalizes to the bare key.
    const m = n.trim().match(/^(.*?)\s+(\d+)$/);
    if (m && normName(m[1]) === bareKey) {
      const num = parseInt(m[2], 10);
      if (Number.isFinite(num) && num >= 1) taken.add(num);
    }
  }
  let next = 2;
  while (taken.has(next)) next++;
  return `${bare} ${next}`;
}

/**
 * Return a unique display name for `entered` given the names already present
 * in `existing`. If `entered` collides with an existing name (by bare base),
 * returns the next free "Name N"; otherwise returns the trimmed entered name
 * unchanged. Comparing the result against `entered.trim()` tells you whether a
 * collision occurred (useful for showing a confirm prompt).
 */
export function dedupeClientName(entered: string, existing: string[]): string {
  const key = normName(entered);
  if (!key) return entered.trim();
  const collides = existing.some((n) => normName(n) === key);
  return collides ? pickNextSuffix(entered, existing) : entered.trim();
}
