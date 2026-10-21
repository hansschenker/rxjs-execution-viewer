import { VirtualTimeScheduler, debounceTime, map, switchMap, timer } from 'rxjs';
import type { Observable } from 'rxjs';
import { createRecorder } from '../core/recorder';
import type { ExecutionTrace, JsonValue, PipelineNode, Scenario, TraceEvent } from '../core/types';
import { coldNotifications } from './helpers';

const nodes: PipelineNode[] = [
  { id: 'source', label: 'Cold source', kind: 'source', description: 'A at 0, B at 20, C at 80; complete at 140 ms. One subscription.' },
  {
    id: 'debounce', label: 'debounceTime(40)', kind: 'operator',
    description: 'Keep the latest value until 40 ms of silence. The deadline shown is a teaching model, not an inspected timer handle.',
    model: {
      state: 'Pending value and silence deadline.', initial: 'No pending value.',
      input: 'Source Next, Complete, Error; elapsed silence.', output: 'At most the latest pending value, plus terminal notifications.',
      transition: 'Input Controller T: a new value replaces the pending value and moves the deadline.',
      action: 'Action Policy G: emit after silence; flush on Complete; discard on Error or cancellation.',
    },
  },
  {
    id: 'switch', label: 'switchMap(result)', kind: 'operator',
    description: 'Only the latest inner subscription remains active. Each cold inner emits its value after 100 ms.',
    model: {
      state: 'Active inner identity and whether the outer input completed.', initial: 'No inner subscription; outer is active.',
      input: 'Debounced values, inner notifications, outer termination, cancellation.', output: 'Notifications from the currently active inner.',
      transition: 'Input Controller T: on a new outer value, replace the active inner; remember outer completion.',
      action: 'Action Policy G: cancel the old inner, subscribe to the new one, and complete after outer and active inner finish.',
    },
  },
  { id: 'sink', label: 'Observer', kind: 'sink', description: 'Receives only C at 220 ms, then Complete. B is cancelled at 120, not when C first arrives at 80.' },
];

export function buildLatestWins(): ExecutionTrace {
  const scheduler = new VirtualTimeScheduler();
  const recorder = createRecorder({
    id: 'latest-wins', title: 'Only the latest',
    description: 'A quiet-period policy followed by an inner-subscription policy. Observed boundaries run real RxJS 7.8.2; internal explanations are modelled.',
    pipeline: 'source$.pipe(debounceTime(40, scheduler), switchMap(delayedResult))',
    clock: { unit: 'ms', scheduler: 'VirtualTimeScheduler · RxJS 7.8.2', virtual: true },
    nodes,
    edges: [
      { id: 'source-debounce', from: 'source', to: 'debounce' },
      { id: 'debounce-switch', from: 'debounce', to: 'switch' },
      { id: 'switch-sink', from: 'switch', to: 'sink' },
    ],
    now: scheduler.now.bind(scheduler),
  });
  let debounceSubscription = '';
  let switchSubscription = '';
  let activeInner: JsonValue = null;
  let outerComplete = false;

  function explainDebounce(event: TraceEvent): void {
    if (event.kind === 'subscribe') {
      debounceSubscription = event.subscriptionId;
      recorder.state({ nodeId: 'debounce', subscriptionId: debounceSubscription, label: 'Waiting for an input', state: { pending: null, deadline: null }, cause: event.seq });
    } else if (event.kind === 'next') {
      recorder.state({ nodeId: 'debounce', subscriptionId: debounceSubscription, label: 'Silence reached: forward the latest value', state: { pending: null, deadline: null, emitted: event.value ?? null }, cause: event.seq });
    } else if (event.kind === 'complete') {
      outerComplete = true;
      recorder.state({ nodeId: 'debounce', subscriptionId: debounceSubscription, label: 'Debounced input completed', state: { pending: null, deadline: null, status: 'complete' }, cause: event.seq });
      describeSwitch('Outer completed; wait for the active inner', event.seq);
    }
  }

  function explainSource(event: TraceEvent): void {
    if (event.kind === 'next' && debounceSubscription) {
      recorder.state({
        nodeId: 'debounce', subscriptionId: debounceSubscription,
        label: `Keep ${String(event.value)}; silence deadline ${event.time + 40} ms`,
        state: { pending: event.value ?? null, deadline: event.time + 40, policy: 'Latest value after silence' }, cause: event.seq,
      });
    }
  }

  function describeSwitch(label: string, cause: number): void {
    recorder.state({ nodeId: 'switch', subscriptionId: switchSubscription, label, state: { activeInner, outerComplete, policy: 'Only latest' }, cause });
  }

  function explainSwitch(event: TraceEvent): void {
    if (event.kind === 'subscribe') {
      switchSubscription = event.subscriptionId;
      describeSwitch('No inner subscription yet', event.seq);
    } else if (event.kind === 'complete') {
      describeSwitch('Outer and active inner are finished', event.seq);
    }
  }

  function delayedResult(value: string): Observable<string> {
    function resultValue(): string { return value; }
    function explainInner(event: TraceEvent): void {
      if (event.kind === 'subscribe') {
        activeInner = value;
        describeSwitch(`Subscribe to inner ${value}; result due at ${event.time + 100} ms`, event.seq);
      } else if (event.kind === 'complete') {
        activeInner = null;
        describeSwitch(`Inner ${value} completed`, event.seq);
      } else if (event.kind === 'unsubscribe' && event.reason === 'cancelled') {
        activeInner = null;
        describeSwitch(`Cancel inner ${value}; its result will not be delivered`, event.seq);
      }
    }
    return timer(100, scheduler).pipe(
      map(resultValue),
      recorder.observe<string>({ nodeId: 'switch', lane: 'internal', label: `Inner ${value}`, parentSubscriptionId: switchSubscription, onEvent: explainInner }),
    );
  }

  const source = coldNotifications<string>(scheduler, [
    { time: 0, kind: 'next', value: 'A' },
    { time: 20, kind: 'next', value: 'B' },
    { time: 80, kind: 'next', value: 'C' },
    { time: 140, kind: 'complete' },
  ]);
  source.pipe(
    recorder.observe<string>({ nodeId: 'source', lane: 'source', label: 'Source', onEvent: explainSource }),
    debounceTime(40, scheduler),
    recorder.observe<string>({ nodeId: 'debounce', lane: 'internal', label: 'Debounce output', onEvent: explainDebounce }),
    switchMap(delayedResult),
    recorder.observe<string>({ nodeId: 'switch', lane: 'internal', label: 'Switch output', onEvent: explainSwitch }),
    recorder.observe<string>({ nodeId: 'sink', lane: 'result', label: 'Observer' }),
  ).subscribe();
  scheduler.flush();
  return recorder.snapshot();
}

export const latestWinsScenario: Scenario = {
  id: 'latest-wins', title: 'Only the latest', subtitle: 'Silence, inner lifetimes, and cancellation', build: buildLatestWins,
};
