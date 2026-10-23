import type { Manicurist, SalonService, ServiceType } from '../types';

// Matched by name, which is why Wax Services is locked in service_categories.
export const WAX = 'Wax Services';

export function isWaxService(service: string, salonServices: SalonService[]): boolean {
  return salonServices.find((s) => s.name === service)?.category === WAX;
}

export function clientHasAnyWaxService(services: ServiceType[], salonServices: SalonService[]): boolean {
  const waxNames = new Set(salonServices.filter((s) => s.category === WAX).map((s) => s.name));
  return services.some((s) => waxNames.has(s));
}

export function waxRotationCompare(a: Manicurist, b: Manicurist): number {
  const aW = a.hasWax ? 1 : 0;
  const bW = b.hasWax ? 1 : 0;
  if (aW !== bW) return aW - bW;
  return (a.clockInTime ?? Infinity) - (b.clockInTime ?? Infinity);
}
