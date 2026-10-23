import { useMemo } from 'react';
import { useApp } from '../state/AppContext';
import type { ServiceCategory } from '../types';

export function sortServiceCategories(categories: ServiceCategory[]): ServiceCategory[] {
  return [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Service categories in display order — the single source for every
 *  category list in the UI (replaces the old SERVICE_CATEGORIES constant). */
export function useServiceCategories() {
  const { state } = useApp();
  const categories = useMemo(() => sortServiceCategories(state.serviceCategories), [state.serviceCategories]);
  const categoryNames = useMemo(() => categories.map((c) => c.name), [categories]);
  return { categories, categoryNames };
}
