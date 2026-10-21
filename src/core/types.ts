/** Versioned, JSON-only interchange format. Values are previews, never executable code. */
export const TRACE_VERSION = 1 as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Lane = 'source' | 'internal' | 'result';
export type EventKind = 'subscribe' | 'next' | 'complete' | 'error' | 'unsubscribe' | 'state';
export type Provenance = 'observed' | 'modelled';
export type EndReason = 'complete' | 'error' | 'cancelled';

/** Teaching model, not a claim that RxJS exposes its closure variables. */
export interface MealyModel {
  state: string;
  initial: string;
  input: string;
  output: string;
  transition: string;
  action: string;
}

export interface PipelineNode {
  id: string;
  label: string;
  kind: 'source' | 'operator' | 'sink';
  description: string;
  model?: MealyModel;
}

export interface PipelineEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface TraceEvent {
  /** Monotonic, zero-based total order; same-time events remain distinct. */
  seq: number;
  time: number;
  nodeId: string;
  subscriptionId: string;
  parentSubscriptionId?: string;
  kind: EventKind;
  lane: Lane;
  provenance: Provenance;
  label: string;
  value?: JsonValue;
  state?: { [key: string]: JsonValue };
  /** Optional earlier event that directly caused this event. */
  cause?: number;
  /** Unsubscribe is cleanup, not a completion notification. */
  reason?: EndReason;
}

export interface ExecutionTrace {
  version: typeof TRACE_VERSION;
  id: string;
  title: string;
  description: string;
  pipeline: string;
  clock: {
    unit: 'ms' | 'frame';
    scheduler: string;
    virtual: boolean;
  };
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  events: TraceEvent[];
  /** Capture was bounded; the viewer must not claim this is a full execution. */
  truncated: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  build: () => ExecutionTrace;
}

export interface SubscriptionLifetime {
  id: string;
  nodeId: string;
  parentId?: string;
  label: string;
  start: number;
  startSeq: number;
  end?: number;
  endSeq?: number;
  reason?: EndReason;
}

export interface ReplayState {
  cursor: number;
  selected?: TraceEvent;
  visibleEvents: TraceEvent[];
  latestByNode: Record<string, TraceEvent>;
  modelByNode: Record<string, { [key: string]: JsonValue }>;
  lifetimes: SubscriptionLifetime[];
}
