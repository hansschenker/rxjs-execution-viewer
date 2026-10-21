import { describe, expect, it } from 'vitest';
import { parseTrace, serializeTrace, TRACE_LIMITS, validateTrace } from '../src/core/serialization';
import type { ExecutionTrace, JsonValue } from '../src/core/types';
import { scenarios } from '../src/scenarios';

function example(): ExecutionTrace {
  return {
    version: 1, id: 'test', title: 'A bounded trace', description: 'Validation fixture', pipeline: 'source → sink',
    clock: { unit: 'ms', scheduler: 'TestScheduler', virtual: true }, truncated: false,
    nodes: [
      { id: 'source', kind: 'source', label: 'source', description: '' },
      { id: 'sink', kind: 'sink', label: 'sink', description: '' },
    ],
    edges: [{ id: 'edge', from: 'source', to: 'sink' }],
    events: [
      { seq: 0, time: 0, nodeId: 'sink', subscriptionId: 'sink-1', kind: 'subscribe', lane: 'result', provenance: 'observed', label: 'subscribe' },
      { seq: 1, time: 0, nodeId: 'source', subscriptionId: 'source-1', parentSubscriptionId: 'sink-1', kind: 'subscribe', lane: 'source', provenance: 'observed', label: 'subscribe', cause: 0 },
      { seq: 2, time: 10, nodeId: 'source', subscriptionId: 'source-1', parentSubscriptionId: 'sink-1', kind: 'next', lane: 'source', provenance: 'observed', label: 'next', value: { text: "O'Brien\\temp\\new <svg><desc>data</desc></svg> </script> ]]> \u2028 \u2029", nested: [1, null, true] }, cause: 1 },
      { seq: 3, time: 10, nodeId: 'sink', subscriptionId: 'sink-1', kind: 'next', lane: 'result', provenance: 'observed', label: 'next', value: 1, cause: 2 },
    ],
  };
}

