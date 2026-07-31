import { hwaseongAdapter } from "./hwaseong/adapter.js";
import { osanAdapter } from "./osan/adapter.js";
import { siheungAdapter } from "./siheung/adapter.js";
import type { MunicipalityAdapter } from "./types.js";

/** adapter_key(municipalities.adapter_key) → 어댑터 구현 */
export const adapterRegistry: Record<string, MunicipalityAdapter> = {
  hwaseong: hwaseongAdapter,
  osan: osanAdapter,
  siheung: siheungAdapter,
};

export function getAdapter(key: string): MunicipalityAdapter {
  const adapter = adapterRegistry[key];
  if (!adapter) throw new Error(`no adapter registered for key: ${key}`);
  return adapter;
}

/** 등록된 어댑터가 있는지 (스케줄러가 크롤 대상 지자체를 거르는 용도) */
export function hasAdapter(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(adapterRegistry, key);
}
