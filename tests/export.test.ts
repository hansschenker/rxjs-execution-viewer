// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser as StrictXmlParser } from '@xmldom/xmldom';
import { exportPlayerSvg, exportSnapshotSvg, SVG_EXPORT_LIMITS } from '../src/core/export';
import type { ExecutionTrace } from '../src/core/types';
import { scenarios } from '../src/scenarios';

const hostileText = "O'Brien C:\\temp\\new </script> ]]> <svg><desc>nested</desc></svg> <image onload='globalThis.__svgInjected=true'/> \u2028 \u2029";

function example(): ExecutionTrace {
  return {
    version: 1, id: 'safe-export', title: hostileText, description: 'XML and script safety', pipeline: 'source → sink',
    clock: { unit: 'ms', scheduler: 'TestScheduler', virtual: true }, truncated: false,
    nodes: [
      { id: 'source', kind: 'source', label: 'source', description: hostileText },
      { id: 'sink', kind: 'sink', label: 'sink', description: '' },
    ],
    edges: [{ id: 'edge', from: 'source', to: 'sink', label: '<next>' }],
    events: [
      { seq: 0, time: 0, nodeId: 'sink', subscriptionId: 'sink-1', kind: 'subscribe', lane: 'result', provenance: 'observed', label: 'subscribe' },
      { seq: 1, time: 0, nodeId: 'source', subscriptionId: 'source-1', parentSubscriptionId: 'sink-1', kind: 'subscribe', lane: 'source', provenance: 'observed', label: 'subscribe', cause: 0 },
      { seq: 2, time: 10, nodeId: 'source', subscriptionId: 'source-1', parentSubscriptionId: 'sink-1', kind: 'next', lane: 'source', provenance: 'observed', label: 'next', value: hostileText, cause: 1 },
      { seq: 3, time: 10, nodeId: 'sink', subscriptionId: 'sink-1', kind: 'next', lane: 'result', provenance: 'observed', label: 'next', value: hostileText, cause: 2 },
    ],
  };
}

function assertXml(source: string): void {
  const messages: string[] = [];
  const doc = new StrictXmlParser({ onError: (level, message) => messages.push(`${level}: ${message}`) })
    .parseFromString(source, 'image/svg+xml');
  expect(messages).toEqual([]);
  expect(doc.documentElement?.localName).toBe('svg');
}

function startPlayer(source: string): Document {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  const script = doc.querySelector('script')?.textContent;
  expect(script).toBeTruthy();
  // Execute exactly the generated portable script against a real XML DOM.
  // The exported document itself does not use eval or Function.
  const execute = new Function('document', 'DOMParser', 'setInterval', 'clearInterval', script ?? '');
  execute(doc, DOMParser, setInterval, clearInterval);
  return doc;
}

