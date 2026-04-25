import type { Manicurist, SalonService, ServiceType } from '../types';

export const WAX = 'Wax Services';
export const ACRYLIC_FULL = 'Acrylic Full Set';
export const ACRYLIC_FILL = 'Acrylic Fill';

export const LEGACY_ACRYLIC_SERVICE_TYPES = new Set<string>(['Acrylics/Full', 'Fills']);

export function isWaxService(service: string, salonServices: SalonService[]): boolean {
  return salonServices.find((s) => s.name === service)?.category === WAX;
}

export function isAcrylicService(serviceName: string, salonServices: SalonService[]): boolean {
  if (LEGACY_ACRYLIC_SERVICE_TYPES.has(serviceName)) return true;
  const svc = salonServices.find(s => s.name === serviceName);
  return !!svc && (svc.category === ACRYLIC_FULL || svc.category === ACRYLIC_FILL);
}

export function clientHasAnyWaxService(services: ServiceType[], salonServices: SalonService[]): boolean {
  const waxNames = new Set(salonServices.filter((s) => s.category === WAX).map((s) => s.name));
  return services.some((s) => waxNames.has(s));
}

export function isSam(m: Manicurist): boolean {
  return m.name.toLowerCase() === 'sam';
}

export function findSamIfActive(manicurists: Manicurist[]): Manicurist | null {
  return manicurists.find(m => isSam(m) && m.clockedIn) ?? null;
}

export function getSamPreferenceForServices(
  manicurists: Manicurist[],
  services: ServiceType[],
  salonServices: SalonService[]
): Manicurist | null {
  const sam = findSamIfActive(manicurists);
  if (!sam) return null;
  const hasAcrylic = services.some(s => isAcrylicService(s, salonServices));
  const samHasAcrylicSkill = services.some(s => isAcrylicService(s, salonServices) && sam.skills.includes(s));
  return hasAcrylic && samHasAcrylicSkill ? sam : null;
}

export function waxRotationCompare(a: Manicurist, b: Manicurist): number {
  const aW = a.hasWax ? 1 : 0;
  const bW = b.hasWax ? 1 : 0;
  if (aW !== bW) return aW - bW;
  return (a.clockInTime ?? Infinity) - (b.clockInTime ?? Infinity);
}
