import type { CSSProperties } from 'react';
import type { SetDefinition } from '../../engine';

/** #1138 draft looks: the set's two colours as --set-a and --set-b, the same fallbacks as the pack's set ribbon. */
export const setColours = (set: Pick<SetDefinition, 'palette'> | undefined): CSSProperties =>
  ({ '--set-a': set?.palette?.[0] ?? '#ff3df2', '--set-b': set?.palette?.[1] ?? '#29f0ff' }) as CSSProperties;
