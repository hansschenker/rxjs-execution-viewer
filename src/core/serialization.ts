import { TRACE_VERSION } from './types';
import type { ExecutionTrace } from './types';

/** A trace is bounded data, never imported HTML, SVG, functions, or executable code. */
export const TRACE_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  events: 2_000,
  nodes: 100,
  edges: 500,
  depth: 32,
  jsonValues: 100_000,
  stringLength: 20_000,
  keyLength: 256,
});

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const eventKinds = new Set(['subscribe', 'next', 'complete', 'error', 'unsubscribe', 'state']);
const lanes = new Set(['source', 'internal', 'result']);
const provenances = new Set(['observed', 'modelled']);
const nodeKinds = new Set(['source', 'operator', 'sink']);
const reasons = new Set(['complete', 'error', 'cancelled']);
const own = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

function invalid(path: string, message: string): never {
  throw new Error(`Invalid trace at ${path}: ${message}`);
}

function checkBytes(text: string, operation: string): void {
  // Avoid allocating an additional huge buffer for obviously oversized input.
  if (text.length > TRACE_LIMITS.bytes || new TextEncoder().encode(text).byteLength > TRACE_LIMITS.bytes) {
    throw new Error(`${operation} exceeds the 5 MiB trace limit. Capture or export a smaller execution.`);
  }
}

function record(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'expected an object');
  }
}

function shape(value: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'unknown field');
  }
  for (const key of required) {
    if (!own(value, key)) invalid(`${path}.${key}`, 'required field is missing');
  }
}

function text(value: unknown, path: string, maximum: number = TRACE_LIMITS.stringLength): asserts value is string {
  if (typeof value !== 'string') invalid(path, 'expected a string');
  if (value.length > maximum) invalid(path, `string must have at most ${maximum} characters`);
}

function identifier(value: unknown, path: string): asserts value is string {
  text(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    invalid(path, 'expected a nonempty identifier using letters, digits, dot, underscore, colon, slash, or hyphen');
  }
}

function member(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  if (typeof value !== 'string' || !allowed.has(value)) {
    invalid(path, `expected one of ${[...allowed].join(', ')}`);
  }
}

function array(value: unknown, path: string, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value)) invalid(path, 'expected an array');
  if (value.length > maximum) invalid(path, `at most ${maximum} entries are supported`);
}

/** Check JSON-ness before accessing fields: reject accessors, prototypes, cycles, and dangerous keys. */
function checkJson(input: unknown): void {
  let count = 0;
  const ancestors = new WeakSet<object>();

  function visit(value: unknown, path: string, depth: number): void {
    count += 1;
    if (count > TRACE_LIMITS.jsonValues) invalid(path, 'too many nested JSON values');
    if (depth > TRACE_LIMITS.depth) invalid(path, `nesting exceeds ${TRACE_LIMITS.depth} levels`);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      text(value, path);
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid(path, 'numbers must be finite');
      return;
    }
    if (typeof value !== 'object') invalid(path, 'only JSON values are allowed');
    if (ancestors.has(value)) invalid(path, 'cyclic objects are not JSON');
    const isArray = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      invalid(path, 'only plain JSON objects and arrays are allowed');
    }
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (isArray && keys.length !== value.length + 1) {
      invalid(path, 'arrays must be dense and cannot have extra properties');
    }
    for (const key of keys) {
      if (typeof key !== 'string') invalid(path, 'symbol keys are not JSON');
      if (isArray && key === 'length') continue;
      if (key.length > TRACE_LIMITS.keyLength) invalid(path, 'object key is too long');
      if (unsafeKeys.has(key)) invalid(`${path}.${key}`, 'unsafe object key');
      if (isArray && !/^(0|[1-9][0-9]*)$/.test(key)) invalid(path, 'arrays cannot have named properties');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) {
        invalid(`${path}.${key}`, 'only enumerable data properties are allowed');
      }
      visit(descriptor.value, `${path}.${key}`, depth + 1);
    }
    if (isArray) {
      for (let index = 0; index < value.length; index += 1) {
        if (!own(value, index)) invalid(`${path}[${index}]`, 'sparse arrays are not JSON');
      }
    }
    ancestors.delete(value);
  }

  visit(input, '$', 0);
}

