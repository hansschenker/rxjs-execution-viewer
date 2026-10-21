import type { Scenario } from '../core/types';
import { latestWinsScenario } from './latest-wins';
import { sharedConnectionScenario } from './shared-connection';
import { syncTakeScenario } from './sync-take';

export const scenarios: Scenario[] = [latestWinsScenario, syncTakeScenario, sharedConnectionScenario];
