import { Observable, of, take, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { createRecorder, previewValue } from '../src/core/recorder';
import type { TraceRecorder } from '../src/core/recorder';
import { replayTrace } from '../src/core/replay';
import type { ExecutionTrace, TraceEvent } from '../src/core/types';
import { buildLatestWins } from '../src/scenarios/latest-wins';
import { buildSharedConnection } from '../src/scenarios/shared-connection';
import { buildSyncTake } from '../src/scenarios/sync-take';

function sinkNotifications(trace: ExecutionTrace, nodeId = 'sink'): TraceEvent[] {
  return trace.events.filter(function isSinkNotification(event) {
    return event.nodeId === nodeId && ['next', 'complete', 'error'].includes(event.kind);
  });
}

function valuesWithTimes(events: TraceEvent[]): unknown[][] {
  return events.map(function notificationTuple(event) { return [event.time, event.kind, event.value]; });
}

function simpleRecorder(maxEvents = 2000, maxBytes = 4 * 1024 * 1024): TraceRecorder {
  return createRecorder({
    id: 'test', title: 'Test', description: 'A real observed execution', pipeline: 'source$',
    clock: { unit: 'frame', scheduler: 'fixed test clock', virtual: true },
    nodes: [{ id: 'source', label: 'Source', kind: 'source', description: 'Test source' }], edges: [],
    now: function now() { return 0; }, maxEvents, maxBytes,
  });
}

describe('real RxJS 7.8.2 scenario executions', function executionSuite() {
  it('debounces inputs, cancels B at 120, and waits for C after source completion', function latestPolicy() {
    const trace = buildLatestWins();
    expect(valuesWithTimes(sinkNotifications(trace))).toEqual([[220, 'next', 'C'], [220, 'complete', undefined]]);
    const innerB = trace.events.filter(function isInnerB(event) { return event.label === 'Inner B'; });
    expect(innerB.map(function lifetimePoint(event) { return [event.time, event.kind, event.reason]; })).toEqual([
      [60, 'subscribe', undefined], [120, 'unsubscribe', 'cancelled'],
    ]);
    const innerC = trace.events.filter(function isInnerC(event) { return event.label === 'Inner C'; });
    expect(innerC.map(function lifetimePoint(event) { return [event.time, event.kind, event.reason]; })).toEqual([
      [120, 'subscribe', undefined], [220, 'next', undefined], [220, 'complete', undefined], [220, 'unsubscribe', 'complete'],
    ]);
    expect(trace.events.find(function sourceCompletion(event) { return event.nodeId === 'source' && event.kind === 'complete'; })?.time).toBe(140);
    expect(trace.events.some(function cancelledAtArrival(event) { return event.label === 'Inner B' && event.kind === 'unsubscribe' && event.time === 80; })).toBe(false);
  });

  it('preserves synchronous order and stops the source immediately after take reaches its limit', function synchronousTake() {
    const trace = buildSyncTake();
    expect(valuesWithTimes(sinkNotifications(trace))).toEqual([[0, 'next', 10], [0, 'next', 30], [0, 'complete', undefined]]);
    expect(trace.events.filter(function sourceValue(event) { return event.nodeId === 'source' && event.kind === 'next'; }).map(function value(event) { return event.value; })).toEqual([1, 2, 3]);
    expect(trace.events.filter(function sourceComplete(event) { return event.nodeId === 'source' && event.kind === 'complete'; })).toEqual([]);
    expect(trace.events.find(function sourceCancelled(event) { return event.nodeId === 'source' && event.kind === 'unsubscribe'; })?.reason).toBe('cancelled');
    expect(new Set(trace.events.map(function eventTime(event) { return event.time; }))).toEqual(new Set([0]));
    expect(trace.events.map(function eventSequence(event) { return event.seq; })).toEqual(trace.events.map(function eventIndex(_event, index) { return index; }));
  });

  it('shares one source, does not replay, and disconnects only after the final observer leaves', function sharingPolicy() {
    const trace = buildSharedConnection();
    expect(trace.events.filter(function sourceSubscribe(event) { return event.nodeId === 'source' && event.kind === 'subscribe'; })).toHaveLength(1);
    expect(valuesWithTimes(sinkNotifications(trace, 'sink-a'))).toEqual([[0, 'next', 'A'], [50, 'next', 'B']]);
    expect(valuesWithTimes(sinkNotifications(trace, 'sink-b'))).toEqual([[50, 'next', 'B'], [100, 'next', 'C']]);
    const sourceEnd = trace.events.find(function sourceUnsubscribe(event) { return event.nodeId === 'source' && event.kind === 'unsubscribe'; });
    expect([sourceEnd?.time, sourceEnd?.reason]).toEqual([130, 'cancelled']);
    expect(trace.events.some(function anyComplete(event) { return event.kind === 'complete'; })).toBe(false);
  });

  it('ties modelled descriptions to real subscription IDs and keeps causes earlier than effects', function traceIntegrity() {
    for (const trace of [buildLatestWins(), buildSyncTake(), buildSharedConnection()]) {
      const subscriptions = new Map<string, TraceEvent>();
      let previousTime = 0;
      for (const event of trace.events) {
        expect(event.time).toBeGreaterThanOrEqual(previousTime);
        previousTime = event.time;
        if (event.kind === 'subscribe') {
          expect(subscriptions.has(event.subscriptionId)).toBe(false);
          if (event.parentSubscriptionId) expect(subscriptions.has(event.parentSubscriptionId)).toBe(true);
          subscriptions.set(event.subscriptionId, event);
        } else {
          expect(subscriptions.get(event.subscriptionId)?.nodeId).toBe(event.nodeId);
          expect(subscriptions.get(event.subscriptionId)?.parentSubscriptionId).toBe(event.parentSubscriptionId);
        }
        expect(event.provenance).toBe(event.kind === 'state' ? 'modelled' : 'observed');
        if (event.cause !== undefined) expect(event.cause).toBeLessThan(event.seq);
      }
    }
  });
});

describe('recorder and replay invariants', function recorderSuite() {
  it('records Error separately from teardown and does not invent Complete', function errorLifecycle() {
    const recorder = simpleRecorder();
    let caught: unknown;
    throwError(function expectedFailure() { return new Error('Expected failure'); }).pipe(recorder.observe({ nodeId: 'source', lane: 'source' })).subscribe({ error: function captureError(error: unknown) { caught = error; } });
    expect(caught).toBeInstanceOf(Error);
    expect(recorder.snapshot().events.map(function kind(event) { return [event.kind, event.reason]; })).toEqual([
      ['subscribe', undefined], ['error', undefined], ['unsubscribe', 'error'],
    ]);
  });

  it('keeps capture bounded without interrupting or duplicating source execution', function boundedCapture() {
    const recorder = simpleRecorder(3);
    let executions = 0;
    const received: number[] = [];
    const source = new Observable<number>(function countedSource(subscriber) {
      executions += 1;
      for (let value = 0; value < 10; value += 1) subscriber.next(value);
      subscriber.complete();
    });
    source.pipe(recorder.observe({ nodeId: 'source', lane: 'source' })).subscribe(function receive(value) { received.push(value); });
    expect(executions).toBe(1);
    expect(received).toHaveLength(10);
    expect(recorder.snapshot().events).toHaveLength(3);
    expect(recorder.snapshot().truncated).toBe(true);
  });

  it('links cancellation before synchronous execution starts', function earlyCancellation() {
    const recorder = simpleRecorder();
    let produced = 0;
    const source = new Observable<number>(function guardedSource(subscriber) {
      for (let value = 0; value < 10 && !subscriber.closed; value += 1) {
        produced += 1;
        subscriber.next(value);
      }
      subscriber.complete();
    });
    source.pipe(recorder.observe({ nodeId: 'source', lane: 'source' }), take(2)).subscribe();
    expect(produced).toBe(2);
    expect(recorder.snapshot().events.at(-1)?.reason).toBe('cancelled');
  });

  it('also bounds captured bytes without changing delivered payloads', function boundedBytes() {
    const recorder = simpleRecorder(2000, 1024);
    const values = Array.from({ length: 10 }, function longValue() { return 'x'.repeat(160); });
    let received: unknown;
    of(values).pipe(recorder.observe({ nodeId: 'source', lane: 'source' })).subscribe(function receive(value) { received = value; });
    const trace = recorder.snapshot();
    expect(received).toBe(values);
    expect(trace.truncated).toBe(true);
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]?.kind).toBe('subscribe');
  });

  it('replays recorded data without new execution or mutation', function pureReplay() {
    const recorder = simpleRecorder();
    let executions = 0;
    const source = new Observable<number>(function sourceExecution(subscriber) { executions += 1; subscriber.next(7); subscriber.complete(); });
    source.pipe(recorder.observe({ nodeId: 'source', lane: 'source' })).subscribe();
    const trace = recorder.snapshot();
    const original = JSON.stringify(trace);
    for (const cursor of [3, 0, 1, -1, 2, 100, 0]) replayTrace(trace, cursor);
    expect(executions).toBe(1);
    expect(JSON.stringify(trace)).toBe(original);
    expect(replayTrace(trace, -1).visibleEvents).toEqual([]);
    expect(replayTrace(trace, 100).lifetimes[0]?.reason).toBe('complete');
    expect(replayTrace(trace, 100).cursor).toBe(trace.events.length - 1);
  });

  it('previews cycles, large data, unsupported values and getters without invoking getters', function safePreviews() {
    let getterCalls = 0;
    const object: Record<string, unknown> = { label: 'x'.repeat(1000), value: BigInt(12) };
    object['self'] = object;
    Object.defineProperty(object, 'secret', { get: function secretGetter() { getterCalls += 1; throw new Error('Must not run'); }, enumerable: true });
    const preview = previewValue(object);
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(preview)).toContain('[Circular reference]');
    expect(JSON.stringify(preview)).toContain('[Getter]');
    expect(JSON.stringify(preview).length).toBeLessThan(500);
    expect(previewValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(previewValue(undefined)).toBe('[undefined]');
  });

  it('creates independent execution identities for repeated subscriptions', function independentSubscriptions() {
    const recorder = simpleRecorder();
    const traced = of('value').pipe(recorder.observe({ nodeId: 'source', lane: 'source' }));
    traced.subscribe();
    traced.subscribe();
    const starts = recorder.snapshot().events.filter(function subscribeEvent(event) { return event.kind === 'subscribe'; });
    expect(starts).toHaveLength(2);
    expect(starts[0]?.subscriptionId).not.toBe(starts[1]?.subscriptionId);
  });
});
