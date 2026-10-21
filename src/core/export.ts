import type { ExecutionTrace } from './types';
import { validateTrace } from './serialization';
import { renderTraceSvg } from '../ui/svg';

/** Original implementation; the portable-viewer concept is inspired by Stevan Andjelkovic. */
export const SVG_EXPORT_LIMITS = Object.freeze({ events: 200, bytes: 8 * 1024 * 1024 });

function xmlText(source: string): string {
  return Array.from(source, character => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)
      ? character : '\ufffd';
  }).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Safely embed already-generated SVG strings in a JavaScript data literal inside XML. */
function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function checkExportSize(source: string): void {
  if (new TextEncoder().encode(source).byteLength > SVG_EXPORT_LIMITS.bytes) {
    throw new Error('This SVG would exceed the 8 MiB export limit. Export JSON instead, or capture fewer events.');
  }
}

function checkCursor(trace: ExecutionTrace, cursor: number): void {
  if (!Number.isInteger(cursor) || cursor < -1 || cursor >= trace.events.length) {
    throw new Error(`Snapshot cursor must be an integer between -1 and ${trace.events.length - 1}.`);
  }
}

interface RenderedFrame {
  content: string;
  viewBox: string;
  className: string;
  width: number;
  height: number;
}

/** Only our own renderer's SVG enters this function; imported traces contain JSON data only. */
function unpackRenderedSvg(source: string): RenderedFrame {
  const root = /^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(source);
  if (!root) throw new Error('SVG renderer did not produce a standalone SVG document.');
  const attributes = root[1] ?? '';
  const viewBox = /\bviewBox\s*=\s*(["'])(.*?)\1/.exec(attributes)?.[2];
  if (!viewBox) throw new Error('SVG renderer must provide a numeric viewBox for portable export.');
  const dimensions = viewBox.trim().split(/[\s,]+/).map(Number);
  if (dimensions.length !== 4 || dimensions.some(value => !Number.isFinite(value))) {
    throw new Error('SVG renderer provided an invalid viewBox.');
  }
  const width = dimensions[2] ?? 0;
  const height = dimensions[3] ?? 0;
  if (width <= 0 || height <= 0) throw new Error('SVG renderer dimensions must be positive.');
  const className = /\bclass\s*=\s*(["'])(.*?)\1/.exec(attributes)?.[2] ?? '';
  return { content: root[2] ?? '', viewBox: dimensions.join(' '), className, width, height };
}

export function exportSnapshotSvg(trace: ExecutionTrace, cursor: number): string {
  validateTrace(trace);
  checkCursor(trace, cursor);
  const result = renderTraceSvg(trace, cursor, { idPrefix: 'rxsnapshot' });
  unpackRenderedSvg(result);
  checkExportSize(result);
  return result;
}

/** A bounded, self-contained event replay. Its playback clock does not change recorded timestamps. */
export function exportPlayerSvg(trace: ExecutionTrace): string {
  validateTrace(trace);
  if (trace.events.length > SVG_EXPORT_LIMITS.events) {
    throw new Error('Portable SVG playback supports at most 200 events. Export JSON or a single SVG snapshot for larger traces.');
  }

  const frames: RenderedFrame[] = [];
  let sourceBytes = 0;
  for (let cursor = -1; cursor < trace.events.length; cursor += 1) {
    const source = renderTraceSvg(trace, cursor, { idPrefix: `rxexport-${cursor + 1}` });
    sourceBytes += new TextEncoder().encode(source).byteLength;
    if (sourceBytes > SVG_EXPORT_LIMITS.bytes) {
      throw new Error('The replay frames exceed the 8 MiB export limit. Export JSON or a single SVG snapshot instead.');
    }
    frames.push(unpackRenderedSvg(source));
  }
  const first = frames[0];
  const last = frames.at(-1);
  if (!first || !last) throw new Error('No SVG frames were generated.');
  if (frames.some(frame => frame.viewBox !== first.viewBox)) {
    throw new Error('Portable playback requires the same viewBox for every frame.');
  }

  const toolbarHeight = 84;
  const totalHeight = first.height + toolbarHeight;
  const controls = [
    ['first', 'First', 'Before the first event'],
    ['previous', 'Prev', 'Previous event'],
    ['play', 'Play', 'Play or pause recorded event steps'],
    ['next', 'Next', 'Next event'],
    ['last', 'Last', 'Final recorded event'],
  ].map(([id, label, description], index) => `
    <g id="rxplay-${id}" role="button" tabindex="0" aria-label="${description}" style="cursor:pointer">
      <rect x="${16 + index * 70}" y="14" width="60" height="34" rx="8" fill="#183149" stroke="#45617c"/>
      <text id="rxplay-${id}-label" x="${46 + index * 70}" y="36" text-anchor="middle" style="font:600 13px system-ui,sans-serif;fill:#f5f8fc">${label}</text>
    </g>`).join('');

  const script = `
(() => {
  'use strict';
  const root = document.currentScript && document.currentScript.ownerSVGElement
    ? document.currentScript.ownerSVGElement : document.documentElement;
  const get = id => root.querySelector('#rxplay-' + id);
  const scene = get('scene');
  const progress = get('progress');
  const frames = ${scriptData(frames.map(frame => frame.content))};
  const parser = new DOMParser();
  let index = frames.length - 1;
  let timer;

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    get('play-label').textContent = 'Play';
    get('play').setAttribute('aria-pressed', 'false');
  }

  function show(nextIndex) {
    index = Math.max(0, Math.min(frames.length - 1, nextIndex));
    const parsed = parser.parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + frames[index] + '</svg>', 'image/svg+xml');
    if (parsed.getElementsByTagName('parsererror').length) {
      stop();
      progress.textContent = 'Unable to decode this generated frame.';
      return;
    }
    const children = Array.from(parsed.documentElement.childNodes, node => document.importNode(node, true));
    scene.replaceChildren(...children);
    progress.textContent = 'Step ' + index + ' / ' + (frames.length - 1);
    for (const name of ['first', 'previous']) get(name).setAttribute('aria-disabled', String(index === 0));
    for (const name of ['next', 'last']) get(name).setAttribute('aria-disabled', String(index === frames.length - 1));
  }

  function move(nextIndex) { stop(); show(nextIndex); }
  function togglePlay() {
    if (timer !== undefined) { stop(); return; }
    if (frames.length <= 1) return;
    if (index === frames.length - 1) show(0);
    get('play-label').textContent = 'Pause';
    get('play').setAttribute('aria-pressed', 'true');
    timer = setInterval(() => {
      show(index + 1);
      if (index === frames.length - 1) stop();
    }, 650);
  }

  const actions = {
    first: () => move(0),
    previous: () => move(index - 1),
    play: togglePlay,
    next: () => move(index + 1),
    last: () => move(frames.length - 1)
  };
  for (const [name, action] of Object.entries(actions)) {
    const button = get(name);
    button.addEventListener('click', action);
    button.addEventListener('keydown', event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); action();
      }
    });
  }
  root.addEventListener('keydown', event => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    let action;
    if (event.key === 'ArrowLeft') action = actions.previous;
    else if (event.key === 'ArrowRight') action = actions.next;
    else if (event.key === 'Home') action = actions.first;
    else if (event.key === 'End') action = actions.last;
    else if (event.key === ' ') action = actions.play;
    if (action) { event.preventDefault(); action(); }
  });
  get('play').setAttribute('aria-pressed', 'false');
  show(index);
})();`;

  const result = `<svg xmlns="http://www.w3.org/2000/svg" width="${first.width}" height="${totalHeight}" viewBox="0 0 ${first.width} ${totalHeight}" role="group" tabindex="0" aria-labelledby="rxplay-title rxplay-description">
  <title id="rxplay-title">${xmlText(trace.title)} — recorded execution replay</title>
  <desc id="rxplay-description">Self-contained event replay. First and Home show the state before execution. Arrow keys step through events; Space plays or pauses. Playback uses 650 milliseconds per step for inspection, independently of the recorded time. Without scripts the final recorded frame remains visible. Open this SVG directly in a browser for interaction.</desc>
  <metadata>Original viewer implementation inspired by Stevan Andjelkovic's SVG viewer written in SVG: https://stevana.github.io/visualising_datastructures_over_time_using_svg.html</metadata>
  <rect width="${first.width}" height="${totalHeight}" fill="#0a1424"/>
  <g aria-label="Replay controls">${controls}
    <text id="rxplay-progress" x="382" y="36" style="font:600 14px system-ui,sans-serif;fill:#e2ebf5">Step ${trace.events.length} / ${trace.events.length}</text>
    <text x="16" y="69" style="font:12px system-ui,sans-serif;fill:#b6c9dd">Recorded event order · 650 ms per playback step · original time stays in the diagram${trace.truncated ? ' · capture truncated' : ''}</text>
  </g>
  <svg id="rxplay-scene" class="${xmlText(first.className)}" x="0" y="${toolbarHeight}" width="${first.width}" height="${first.height}" viewBox="${first.viewBox}">${last.content}</svg>
  <script type="application/ecmascript"><![CDATA[${script}]]></script>
</svg>`;
  checkExportSize(result);
  return result;
}
