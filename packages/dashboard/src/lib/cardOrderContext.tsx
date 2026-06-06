// #244 v2: shared dashboard card-order state.
//
// v1 also tracked a "rearranging" toggle - the dashboard had a
// separate edit mode. v2's drag-to-reorder is always on (small grip
// handles on each card fade in on hover), so the mode flag is gone.
// `isCustomized` + `reset()` are kept so the operator can revert to
// the default order; the affordance lives in the header / hamburger.

import { createContext, useContext, type ReactNode } from 'react';
import { useCardOrder, type CardOrderControls } from './cardOrder';

// Built-in top-level dashboard block order. Each ID is a draggable
// unit; a saved order is reconciled against this list, so adding a
// block here is enough to slot it in for everyone and a saved order
// referencing a removed ID degrades cleanly. `proposals` keeps its
// position even when hidden (no last-tick data this cycle).
export const DEFAULT_BLOCK_ORDER = [
  'hero',
  'period',
  'indicators',
  'hashrate',
  'price',
  'pipeline',
  'bids',
  'finance',
  'proposals',
  'bip110',
  'solo',
] as const;

type CardOrderContextValue = CardOrderControls;

const CardOrderContext = createContext<CardOrderContextValue | null>(null);

export function CardOrderProvider({ children }: { children: ReactNode }) {
  const controls = useCardOrder(DEFAULT_BLOCK_ORDER);
  return (
    <CardOrderContext.Provider value={controls}>{children}</CardOrderContext.Provider>
  );
}

export function useCardOrderContext(): CardOrderContextValue {
  const value = useContext(CardOrderContext);
  if (!value) {
    throw new Error('useCardOrderContext must be used within a CardOrderProvider');
  }
  return value;
}
