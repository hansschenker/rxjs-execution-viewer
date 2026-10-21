import { filter, map, of, take } from 'rxjs';
import { createRecorder } from '../core/recorder';
import type { ExecutionTrace, PipelineNode, Scenario, TraceEvent } from '../core/types';

function isOdd(value: number): boolean { return value % 2 === 1; }
function timesTen(value: number): number { return value * 10; }
function zeroTime(): number { return 0; }

const nodes: PipelineNode[] = [
  { id: 'source', label: 'of(1, 2, 3, 4, 5)', kind: 'source', description: 'A synchronous cold source. Early teardown stops production after 3.' },
  {
    id: 'filter', label: 'filter(isOdd)', kind: 'operator', description: 'The named domain predicate accepts odd numbers.',
    model: { state: 'No retained domain state.', initial: 'Ready.', input: 'Source notifications.', output: 'Accepted input values.', transition: 'Input Controller T: evaluate isOdd for each input.', action: 'Action Policy G: forward odd values; drop even values.' },
  },
  {
    id: 'map', label: 'map(timesTen)', kind: 'operator', description: 'A synchronous value transformation, with no queue or separate worker.',
    model: { state: 'No domain accumulator.', initial: 'Ready.', input: 'Accepted numbers.', output: 'Each number multiplied by ten.', transition: 'Input Controller T: handle each input independently.', action: 'Action Policy G: apply timesTen and forward the result synchronously.' },
  },
  {
    id: 'take', label: 'take(2)', kind: 'operator', description: 'Complete after two accepted values and tear down upstream.',
    model: { state: 'Accepted count and lifecycle status.', initial: 'Count 0; active.', input: 'Mapped numbers and terminal notifications.', output: 'The first two numbers, then Complete.', transition: 'Input Controller T: increment the accepted count.', action: 'Action Policy G: forward while under the limit; complete at the limit and release upstream.' },
  },
  { id: 'sink', label: 'Observer', kind: 'sink', description: 'Receives 10, 30, Complete, all at time 0. Sequence numbers preserve their ordering.' },
];

export function buildSyncTake(): ExecutionTrace {
  const recorder = createRecorder({
    id: 'sync-take', title: 'One moment, many reactions',
    description: 'Synchronous forwarding and early teardown. Every event has time 0, while its sequence number preserves the real order.',
    pipeline: 'of(1, 2, 3, 4, 5).pipe(filter(isOdd), map(timesTen), take(2))',
    clock: { unit: 'ms', scheduler: 'Synchronous execution · RxJS 7.8.2', virtual: true },
    nodes,
    edges: [
      { id: 'source-filter', from: 'source', to: 'filter' },
      { id: 'filter-map', from: 'filter', to: 'map' },
      { id: 'map-take', from: 'map', to: 'take' },
      { id: 'take-sink', from: 'take', to: 'sink' },
    ],
    now: zeroTime,
  });
  let filterSubscription = '';
  let takeSubscription = '';
  let accepted = 0;

  function explainFilter(event: TraceEvent): void {
    if (event.kind === 'subscribe') filterSubscription = event.subscriptionId;
  }

  function explainSource(event: TraceEvent): void {
    if (event.kind !== 'next' || typeof event.value !== 'number') return;
    const passes = isOdd(event.value);
    recorder.state({
      nodeId: 'filter', subscriptionId: filterSubscription,
      label: `${passes ? 'Accept' : 'Drop'} ${event.value}: ${passes ? 'odd' : 'even'}`,
      state: { input: event.value, accepted: passes, predicate: 'isOdd' }, cause: event.seq,
    });
  }

  function explainTake(event: TraceEvent): void {
    if (event.kind === 'subscribe') {
      takeSubscription = event.subscriptionId;
      recorder.state({ nodeId: 'take', subscriptionId: takeSubscription, label: 'Ready to accept two values', state: { accepted: 0, limit: 2, status: 'active' }, cause: event.seq });
    } else if (event.kind === 'complete') {
      recorder.state({ nodeId: 'take', subscriptionId: takeSubscription, label: 'Limit reached: complete and tear down upstream', state: { accepted, limit: 2, status: 'complete' }, cause: event.seq });
    }
  }

  function explainMap(event: TraceEvent): void {
    if (event.kind !== 'next') return;
    accepted += 1;
    recorder.state({ nodeId: 'take', subscriptionId: takeSubscription, label: `Accept value ${accepted} of 2`, state: { accepted, limit: 2, status: 'active' }, cause: event.seq });
  }

  of(1, 2, 3, 4, 5).pipe(
    recorder.observe<number>({ nodeId: 'source', lane: 'source', label: 'Source', onEvent: explainSource }),
    filter(isOdd),
    recorder.observe<number>({ nodeId: 'filter', lane: 'internal', label: 'Filter output', onEvent: explainFilter }),
    map(timesTen),
    recorder.observe<number>({ nodeId: 'map', lane: 'internal', label: 'Map output', onEvent: explainMap }),
    take(2),
    recorder.observe<number>({ nodeId: 'take', lane: 'internal', label: 'Take output', onEvent: explainTake }),
    recorder.observe<number>({ nodeId: 'sink', lane: 'result', label: 'Observer' }),
  ).subscribe();
  return recorder.snapshot();
}

export const syncTakeScenario: Scenario = {
  id: 'sync-take', title: 'One moment, many reactions', subtitle: 'Same-time order and early teardown', build: buildSyncTake,
};