/** Validate the complete version-1 schema and causal/subscription references. */
export function validateTrace(input: unknown): ExecutionTrace {
  checkJson(input);
  record(input, '$');
  shape(input, '$', ['version', 'id', 'title', 'description', 'pipeline', 'clock', 'nodes', 'edges', 'events', 'truncated']);
  if (input.version !== TRACE_VERSION) invalid('$.version', `expected version ${TRACE_VERSION}`);
  identifier(input.id, '$.id');
  text(input.title, '$.title', 500);
  text(input.description, '$.description');
  text(input.pipeline, '$.pipeline');
  if (typeof input.truncated !== 'boolean') invalid('$.truncated', 'expected a boolean');

  record(input.clock, '$.clock');
  shape(input.clock, '$.clock', ['unit', 'scheduler', 'virtual']);
  member(input.clock.unit, new Set(['ms', 'frame']), '$.clock.unit');
  text(input.clock.scheduler, '$.clock.scheduler', 500);
  if (typeof input.clock.virtual !== 'boolean') invalid('$.clock.virtual', 'expected a boolean');

  array(input.nodes, '$.nodes', TRACE_LIMITS.nodes);
  if (input.nodes.length === 0) invalid('$.nodes', 'at least one pipeline node is required');
  const nodeIds = new Set<string>();
  for (const [index, node] of input.nodes.entries()) {
    const path = `$.nodes[${index}]`;
    record(node, path);
    shape(node, path, ['id', 'label', 'kind', 'description'], ['model']);
    identifier(node.id, `${path}.id`);
    if (nodeIds.has(node.id)) invalid(`${path}.id`, 'duplicate node identifier');
    nodeIds.add(node.id);
    text(node.label, `${path}.label`, 2_000);
    member(node.kind, nodeKinds, `${path}.kind`);
    text(node.description, `${path}.description`);
    if (own(node, 'model')) {
      record(node.model, `${path}.model`);
      const modelFields = ['state', 'initial', 'input', 'output', 'transition', 'action'];
      shape(node.model, `${path}.model`, modelFields);
      for (const field of modelFields) text(node.model[field], `${path}.model.${field}`, 4_000);
    }
  }

  array(input.edges, '$.edges', TRACE_LIMITS.edges);
  const edgeIds = new Set<string>();
  for (const [index, edge] of input.edges.entries()) {
    const path = `$.edges[${index}]`;
    record(edge, path);
    shape(edge, path, ['id', 'from', 'to'], ['label']);
    identifier(edge.id, `${path}.id`);
    if (edgeIds.has(edge.id)) invalid(`${path}.id`, 'duplicate edge identifier');
    edgeIds.add(edge.id);
    for (const endpoint of ['from', 'to']) {
      identifier(edge[endpoint], `${path}.${endpoint}`);
      if (!nodeIds.has(edge[endpoint])) invalid(`${path}.${endpoint}`, 'references an unknown node');
    }
    if (own(edge, 'label')) text(edge.label, `${path}.label`, 2_000);
  }

  array(input.events, '$.events', TRACE_LIMITS.events);
  const subscriptions = new Map<string, { nodeId: string; parentId: string | undefined }>();
  let previousTime = 0;
  for (const [index, event] of input.events.entries()) {
    const path = `$.events[${index}]`;
    record(event, path);
    shape(event, path,
      ['seq', 'time', 'nodeId', 'subscriptionId', 'kind', 'lane', 'provenance', 'label'],
      ['parentSubscriptionId', 'value', 'state', 'cause', 'reason']);
    if (event.seq !== index) invalid(`${path}.seq`, `expected ${index}; event sequence numbers must be consecutive and zero-based`);
    if (typeof event.time !== 'number' || !Number.isFinite(event.time) || event.time < previousTime || event.time < 0) {
      invalid(`${path}.time`, 'expected a finite, nonnegative, nondecreasing time');
    }
    previousTime = event.time;
    identifier(event.nodeId, `${path}.nodeId`);
    if (!nodeIds.has(event.nodeId)) invalid(`${path}.nodeId`, 'references an unknown node');
    identifier(event.subscriptionId, `${path}.subscriptionId`);
    member(event.kind, eventKinds, `${path}.kind`);
    member(event.lane, lanes, `${path}.lane`);
    member(event.provenance, provenances, `${path}.provenance`);
    text(event.label, `${path}.label`, 2_000);
    if (own(event, 'state')) record(event.state, `${path}.state`);
    if (own(event, 'cause') && (!Number.isInteger(event.cause) || typeof event.cause !== 'number' || event.cause < 0 || event.cause >= index)) {
      invalid(`${path}.cause`, 'must reference an earlier event; forward, self, and cyclic causes are forbidden');
    }
    if (own(event, 'reason')) {
      member(event.reason, reasons, `${path}.reason`);
      if (event.kind !== 'unsubscribe') invalid(`${path}.reason`, 'end reasons belong to unsubscribe cleanup events');
    }
    let parentId: string | undefined;
    if (own(event, 'parentSubscriptionId')) {
      identifier(event.parentSubscriptionId, `${path}.parentSubscriptionId`);
      parentId = event.parentSubscriptionId;
      if (parentId === event.subscriptionId || !subscriptions.has(parentId)) {
        invalid(`${path}.parentSubscriptionId`, 'parent must reference an earlier, different subscription');
      }
    }
    const existing = subscriptions.get(event.subscriptionId);
    if (event.kind === 'subscribe') {
      if (existing) invalid(`${path}.subscriptionId`, 'subscription identifiers cannot be reused for another subscribe event');
      subscriptions.set(event.subscriptionId, { nodeId: event.nodeId, parentId });
    } else {
      if (!existing) invalid(`${path}.subscriptionId`, 'notification or state event must follow its subscribe event');
      if (existing.nodeId !== event.nodeId || existing.parentId !== parentId) {
        invalid(`${path}.subscriptionId`, 'subscription node and parent must remain unchanged');
      }
    }
  }

  checkBytes(JSON.stringify(input), 'Trace');
  return input as unknown as ExecutionTrace;
}

export function parseTrace(source: string): ExecutionTrace {
  checkBytes(source, 'JSON input');
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new Error('Invalid trace JSON. Import an exported .json trace, not HTML, SVG, or JavaScript.');
  }
  return validateTrace(input);
}

export function serializeTrace(trace: ExecutionTrace): string {
  // Compact output keeps capture, export, and import byte budgets comparable.
  const result = JSON.stringify(validateTrace(trace));
  checkBytes(result, 'JSON export');
  return result;
}
