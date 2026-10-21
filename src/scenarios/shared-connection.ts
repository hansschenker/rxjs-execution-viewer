import { Subject, VirtualTimeScheduler, share } from 'rxjs';
import { createRecorder } from '../core/recorder';
import type { ExecutionTrace, PipelineNode, Scenario, TraceEvent } from '../core/types';
import { coldNotifications } from './helpers';

const nodes: PipelineNode[] = [
  { id: 'source', label: 'Cold source', kind: 'source', description: 'A at 0, B at 50, C at 100, Complete due at 150. Sharing creates exactly one upstream execution.' },
  {
    id: 'share', label: 'share(explicitPolicy)', kind: 'operator',
    description: 'A Subject distributes one upstream execution. No replay. Reset and disconnect when the final subscriber leaves.',
    model: {
      state: 'Subscriber count and shared upstream connection.', initial: 'No subscribers; no connection.',
      input: 'Subscriber joins/leaves and source notifications.', output: 'Each value to all currently subscribed observers.',
      transition: 'Input Controller T: update subscriber count; use one upstream connection while subscribed.',
      action: 'Action Policy G: connect for the first subscriber; distribute; disconnect at refCount zero.',
    },
  },
  { id: 'sink-a', label: 'Observer A', kind: 'sink', description: 'Subscribes at 0; receives A and B; cancels at 90 ms.' },
  { id: 'sink-b', label: 'Observer B', kind: 'sink', description: 'Subscribes at 40; receives B and C; cancels at 130 ms. The earlier A is not replayed.' },
];

export function buildSharedConnection(): ExecutionTrace {
  const scheduler = new VirtualTimeScheduler();
  const recorder = createRecorder({
    id: 'shared-connection', title: 'One source, two observers',
    description: 'Explicit sharing and reference-counted cancellation. Leaving one observer does not stop the shared source; leaving the final observer does.',
    pipeline: 'source$.pipe(share({ connector: makeSubject, resetOnError: true, resetOnComplete: true, resetOnRefCountZero: true }))',
    clock: { unit: 'ms', scheduler: 'VirtualTimeScheduler · RxJS 7.8.2', virtual: true },
    nodes,
    edges: [
      { id: 'source-share', from: 'source', to: 'share' },
      { id: 'share-a', from: 'share', to: 'sink-a' },
      { id: 'share-b', from: 'share', to: 'sink-b' },
    ],
    now: scheduler.now.bind(scheduler),
  });
  let subscriberCount = 0;

  function makeSubject(): Subject<string> { return new Subject<string>(); }

  function explainShare(event: TraceEvent): void {
    if (event.kind === 'subscribe') subscriberCount += 1;
    else if (event.kind === 'unsubscribe') subscriberCount -= 1;
    else return;
    recorder.state({
      nodeId: 'share', subscriptionId: event.subscriptionId,
      label: subscriberCount === 0 ? 'Last observer left: release the upstream connection' : `${subscriberCount} observer${subscriberCount === 1 ? '' : 's'} share one connection`,
      state: { subscriberCount, upstream: subscriberCount > 0 ? 'connected' : 'disconnect', replay: false, resetOnRefCountZero: true },
      cause: event.seq,
    });
  }

  const shared = coldNotifications<string>(scheduler, [
    { time: 0, kind: 'next', value: 'A' },
    { time: 50, kind: 'next', value: 'B' },
    { time: 100, kind: 'next', value: 'C' },
    { time: 150, kind: 'complete' },
  ]).pipe(
    recorder.observe<string>({ nodeId: 'source', lane: 'source', label: 'Shared upstream', parentSubscriptionId: null }),
    share({ connector: makeSubject, resetOnError: true, resetOnComplete: true, resetOnRefCountZero: true }),
  );

  const observerA = shared.pipe(
    recorder.observe<string>({ nodeId: 'share', lane: 'internal', label: 'Share → A', onEvent: explainShare }),
    recorder.observe<string>({ nodeId: 'sink-a', lane: 'result', label: 'Observer A' }),
  ).subscribe();

  scheduler.schedule(function joinObserverB() {
    const observerB = shared.pipe(
      recorder.observe<string>({ nodeId: 'share', lane: 'internal', label: 'Share → B', onEvent: explainShare }),
      recorder.observe<string>({ nodeId: 'sink-b', lane: 'result', label: 'Observer B' }),
    ).subscribe();
    scheduler.schedule(function leaveObserverB() { observerB.unsubscribe(); }, 90);
  }, 40);
  scheduler.schedule(function leaveObserverA() { observerA.unsubscribe(); }, 90);
  scheduler.flush();
  return recorder.snapshot();
}

export const sharedConnectionScenario: Scenario = {
  id: 'shared-connection', title: 'One source, two observers', subtitle: 'Explicit sharing and the last unsubscribe', build: buildSharedConnection,
};
