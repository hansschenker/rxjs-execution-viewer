// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderTraceSvg } from '../src/ui/svg';
import type { ExecutionTrace, PipelineNode, TraceEvent } from '../src/core/types';
import { buildSharedConnection } from '../src/scenarios/shared-connection';

interface Point { x: number; y: number }
interface Box { x: number; y: number; width: number; height: number }

function example(terminal: 'complete' | 'error' = 'complete'): ExecutionTrace {
  return {
    version: 1,
    id: 'replay-evidence',
    title: 'Notification and cleanup are separate events',
    description: 'A small recording with a later subscription.',
    pipeline: 'source → sink',
    clock: { unit: 'ms', scheduler: 'VirtualTimeScheduler', virtual: true },
    truncated: false,
    nodes: [
      { id: 'source', kind: 'source', label: 'Source', description: 'Source boundary.' },
      { id: 'sink', kind: 'sink', label: 'Sink', description: 'Subscriber boundary.' },
    ],
    edges: [{ id: 'source-sink', from: 'source', to: 'sink' }],
    events: [
      { seq: 0, time: 0, nodeId: 'source', subscriptionId: 'source-1', kind: 'subscribe', lane: 'source', provenance: 'observed', label: 'Subscribe' },
      { seq: 1, time: 1, nodeId: 'source', subscriptionId: 'source-1', kind: 'next', lane: 'source', provenance: 'observed', label: 'Next', value: 'visible-now' },
      { seq: 2, time: 1, nodeId: 'source', subscriptionId: 'source-1', kind: 'state', lane: 'internal', provenance: 'modelled', label: 'Remember current value', state: { phase: 'present' } },
      { seq: 3, time: 10, nodeId: 'source', subscriptionId: 'source-1', kind: terminal, lane: 'source', provenance: 'observed', label: terminal },
      { seq: 4, time: 10, nodeId: 'source', subscriptionId: 'source-1', kind: 'unsubscribe', reason: terminal, lane: 'source', provenance: 'observed', label: 'Cleanup' },
      { seq: 5, time: 20, nodeId: 'sink', subscriptionId: 'sink-future', kind: 'subscribe', lane: 'result', provenance: 'observed', label: 'Later subscription' },
      { seq: 6, time: 20, nodeId: 'sink', subscriptionId: 'sink-future', kind: 'state', lane: 'internal', provenance: 'modelled', label: 'Future reaction', state: { secret: 'future-state-sentinel' } },
      { seq: 7, time: 30, nodeId: 'sink', subscriptionId: 'sink-future', kind: 'next', lane: 'result', provenance: 'observed', label: 'Later next', value: 'future-value-sentinel' },
    ],
  };
}

function renderDocument(trace: ExecutionTrace, cursor: number): Document {
  const svg = renderTraceSvg(trace, cursor);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

function nodePositions(doc: Document): Array<[string | null, string | null]> {
  return Array.from(doc.querySelectorAll('[data-node-id]')).map(readPosition);
}

function readPosition(node: Element): [string | null, string | null] {
  return [node.getAttribute('data-node-id'), node.getAttribute('transform')];
}

function nodeBox(doc: Document, id: string): Box {
  const node = doc.querySelector(`[data-node-id="${id}"]`);
  const numbers = (node?.getAttribute('transform') ?? '').match(/-?\d+(?:\.\d+)?/g) ?? [];
  const rectangle = node?.querySelector('rect');
  expect(numbers).toHaveLength(2);
  expect(rectangle).not.toBeNull();
  return {
    x: Number(numbers[0]), y: Number(numbers[1]),
    width: Number(rectangle?.getAttribute('width')), height: Number(rectangle?.getAttribute('height')),
  };
}

/** Decode the exported orthogonal path into independent geometric line segments. */
function pathPoints(path: string): Point[] {
  const tokens = path.match(/[MHV]|-?\d+(?:\.\d+)?/g) ?? [];
  const points: Point[] = [];
  let point: Point = { x: 0, y: 0 };
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++];
    if (command === 'M') point = { x: Number(tokens[index++]), y: Number(tokens[index++]) };
    else if (command === 'H') point = { x: Number(tokens[index++]), y: point.y };
    else if (command === 'V') point = { x: point.x, y: Number(tokens[index++]) };
    else throw new Error(`Unexpected path command ${command}`);
    points.push(point);
  }
  return points;
}

function intersectsInterior(a: Point, b: Point, box: Box): boolean {
  if (a.x === b.x) return a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
  if (a.y === b.y) return a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
  throw new Error('Expected an orthogonal edge segment.');
}

function assertClearPath(points: Point[], boxes: Box[]): void {
  expect(points.length).toBeGreaterThan(1);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    for (const box of boxes) expect(intersectsInterior(from!, to!, box)).toBe(false);
  }
}