describe('versioned trace serialization', () => {
  it.each(scenarios)('round-trips the recorded $title scenario', scenario => {
    const trace = scenario.build();
    expect(parseTrace(serializeTrace(trace))).toEqual(trace);
  });

  it('round-trips JSON values literally without interpreting markup, quotes, or backslashes', () => {
    const trace = example();
    expect(parseTrace(serializeTrace(trace))).toEqual(trace);
  });

  it('accepts same-time events in explicit sequence order and an incomplete bounded capture', () => {
    const trace = example();
    trace.events.forEach(event => { event.time = 0; });
    trace.truncated = true;
    expect(validateTrace(trace)).toEqual(trace);
    trace.events = [];
    expect(validateTrace(trace).events).toEqual([]);
  });

  it.each(['<svg><script>alert(1)</script></svg>', '<html></html>', 'const trace = {}', '{broken'])('rejects non-JSON input: %s', source => {
    expect(() => parseTrace(source)).toThrow(/Invalid trace JSON/);
  });

  it('rejects unknown versions and fields instead of treating them as trusted renderer data', () => {
    expect(() => validateTrace({ ...example(), version: 2 })).toThrow(/version/);
    expect(() => validateTrace({ ...example(), svg: '<svg onload="alert(1)"/>' })).toThrow(/unknown field/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects unsafe object key %s at any depth', key => {
    const trace = example();
    trace.events[2]!.value = JSON.parse(`{"${key}":{"polluted":true}}`) as JsonValue;
    expect(() => validateTrace(trace)).toThrow(/unsafe object key/);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('rejects accessors without running them', () => {
    const trace = example();
    let invoked = false;
    Object.defineProperty(trace, 'title', { enumerable: true, get: () => { invoked = true; return 'side effect'; } });
    expect(() => validateTrace(trace)).toThrow(/data properties/);
    expect(invoked).toBe(false);
  });

  it.each([NaN, Infinity, undefined, () => 1, new Date(), 1n])('rejects non-JSON value %s', value => {
    const trace = example();
    (trace.events[2] as unknown as Record<string, unknown>).value = value;
    expect(() => validateTrace(trace)).toThrow(/Invalid trace/);
  });

  it('rejects cycles, sparse arrays, and excessive nesting', () => {
    const trace = example();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    (trace.events[2] as unknown as Record<string, unknown>).value = cyclic;
    expect(() => validateTrace(trace)).toThrow(/cyclic/);
    trace.events[2]!.value = new Array<JsonValue>(3);
    expect(() => validateTrace(trace)).toThrow(/dense|sparse/);
    let deep: JsonValue = null;
    for (let depth = 0; depth <= TRACE_LIMITS.depth; depth += 1) deep = { child: deep };
    trace.events[2]!.value = deep;
    expect(() => validateTrace(trace)).toThrow(/nesting/);
  });

  it('bounds bytes before parsing and rejects excessive event or node counts', () => {
    expect(() => parseTrace(' '.repeat(TRACE_LIMITS.bytes + 1))).toThrow(/5 MiB/);
    const trace = example();
    trace.events = Array.from({ length: TRACE_LIMITS.events + 1 }, () => ({ ...trace.events[0]! }));
    expect(() => validateTrace(trace)).toThrow(/2000 entries/);
    const nodes = example();
    nodes.nodes = Array.from({ length: TRACE_LIMITS.nodes + 1 }, (_, index) => ({ ...nodes.nodes[0]!, id: `node-${index}` }));
    expect(() => validateTrace(nodes)).toThrow(/100 entries/);
  });

  it('rejects gaps, duplicate sequence numbers, time reversal, and invalid clock values', () => {
    const gap = example(); gap.events[2]!.seq = 9;
    expect(() => validateTrace(gap)).toThrow(/consecutive and zero-based/);
    const duplicate = example(); duplicate.events[2]!.seq = 1;
    expect(() => validateTrace(duplicate)).toThrow(/consecutive and zero-based/);
    const time = example(); time.events[3]!.time = 9;
    expect(() => validateTrace(time)).toThrow(/nondecreasing/);
    const negative = example(); negative.events[0]!.time = -1;
    expect(() => validateTrace(negative)).toThrow(/nonnegative/);
  });

  it.each([2, 3, -1, 0.5])('rejects invalid direct cause %s for event 2', cause => {
    const trace = example(); trace.events[2]!.cause = cause;
    expect(() => validateTrace(trace)).toThrow(/earlier event/);
  });

  it('rejects dangling node and edge references and duplicate identifiers', () => {
    const node = example(); node.events[2]!.nodeId = 'missing';
    expect(() => validateTrace(node)).toThrow(/unknown node/);
    const edge = example(); edge.edges[0]!.to = 'missing';
    expect(() => validateTrace(edge)).toThrow(/unknown node/);
    const duplicateNode = example(); duplicateNode.nodes.push({ ...duplicateNode.nodes[0]! });
    expect(() => validateTrace(duplicateNode)).toThrow(/duplicate node/);
    const duplicateEdge = example(); duplicateEdge.edges.push({ ...duplicateEdge.edges[0]! });
    expect(() => validateTrace(duplicateEdge)).toThrow(/duplicate edge/);
  });

  it('validates subscription identity, order, and parent references', () => {
    const missing = example(); missing.events[2]!.subscriptionId = 'unknown';
    expect(() => validateTrace(missing)).toThrow(/follow its subscribe/);
    const reused = example(); reused.events[2]!.kind = 'subscribe';
    expect(() => validateTrace(reused)).toThrow(/cannot be reused/);
    const parent = example(); parent.events[1]!.parentSubscriptionId = 'source-1';
    expect(() => validateTrace(parent)).toThrow(/earlier, different/);
    const drift = example(); delete drift.events[2]!.parentSubscriptionId;
    expect(() => validateTrace(drift)).toThrow(/remain unchanged/);
    const changedNode = example(); changedNode.events[2]!.nodeId = 'sink';
    expect(() => validateTrace(changedNode)).toThrow(/remain unchanged/);
  });

  it('checks enums and the distinction between notifications and cleanup', () => {
    const lane = example(); (lane.events[2] as unknown as Record<string, unknown>).lane = 'timer';
    expect(() => validateTrace(lane)).toThrow(/expected one of/);
    const notification = example(); notification.events[2]!.reason = 'cancelled';
    expect(() => validateTrace(notification)).toThrow(/cleanup/);
  });
});
