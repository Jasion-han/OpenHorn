import { createContext } from "react";

export interface SliderDomain {
  binding: string;
  min: number;
  max: number;
  step: number;
}

// Layout effects register the complete committed tree before any normalization
// or persistence. Labels identify views; the reactive binding owns its domain.
export const SliderDomainContext = createContext<Map<symbol, SliderDomain> | null>(null);

export function hasSliderDomainConflict(domains: Map<symbol, SliderDomain> | null): boolean {
  if (!domains) return false;
  const bindings = new Map<string, SliderDomain>();
  for (const domain of domains.values()) {
    const previous = bindings.get(domain.binding);
    if (
      previous &&
      (previous.min !== domain.min || previous.max !== domain.max || previous.step !== domain.step)
    ) {
      return true;
    }
    bindings.set(domain.binding, domain);
  }
  return false;
}