describe('SVG replay evidence', () => {
  it.each(['complete', 'error'] as const)('keeps the subscription active after %s until the separate cleanup event', terminal => {
    const trace = example(terminal);
    const notification = renderDocument(trace, 3);
    const active = notification.querySelector('[data-subscription-id="source-1"]');
    expect(notification.querySelector('[data-event-seq="3"]')).not.toBeNull();
    expect(active?.getAttribute('data-lifetime-status')).toBe('active');
    expect(active?.querySelector('.rx-life-live')).not.toBeNull();
    expect(active?.getAttribute('aria-label')).toContain('since #1');

    const cleanup = renderDocument(trace, 4);
    const ended = cleanup.querySelector('[data-subscription-id="source-1"]');
    expect(ended?.getAttribute('data-lifetime-status')).toBe(terminal);
    expect(ended?.querySelector('.rx-life-live')).toBeNull();
    expect(ended?.getAttribute('aria-label')).toContain('#1 → #5');
  });

  it('distinguishes cancellation from completion and does not invent a reason when it is absent', () => {
    const trace = example();
    trace.events = trace.events.slice(0, 2);
    const cleanup: TraceEvent = { seq: 2, time: 4, nodeId: 'source', subscriptionId: 'source-1', kind: 'unsubscribe', lane: 'source', provenance: 'observed', label: 'Cancel', reason: 'cancelled' };
    trace.events.push(cleanup);
    const cancelled = renderDocument(trace, 2).querySelector('[data-subscription-id="source-1"]');
    expect(cancelled?.getAttribute('data-lifetime-status')).toBe('cancelled');
    expect(cancelled?.querySelector('.rx-life-cancelled')).not.toBeNull();
    delete cleanup.reason;
    const unspecified = renderDocument(trace, 2).querySelector('[data-subscription-id="source-1"]');
    expect(unspecified?.getAttribute('data-lifetime-status')).toBe('unsubscribed');
    expect(unspecified?.querySelector('.rx-life-live')).toBeNull();
  });

  it('preserves geometry while exposing only events, payloads, state and subscriptions reached by the cursor', () => {
    const trace = example();
    const initial = renderDocument(trace, -1);
    const early = renderDocument(trace, 2);
    const final = renderDocument(trace, trace.events.length - 1);
    expect(initial.querySelector('[data-event-seq]')).toBeNull();
    expect(initial.querySelector('[data-subscription-id]')).toBeNull();
    expect(early.querySelectorAll('[data-event-seq]')).toHaveLength(3);
    expect(early.querySelector('[data-subscription-id="sink-future"]')).toBeNull();
    expect(early.documentElement.textContent).toContain('visible-now');
    expect(early.documentElement.textContent).toContain('phase=present');
    expect(early.documentElement.textContent).not.toContain('future-value-sentinel');
    expect(early.documentElement.textContent).not.toContain('future-state-sentinel');
    expect(final.documentElement.textContent).toContain('future-value-sentinel');
    for (let cursor = -1; cursor < trace.events.length; cursor += 1) {
      const frame = renderDocument(trace, cursor);
      expect(frame.documentElement.getAttribute('viewBox')).toBe(initial.documentElement.getAttribute('viewBox'));
      expect(nodePositions(frame)).toEqual(nodePositions(initial));
    }
  });

  it('keeps equal-time notifications and cleanup as separately selectable steps', () => {
    const doc = renderDocument(example(), 4);
    const notification = doc.querySelector('[data-event-seq="3"]');
    const cleanup = doc.querySelector('[data-event-seq="4"]');
    expect(notification?.getAttribute('transform')).not.toBe(cleanup?.getAttribute('transform'));
    expect(notification?.getAttribute('aria-label')).toContain('Step 4 at 10');
    expect(cleanup?.getAttribute('aria-label')).toContain('Step 5 at 10');
    expect(notification?.getAttribute('tabindex')).toBe('0');
    expect(cleanup?.getAttribute('tabindex')).toBe('0');
  });
});

describe('SVG graph routing', () => {
  it('routes the shared branch to Observer B without crossing Observer A', () => {
    const trace = buildSharedConnection();
    const doc = renderDocument(trace, -1);
    const branch = doc.querySelector('[data-edge-id="share-b"]');
    const points = pathPoints(branch?.getAttribute('d') ?? '');
    assertClearPath(points, trace.nodes.map(readBox));
    function readBox(node: PipelineNode): Box { return nodeBox(doc, node.id); }
    const sink = nodeBox(doc, 'sink-b');
    const last = points.at(-1)!;
    expect(last.x).toBeGreaterThan(sink.x);
    expect(last.x).toBeLessThan(sink.x + sink.width);
    expect(last.y).toBeGreaterThan(sink.y + sink.height);
    expect(last.y - sink.y - sink.height).toBeLessThan(10);
  });

  it('draws a visible self-loop outside its node with a distinct return point', () => {
    const trace = example();
    trace.edges = [{ id: 'loop', from: 'source', to: 'source' }];
    const doc = renderDocument(trace, -1);
    const path = doc.querySelector('[data-edge-id="loop"]');
    const points = pathPoints(path?.getAttribute('d') ?? '');
    const box = nodeBox(doc, 'source');
    assertClearPath(points, trace.nodes.map(readBox));
    function readBox(node: PipelineNode): Box { return nodeBox(doc, node.id); }
    expect(points[0]).not.toEqual(points.at(-1));
    expect(points.some(outsideRight)).toBe(true);
    expect(points.some(outsideBelow)).toBe(true);
    function outsideRight(point: Point): boolean { return point.x > box.x + box.width; }
    function outsideBelow(point: Point): boolean { return point.y > box.y + box.height; }
  });

  it('keeps multi-row and returning edges out of intervening node interiors', () => {
    const trace = example();
    trace.nodes = [];
    for (let index = 0; index < 13; index += 1) trace.nodes.push({ id: `node-${index}`, kind: 'operator', label: `Node ${index}`, description: '' });
    trace.edges = [
      { id: 'skip-rows', from: 'node-0', to: 'node-12' },
      { id: 'return', from: 'node-12', to: 'node-0' },
      { id: 'reverse-row', from: 'node-9', to: 'node-6' },
    ];
    trace.events = [];
    const doc = renderDocument(trace, -1);
    const boxes = trace.nodes.map(readBox);
    function readBox(node: PipelineNode): Box { return nodeBox(doc, node.id); }
    for (const edge of trace.edges) {
      const path = doc.querySelector(`[data-edge-id="${edge.id}"]`);
      assertClearPath(pathPoints(path?.getAttribute('d') ?? ''), boxes);
    }
  });
});