function click(doc: Document, id: string): void {
  doc.querySelector(`#rxplay-${id}`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function key(doc: Document, value: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  doc.documentElement.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('safe SVG exports', () => {
  it.each(scenarios)('exports and replays the recorded $title scenario', scenario => {
    const trace = scenario.build();
    assertXml(exportSnapshotSvg(trace, trace.events.length - 1));
    const player = exportPlayerSvg(trace);
    assertXml(player);
    const doc = startPlayer(player);
    click(doc, 'first');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe(`Step 0 / ${trace.events.length}`);
    click(doc, 'last');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe(`Step ${trace.events.length} / ${trace.events.length}`);
  });

  it('renders a well-formed snapshot while keeping malicious-looking values as literal text', () => {
    const svg = exportSnapshotSvg(example(), 3);
    assertXml(svg);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelectorAll('script, image, foreignObject')).toHaveLength(0);
    expect(doc.querySelector('title')?.textContent).toContain("O'Brien C:\\temp\\new </script> ]]>");
    expect(doc.querySelector('[onload]')).toBeNull();
  });

  it('rejects out-of-range snapshots and imported executable fields', () => {
    expect(() => exportSnapshotSvg(example(), 99)).toThrow(/cursor/);
    expect(() => exportSnapshotSvg(example(), -2)).toThrow(/cursor/);
    const unknown = { ...example(), html: '<script>alert(1)</script>' };
    expect(() => exportPlayerSvg(unknown)).toThrow(/unknown field/);
  });

  it('provides the final useful frame even when scripts do not run', () => {
    const svg = exportPlayerSvg(example());
    assertXml(svg);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 4 / 4');
    expect(doc.querySelector('#rxplay-scene')?.textContent).toContain('result');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelectorAll('image, foreignObject, [onload]')).toHaveLength(0);
    const ids = [...doc.querySelectorAll('[id]')].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.querySelector('script')?.textContent).not.toMatch(/\beval\s*\(|\bfetch\s*\(|new Function/);
  });

  it('runs exported navigation safely through frames containing quotes, backslashes, script closers and nested SVG text', () => {
    const doc = startPlayer(exportPlayerSvg(example()));
    const originalBox = doc.documentElement.getAttribute('viewBox');
    click(doc, 'first');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 0 / 4');
    expect(doc.querySelector('#rxplay-scene [data-event-seq]')).toBeNull();
    click(doc, 'next');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 1 / 4');
    click(doc, 'last');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 4 / 4');
    click(doc, 'previous');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 3 / 4');
    expect(doc.querySelector('#rxplay-scene title')?.textContent).toContain("O'Brien C:\\temp\\new </script> ]]>");
    expect(doc.querySelectorAll('[onload], image')).toHaveLength(0);
    expect(globalThis).not.toHaveProperty('__svgInjected');
    expect(doc.documentElement.getAttribute('viewBox')).toBe(originalBox);
  });

  it('handles only its own keyboard shortcuts and clamps the boundaries', () => {
    const doc = startPlayer(exportPlayerSvg(example()));
    expect(key(doc, 'a').defaultPrevented).toBe(false);
    expect(key(doc, 'ArrowLeft', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(doc, 'Home').defaultPrevented).toBe(true);
    key(doc, 'ArrowLeft');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 0 / 4');
    key(doc, 'ArrowRight');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 1 / 4');
    key(doc, 'End');
    key(doc, 'ArrowRight');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 4 / 4');
  });

  it('plays from the beginning when opened at the final frame, and pauses and stops correctly', () => {
    vi.useFakeTimers();
    const doc = startPlayer(exportPlayerSvg(example()));
    click(doc, 'play');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 0 / 4');
    expect(doc.querySelector('#rxplay-play-label')?.textContent).toBe('Pause');
    vi.advanceTimersByTime(650);
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 1 / 4');
    click(doc, 'play');
    vi.advanceTimersByTime(1_300);
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 1 / 4');
    click(doc, 'play');
    vi.advanceTimersByTime(10_000);
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 4 / 4');
    expect(doc.querySelector('#rxplay-play-label')?.textContent).toBe('Play');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports an unstarted trace and states clearly when capture was truncated', () => {
    const trace = example(); trace.events = []; trace.truncated = true;
    const svg = exportPlayerSvg(trace);
    assertXml(svg);
    const doc = startPlayer(svg);
    click(doc, 'play');
    expect(doc.querySelector('#rxplay-progress')?.textContent).toBe('Step 0 / 0');
    expect(doc.documentElement.textContent).toContain('capture truncated');
  });

  it('caps full-frame replay exports and points users to JSON or snapshots', () => {
    const trace = example();
    const source = trace.events[3]!;
    trace.events = [trace.events[0]!, ...Array.from({ length: SVG_EXPORT_LIMITS.events }, (_, index) => ({ ...source, seq: index + 1, time: 10, cause: 0 }))];
    expect(() => exportPlayerSvg(trace)).toThrow(/200 events.*JSON/);
  });
});
