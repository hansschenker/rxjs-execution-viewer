import { Observable, Subscriber } from 'rxjs';
import type { MonoTypeOperatorFunction } from 'rxjs';
import { TRACE_VERSION } from './types';
import type { EndReason, ExecutionTrace, JsonValue, Lane, TraceEvent } from './types';

export interface PreviewOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxStringLength?: number;
}

/** JSON-only previews: bounded, cycle-safe, and never evaluate property getters. */
export function previewValue(value: unknown, options: PreviewOptions = {}): JsonValue {
  const maxDepth = boundedInteger(options.maxDepth, 3, 0, 6);
  const maxEntries = boundedInteger(options.maxEntries, 10, 1, 25);
  const maxStringLength = boundedInteger(options.maxStringLength, 160, 16, 500);
  const seen = new WeakSet<object>();
  let remaining = 100;

  function shorten(text: string): string {
    return text.length > maxStringLength ? `${text.slice(0, maxStringLength)}…` : text;
  }

  function visit(input: unknown, depth: number): JsonValue {
    if (remaining-- <= 0) return '[Preview limit]';
    if (input === null) return null;
    if (typeof input === 'string') return shorten(input);
    if (typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (typeof input === 'undefined') return '[undefined]';
    if (typeof input === 'bigint') return `${input}n`;
    if (typeof input === 'symbol') return shorten(String(input));
    if (typeof input === 'function') return '[Function]';
    if (typeof input !== 'object') return '[Unsupported value]';
    if (seen.has(input)) return '[Circular reference]';
    if (depth >= maxDepth) return Array.isArray(input) ? '[Array]' : '[Object]';
    seen.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Array.isArray(input)) {
        const result: JsonValue[] = [];
        const actualLength = Number(descriptors['length']?.value ?? 0);
        const length = Math.min(actualLength, maxEntries);
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          result.push(descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Getter or empty slot]');
        }
        if (actualLength > maxEntries) result.push(`[${actualLength - maxEntries} more items]`);
        return result;
      }
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
      const keys = Object.keys(descriptors).filter(isVisibleProperty);
      for (const key of keys.slice(0, maxEntries)) {
        const descriptor = descriptors[key];
        result[shorten(key)] = descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Getter]';
      }
      if (keys.length > maxEntries) result['…'] = `[${keys.length - maxEntries} more properties]`;
      return result;
    } catch {
      return '[Uninspectable object]';
    }
  }

  function isVisibleProperty(key: string): boolean {
    return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
  }

  try {
    return visit(value, 0);
  } catch {
    return '[Uninspectable value]';
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export interface RecorderOptions extends Omit<ExecutionTrace, 'version' | 'events' | 'truncated'> {
  now: () => number;
  maxEvents?: number;
  /** Compact UTF-8 event-data budget; metadata is kept separately. */
  maxBytes?: number;
}

export interface ObserveOptions {
  nodeId: string;
  lane: Lane;
  label?: string;
  /** null starts a separate lifetime root, useful for a shared upstream connection. */
  parentSubscriptionId?: string | (() => string | undefined) | null;
  /** Explanatory hooks run after recording; they must not execute domain effects. */
  onEvent?: (event: TraceEvent) => void;
}

export interface StateDescription {
  nodeId: string;
  subscriptionId: string;
  label: string;
  state: Record<string, JsonValue>;
  cause?: number;
}

export type TraceEventDraft = Omit<TraceEvent, 'seq' | 'time'>;

export interface TraceRecorder {
  observe: <T>(options: ObserveOptions) => MonoTypeOperatorFunction<T>;
  /** State descriptions are explicitly modelled, never claimed as internal instrumentation. */
  state: (description: StateDescription) => TraceEvent | undefined;
  record: (event: TraceEventDraft) => TraceEvent | undefined;
  snapshot: () => ExecutionTrace;
}

interface RecordedSubscription {
  nodeId: string;
  parentSubscriptionId?: string;
}

/**
 * Records one real execution. Observation subscribes upstream exactly once and
 * links teardown before source execution, including synchronous take() chains.
 * The capture cap limits logging only: it never stops the inspected pipeline.
 */
export function createRecorder(options: RecorderOptions): TraceRecorder {
  const events: TraceEvent[] = [];
  const subscriptions = new Map<string, RecordedSubscription>();
  const knownNodes = new Set(options.nodes.map(nodeId));
  const maxEvents = boundedInteger(options.maxEvents, 2000, 1, 2000);
  const maxBytes = boundedInteger(options.maxBytes, 4 * 1024 * 1024, 1024, 4 * 1024 * 1024);
  const encoder = new TextEncoder();
  let recordedBytes = 0;
  let nextSubscription = 0;
  let latestTime = 0;
  let truncated = false;
  let activeSubscription: string | undefined;
  let activeCause: number | undefined;

  function readTime(): number {
    try {
      const now = options.now();
      if (Number.isFinite(now)) latestTime = Math.max(latestTime, now, 0);
    } catch {
      // Diagnostics must never change the source's success/error behaviour.
    }
    return latestTime;
  }

  function record(draft: TraceEventDraft): TraceEvent | undefined {
    if (truncated || events.length >= maxEvents) {
      truncated = true;
      return undefined;
    }
    if (!knownNodes.has(draft.nodeId)) return undefined;
    const existing = subscriptions.get(draft.subscriptionId);
    if (draft.kind === 'subscribe') {
      if (existing) return undefined;
      if (draft.parentSubscriptionId && !subscriptions.has(draft.parentSubscriptionId)) return undefined;
      subscriptions.set(draft.subscriptionId, {
        nodeId: draft.nodeId,
        ...(draft.parentSubscriptionId ? { parentSubscriptionId: draft.parentSubscriptionId } : {}),
      });
    } else if (!existing || existing.nodeId !== draft.nodeId) {
      return undefined;
    }
    const parentSubscriptionId = subscriptions.get(draft.subscriptionId)?.parentSubscriptionId;
    const cause = draft.cause ?? activeCause;
    const { cause: _draftCause, parentSubscriptionId: _draftParent, ...details } = draft;
    const event: TraceEvent = {
      ...details,
      seq: events.length,
      time: readTime(),
      ...(parentSubscriptionId ? { parentSubscriptionId } : {}),
      ...(cause !== undefined && cause >= 0 && cause < events.length ? { cause } : {}),
    };
    // Avoid retaining the mutable payload object supplied by the application.
    if ('value' in draft) event.value = previewValue(draft.value);
    if (draft.state) {
      const preview = previewValue(draft.state);
      event.state = preview !== null && typeof preview === 'object' && !Array.isArray(preview) ? preview : { preview };
    }
    const eventBytes = encoder.encode(JSON.stringify(event)).length;
    if (recordedBytes + eventBytes > maxBytes) {
      truncated = true;
      return undefined;
    }
    recordedBytes += eventBytes;
    events.push(event);
    return event;
  }

  function state(description: StateDescription): TraceEvent | undefined {
    const subscription = subscriptions.get(description.subscriptionId);
    if (!subscription || subscription.nodeId !== description.nodeId) return undefined;
    return record({ ...description, kind: 'state', lane: 'internal', provenance: 'modelled' });
  }

  function within<T>(subscriptionId: string, event: TraceEvent | undefined, action: () => T): T {
    const previousSubscription = activeSubscription;
    const previousCause = activeCause;
    activeSubscription = subscriptionId;
    activeCause = event?.seq ?? previousCause;
    try {
      return action();
    } finally {
      activeSubscription = previousSubscription;
      activeCause = previousCause;
    }
  }

  function observe<T>(settings: ObserveOptions): MonoTypeOperatorFunction<T> {
    return function observeSource(source: Observable<T>): Observable<T> {
      return new Observable<T>(function subscribeObserved(destination) {
        const subscriptionId = `${options.id}:s${nextSubscription++}`;
        const label = settings.label ?? settings.nodeId;
        function resolveParent(): string | undefined {
          try {
            return typeof settings.parentSubscriptionId === 'function'
              ? settings.parentSubscriptionId()
              : settings.parentSubscriptionId === null ? undefined : settings.parentSubscriptionId ?? activeSubscription;
          } catch {
            return undefined;
          }
        }
        const parentCandidate = resolveParent();
        const parentSubscriptionId = parentCandidate && subscriptions.has(parentCandidate) ? parentCandidate : undefined;
        let reason: EndReason = 'cancelled';

        function append(kind: TraceEvent['kind'], value?: unknown): TraceEvent | undefined {
          return record({
            nodeId: settings.nodeId,
            subscriptionId,
            ...(parentSubscriptionId ? { parentSubscriptionId } : {}),
            kind,
            lane: settings.lane,
            provenance: 'observed',
            label,
            ...(kind === 'next' || kind === 'error' ? { value: previewValue(value) } : {}),
            ...(kind === 'unsubscribe' ? { reason } : {}),
          });
        }

        function explain(event: TraceEvent | undefined): void {
          if (event && settings.onEvent) {
            try { settings.onEvent(event); } catch { /* Explanations must not change execution. */ }
          }
        }

        function observeNext(value: T): void {
          const event = append('next', value);
          within(subscriptionId, event, function forwardNext() {
            explain(event);
            destination.next(value);
          });
        }

        function observeError(error: unknown): void {
          reason = 'error';
          const event = append('error', error);
          within(subscriptionId, event, function forwardError() {
            explain(event);
            destination.error(error);
          });
        }

        function observeComplete(): void {
          reason = 'complete';
          const event = append('complete');
          within(subscriptionId, event, function forwardComplete() {
            explain(event);
            destination.complete();
          });
        }

        function observeTeardown(): void {
          const event = append('unsubscribe');
          within(subscriptionId, event, function finishExplanation() { explain(event); });
        }

        const event = append('subscribe');
        const upstream = new Subscriber<T>({ next: observeNext, error: observeError, complete: observeComplete });
        upstream.add(observeTeardown);
        destination.add(upstream);
        within(subscriptionId, event, function startSource() {
          explain(event);
          source.subscribe(upstream);
        });
      });
    };
  }

  function snapshot(): ExecutionTrace {
    const trace: ExecutionTrace = {
      version: TRACE_VERSION,
      id: options.id,
      title: options.title,
      description: options.description,
      pipeline: options.pipeline,
      clock: { ...options.clock },
      nodes: options.nodes,
      edges: options.edges,
      events,
      truncated,
    };
    return JSON.parse(JSON.stringify(trace)) as ExecutionTrace;
  }

  return { observe, state, record, snapshot };
}

function nodeId(node: { id: string }): string { return node.id; }
