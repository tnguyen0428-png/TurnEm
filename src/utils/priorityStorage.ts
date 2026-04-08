export const CAT_PRIORITY_KEY = 'turnem_category_priority';
export const SVC_PRIORITY_KEY = 'turnem_service_priority';

export function loadCatOrder(allCats: string[]): string[] {
  try {
    const raw = localStorage.getItem(CAT_PRIORITY_KEY);
    if (raw) {
      const saved: string[] = JSON.parse(raw);
      const known = new Set(saved);
      const merged = saved.filter((c) => allCats.includes(c));
      allCats.forEach((c) => { if (!known.has(c)) merged.push(c); });
      return merged;
    }
  } catch {}
  return [...allCats];
}

export function loadSvcOrders(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(SVC_PRIORITY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

/**
 * Returns a numeric sort key for a service based on the localStorage priority order.
 * Category rank * 10000 + service rank within category.
 * Falls back to a large number if not found.
 */
export function getPriorityRank(
  serviceName: string,
  serviceCategory: string,
  allCats: string[]
): number {
  const catOrder = loadCatOrder(allCats);
  const svcOrders = loadSvcOrders();

  const catIdx = catOrder.indexOf(serviceCategory);
  const catRank = catIdx >= 0 ? catIdx : catOrder.length;

  const svcList: string[] = svcOrders[serviceCategory] ?? [];
  const svcIdx = svcList.indexOf(serviceName);
  const svcRank = svcIdx >= 0 ? svcIdx : svcList.length;

  return catRank * 10000 + svcRank;
}
