import { replayTrace } from './core/replay';
import { exportPlayerSvg, exportSnapshotSvg } from './core/export';
import { parseTrace, serializeTrace, validateTrace } from './core/serialization';
import type { ExecutionTrace, JsonValue, PipelineNode, TraceEvent } from './core/types';
import { scenarios } from './scenarios';
import { renderTraceSvg } from './ui/svg';
import './ui/styles.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('The application mount point is missing.');
if (scenarios.length === 0) throw new Error('At least one execution scenario is required.');

let trace = validateTrace(scenarios[0]!.build());
let cursor = trace.events.length - 1;
let selectedNodeId = trace.nodes.find(isOperator)?.id ?? trace.nodes[0]?.id ?? '';
let timer: number | undefined;
let playing = false;
let eventsPerSecond = 4;

app.innerHTML = renderShell();
const diagram = requiredElement<HTMLDivElement>('#diagram');
const inspector = requiredElement<HTMLElement>('#inspector');
const eventList = requiredElement<HTMLTableSectionElement>('#event-list');
const seek = requiredElement<HTMLInputElement>('#seek');
const scenarioSelect = requiredElement<HTMLSelectElement>('#scenario');
const importInput = requiredElement<HTMLInputElement>('#import-file');

bindControls();
render();

function isOperator(node: PipelineNode): boolean {
  return node.kind === 'operator';
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing application element: ${selector}`);
  return element;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderShell(): string {
  return `
    <header class="app-header">
      <a class="brand" href="./" aria-label="RxJS execution viewer home">
        <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><path d="M7 24h34M24 7v34" stroke="currentColor" opacity=".4" stroke-width="2"/><circle cx="10" cy="24" r="5" fill="currentColor"/><circle cx="24" cy="12" r="5" fill="currentColor"/><circle cx="38" cy="24" r="5" fill="currentColor"/></svg>
        <span>rxjs<span class="brand-secondary"> / execution viewer</span></span>
      </a>
      <nav class="header-actions" aria-label="Trace files">
        <button class="button button-quiet" id="import-button" type="button">Import trace</button>
        <button class="button button-quiet" id="export-json" type="button">Export JSON</button>
        <a class="button button-quiet" href="https://github.com/hansschenker/rxjs-execution-viewer" target="_blank" rel="noreferrer">GitHub ↗</a>
      </nav>
      <input class="sr-only" id="import-file" type="file" accept=".json,application/json" tabindex="-1" aria-label="Import execution trace JSON" />
    </header>
    <main class="workspace">
      <section class="intro" aria-labelledby="page-title">
        <div class="intro-copy">
          <p class="eyebrow">Structure · execution · explanation</p>
          <h1 id="page-title">An execution, one event at a time.</h1>
          <p>Follow values, inspect reactions, and see exactly when a subscription ends.</p>
        </div>
        <div class="scenario-picker">
          <label for="scenario">Recorded example</label>
          <select id="scenario">${scenarios.map(renderScenarioOption).join('')}</select>
          <p class="scenario-detail" id="scenario-detail"></p>
        </div>
      </section>
      <div class="stat-grid" aria-label="Execution facts">
        <div class="stat-card"><span>Recorded events</span><strong id="event-count"></strong></div>
        <div class="stat-card"><span>Trace duration</span><strong id="duration"></strong></div>
        <div class="stat-card"><span>Subscriptions</span><strong id="subscription-count"></strong></div>
        <div class="stat-card"><span>Execution clock</span><strong id="clock-name"></strong></div>
      </div>
      <div class="workspace-grid">
        <section class="stage-card" aria-labelledby="trace-title">
          <div class="stage-heading">
            <div><p class="eyebrow">Execution canvas</p><h2 id="trace-title"></h2></div>
            <div class="header-actions">
              <button type="button" class="button" id="export-snapshot">SVG snapshot</button>
              <button type="button" class="button button-primary" id="export-player">SVG player ↓</button>
            </div>
          </div>
          <p id="trace-description" class="trace-description"></p>
          <pre class="code-block pipeline-code"><code id="pipeline-code"></code></pre>
          <div class="legend" aria-label="Evidence legend">
            <span><i class="legend-dot observed"></i>Observed boundary event</span>
            <span><i class="legend-dot modelled"></i>Modelled operator state</span>
            <span class="muted">Select a node or event to inspect it</span>
            <label class="zoom-control" for="zoom">Canvas scale <select id="zoom"><option value="fit">Fit width</option><option value="1">100%</option><option value="1.25">125%</option></select></label>
          </div>
          <div class="transport" aria-label="Replay controls">
            <div class="transport-buttons">
              <button class="button button-icon" type="button" id="first" aria-label="Before the first event" title="Start (Home)">|←</button>
              <button class="button button-icon" type="button" id="previous" aria-label="Previous event" title="Previous event (Left arrow)">←</button>
              <button class="button button-primary" type="button" id="play" aria-label="Play recorded execution" aria-pressed="false">▶ Replay</button>
              <button class="button button-icon" type="button" id="next" aria-label="Next event" title="Next event (Right arrow)">→</button>
              <button class="button button-icon" type="button" id="last" aria-label="Last event" title="End (End)">→|</button>
            </div>
            <label class="speed-control" for="speed">Events / second
              <select id="speed"><option value="1">1</option><option value="2">2</option><option value="4" selected>4</option><option value="8">8</option></select>
            </label>
            <p class="progress-summary" id="progress-summary" role="status" aria-live="off"></p>
            <div class="seek-control"><label class="sr-only" for="seek">Replay position</label><input type="range" id="seek" min="-1" max="0" step="1" value="-1" /></div>
          </div>
          <div class="diagram-scroll" tabindex="0" role="region" aria-label="Execution canvas; scroll for the full timeline"><div id="diagram" class="diagram"></div></div>
          <p class="capture-note" id="capture-note"></p>
          <section class="ledger" aria-labelledby="ledger-title">
            <div class="title-row"><h3 id="ledger-title">Event ledger</h3><span class="muted">Total order, including events at the same time</span></div>
            <div class="event-table-scroll"><table class="event-table"><thead><tr><th scope="col">Step</th><th scope="col">Time</th><th scope="col">Node / subscription</th><th scope="col">Event</th><th scope="col">Evidence</th></tr></thead><tbody id="event-list"></tbody></table></div>
          </section>
        </section>
        <aside id="inspector" class="inspector" aria-label="Event and operator inspector"></aside>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
      <footer class="footer"><span>RxJS 7.8.2 · deterministic examples · trace format v1</span><span class="shortcuts">← → step &nbsp; · &nbsp; Space play / pause &nbsp; · &nbsp; Home / End</span></footer>
    </main>`;
}

function renderScenarioOption(scenario: (typeof scenarios)[number]): string {
  return `<option value="${escapeHtml(scenario.id)}">${escapeHtml(scenario.title)}</option>`;
}

function bindControls(): void {
  requiredElement<HTMLButtonElement>('#first').addEventListener('click', firstEvent);
  requiredElement<HTMLButtonElement>('#previous').addEventListener('click', previousEvent);
  requiredElement<HTMLButtonElement>('#play').addEventListener('click', togglePlayback);
  requiredElement<HTMLButtonElement>('#next').addEventListener('click', nextEvent);
  requiredElement<HTMLButtonElement>('#last').addEventListener('click', lastEvent);
  requiredElement<HTMLSelectElement>('#speed').addEventListener('change', changeSpeed);
  requiredElement<HTMLSelectElement>('#zoom').addEventListener('change', changeZoom);
  seek.addEventListener('input', seekToEvent);
  scenarioSelect.addEventListener('change', changeScenario);
  diagram.addEventListener('click', selectDiagramItem);
  diagram.addEventListener('keydown', activateDiagramItem);
  eventList.addEventListener('click', selectLedgerEvent);
  document.addEventListener('keydown', handleShortcuts);
  requiredElement<HTMLButtonElement>('#import-button').addEventListener('click', openImport);
  importInput.addEventListener('change', importTrace);
  requiredElement<HTMLButtonElement>('#export-json').addEventListener('click', downloadJson);
  requiredElement<HTMLButtonElement>('#export-snapshot').addEventListener('click', downloadSnapshot);
  requiredElement<HTMLButtonElement>('#export-player').addEventListener('click', downloadPlayer);
  document.addEventListener('visibilitychange', pauseWhenHidden);
}

function render(): void {
  const state = replayTrace(trace, cursor);
  requiredElement('#event-count').textContent = String(trace.events.length);
  requiredElement('#duration').textContent = `${trace.events.at(-1)?.time ?? 0} ${trace.clock.unit}`;
  requiredElement('#subscription-count').textContent = String(trace.events.filter(isSubscribe).length);
  requiredElement('#clock-name').textContent = trace.clock.virtual ? 'Virtual time' : 'Recorded time';
  requiredElement('#clock-name').setAttribute('title', trace.clock.scheduler);
  requiredElement('#trace-title').textContent = trace.title;
  requiredElement('#trace-description').textContent = trace.description;
  requiredElement('#pipeline-code').textContent = trace.pipeline;
  requiredElement('#scenario-detail').textContent = scenarios.find(matchesSelectedScenario)?.subtitle ?? 'Imported recording · replay only';
  diagram.innerHTML = renderTraceSvg(trace, cursor, { selectedNodeId, idPrefix: 'main' });
  inspector.innerHTML = renderInspector();
  eventList.innerHTML = trace.events.map(renderEventRow).join('');
  seek.max = String(trace.events.length - 1);
  seek.value = String(cursor);
  seek.setAttribute('aria-valuetext', state.selected ? `Step ${cursor + 1}: ${state.selected.label}, ${state.selected.time} ${trace.clock.unit}` : 'Before execution');
  requiredElement('#progress-summary').textContent = state.selected
    ? `Step ${cursor + 1} / ${trace.events.length} · t = ${state.selected.time} ${trace.clock.unit}`
    : `Before execution · ${trace.events.length} recorded events`;
  requiredElement('#capture-note').textContent = trace.truncated
    ? 'Capture limit reached. This trace is a partial recording; later events are not available.'
    : `Playback reads the saved trace; it never resubscribes. ${trace.clock.scheduler} controls trace time. Playback speed controls only the inspection pace.`;
  requiredElement('#capture-note').classList.toggle('notice', trace.truncated);
  requiredElement<HTMLButtonElement>('#first').disabled = cursor < 0;
  requiredElement<HTMLButtonElement>('#previous').disabled = cursor < 0;
  requiredElement<HTMLButtonElement>('#next').disabled = cursor >= trace.events.length - 1;
  requiredElement<HTMLButtonElement>('#last').disabled = cursor >= trace.events.length - 1;
  requiredElement<HTMLButtonElement>('#play').disabled = trace.events.length === 0;
  renderPlaybackButton();
}

function matchesSelectedScenario(scenario: (typeof scenarios)[number]): boolean {
  return scenario.id === scenarioSelect.value;
}

function isSubscribe(event: TraceEvent): boolean {
  return event.kind === 'subscribe';
}

function renderInspector(): string {
  const state = replayTrace(trace, cursor);
  const node = trace.nodes.find(matchesSelectedNode);
  const event = state.selected;
  const modelState = state.modelByNode[selectedNodeId];
  const latest = state.latestByNode[selectedNodeId];
  const lifetimes = state.lifetimes.filter(matchesSelectedLifetime);
  return `
    <div class="inspector-section"><p class="eyebrow">Inspector</p><h2>${escapeHtml(node?.label ?? 'Select a node')}</h2><p>${escapeHtml(node?.description ?? 'Choose a pipeline node or event to see its explanation.')}</p></div>
    <section class="inspector-section"><div class="title-row"><h3>Selected event</h3>${event ? evidenceBadge(event) : ''}</div>
      ${event ? `<p class="event-headline">${escapeHtml(event.label)}</p><dl class="event-meta"><dt>Order</dt><dd>#${event.seq + 1}</dd><dt>Time</dt><dd>${event.time} ${trace.clock.unit}</dd><dt>Node</dt><dd>${escapeHtml(event.nodeId)}</dd><dt>Subscription</dt><dd>${escapeHtml(event.subscriptionId)}</dd><dt>Kind</dt><dd>${escapeHtml(event.kind)}${event.reason ? ` · ${escapeHtml(event.reason)}` : ''}</dd>${event.cause !== undefined ? `<dt>Caused by</dt><dd>#${event.cause + 1}</dd>` : ''}</dl>${event.value !== undefined ? `<pre class="code-block value-preview">${escapeHtml(formatValue(event.value))}</pre>` : ''}` : '<p class="empty-state">Before the first subscription. Step forward to begin.</p>'}
    </section>
    <section class="inspector-section"><div class="title-row"><h3>State at this step</h3><span class="badge badge-modelled">Modelled</span></div>
      ${modelState ? `<pre class="code-block value-preview">${escapeHtml(formatValue(modelState))}</pre>` : `<p class="empty-state">${latest ? 'No semantic state has been recorded for this node at this step.' : 'This node has not reacted yet.'}</p>`}
      <p class="model-note">A teaching model explains operator behavior. These are not directly inspected RxJS closure variables.</p>
    </section>
    ${node?.model ? `<section class="inspector-section"><h3>Mealy model</h3><dl class="model-grid">${renderModelField('S', 'State', node.model.state)}${renderModelField('S₀', 'Initial state', node.model.initial)}${renderModelField('Z', 'Input', node.model.input)}${renderModelField('A', 'Output', node.model.output)}${renderModelField('T', 'Input controller', node.model.transition)}${renderModelField('G', 'Action policy', node.model.action)}</dl></section>` : ''}
    <section class="inspector-section"><h3>Subscriptions at this step</h3>${lifetimes.length ? `<ul class="subscription-list">${lifetimes.map(renderLifetime).join('')}</ul>` : '<p class="empty-state">No subscriptions recorded yet.</p>'}<p class="model-note">Completion is a notification. Unsubscription is cleanup; cancellation does not send a completion notification.</p></section>`;
}

function matchesSelectedNode(node: PipelineNode): boolean {
  return node.id === selectedNodeId;
}

function matchesSelectedLifetime(lifetime: ReturnType<typeof replayTrace>['lifetimes'][number]): boolean {
  return lifetime.nodeId === selectedNodeId;
}

function renderLifetime(lifetime: ReturnType<typeof replayTrace>['lifetimes'][number]): string {
  return `<li><strong>${escapeHtml(lifetime.id)}</strong><span>${lifetime.start} → ${lifetime.end ?? 'active'} ${trace.clock.unit}${lifetime.reason ? ` · ${escapeHtml(lifetime.reason)}` : ''}</span>${lifetime.parentId ? `<small>Parent: ${escapeHtml(lifetime.parentId)}</small>` : ''}</li>`;
}

function renderModelField(symbol: string, label: string, value: string): string {
  return `<div class="model-item"><dt><b>${symbol}</b> ${label}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function formatValue(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function evidenceBadge(event: TraceEvent): string {
  return `<span class="badge badge-${event.provenance}">${event.provenance === 'observed' ? 'Observed' : 'Modelled'}</span>`;
}

function renderEventRow(event: TraceEvent): string {
  const current = event.seq === cursor;
  return `<tr class="event-row${current ? ' active' : ''}${event.seq > cursor ? ' future' : ''}"${current ? ' aria-current="step"' : ''}>
    <td><button class="event-step" type="button" data-seq="${event.seq}" aria-label="Inspect step ${event.seq + 1}: ${escapeHtml(event.label)}">${String(event.seq + 1).padStart(2, '0')}</button></td>
    <td class="mono">${event.time}<small> ${trace.clock.unit}</small></td>
    <td><strong>${escapeHtml(event.nodeId)}</strong><small>${escapeHtml(event.subscriptionId)}</small></td>
    <td><span class="event-kind">${escapeHtml(event.kind)}</span> ${escapeHtml(event.label)}</td>
    <td>${evidenceBadge(event)}</td>
  </tr>`;
}

function setCursor(next: number): void {
  cursor = Math.max(-1, Math.min(trace.events.length - 1, Math.trunc(next)));
  selectedNodeId = trace.events[cursor]?.nodeId ?? selectedNodeId;
  render();
}

function stopPlayback(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  playing = false;
  renderPlaybackButton();
}

function renderPlaybackButton(): void {
  const button = requiredElement<HTMLButtonElement>('#play');
  button.textContent = playing ? 'Ⅱ Pause' : cursor === trace.events.length - 1 ? '▶ Replay' : '▶ Play';
  button.setAttribute('aria-pressed', String(playing));
  button.setAttribute('aria-label', playing ? 'Pause replay' : 'Play recorded execution');
}

function togglePlayback(): void {
  if (playing) {
    stopPlayback();
    return;
  }
  if (trace.events.length === 0) return;
  if (cursor >= trace.events.length - 1) setCursor(-1);
  playing = true;
  renderPlaybackButton();
  advancePlayback();
}

function advancePlayback(): void {
  if (!playing) return;
  if (cursor >= trace.events.length - 1) {
    stopPlayback();
    return;
  }
  setCursor(cursor + 1);
  timer = window.setTimeout(advancePlayback, 1000 / eventsPerSecond);
}

function firstEvent(): void { stopPlayback(); setCursor(-1); }
function previousEvent(): void { stopPlayback(); setCursor(cursor - 1); }
function nextEvent(): void { stopPlayback(); setCursor(cursor + 1); }
function lastEvent(): void { stopPlayback(); setCursor(trace.events.length - 1); }
function seekToEvent(): void { stopPlayback(); setCursor(Number(seek.value)); }

function changeSpeed(event: Event): void {
  eventsPerSecond = Number((event.target as HTMLSelectElement).value);
}

function changeZoom(event: Event): void {
  const scale = (event.target as HTMLSelectElement).value;
  diagram.style.setProperty('--scene-min-width', scale === 'fit' ? '0px' : `${Number(scale) * 1280}px`);
}

function changeScenario(): void {
  const scenario = scenarios.find(matchesSelectedScenario);
  if (!scenario) return;
  try {
    loadTrace(validateTrace(scenario.build()));
    announce(`Loaded ${scenario.title}.`);
  } catch (error) {
    announceError(error);
  }
}

function loadTrace(nextTrace: ExecutionTrace): void {
  stopPlayback();
  trace = nextTrace;
  cursor = trace.events.length - 1;
  selectedNodeId = trace.nodes.find(isOperator)?.id ?? trace.nodes[0]?.id ?? '';
  render();
}

function selectDiagramItem(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const eventTarget = target.closest<Element>('[data-event-seq]');
  if (eventTarget) {
    stopPlayback();
    setCursor(Number(eventTarget.getAttribute('data-event-seq')));
    return;
  }
  const nodeTarget = target.closest<Element>('[data-node-id]');
  const nodeId = nodeTarget?.getAttribute('data-node-id');
  if (nodeId && trace.nodes.some(function hasNode(node) { return node.id === nodeId; })) {
    selectedNodeId = nodeId;
    render();
  }
}

function activateDiagramItem(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!(event.target instanceof Element) || !event.target.closest('[data-node-id], [data-event-seq]')) return;
  event.preventDefault();
  event.stopPropagation();
  selectDiagramItem(event);
}

function selectLedgerEvent(event: Event): void {
  if (!(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLButtonElement>('button[data-seq]');
  if (!target) return;
  stopPlayback();
  setCursor(Number(target.dataset.seq));
}

function handleShortcuts(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target instanceof Element && event.target.closest('input, select, textarea, button, a, [contenteditable="true"], [role="button"]')) return;
  const action = { ArrowLeft: previousEvent, ArrowRight: nextEvent, Home: firstEvent, End: lastEvent, ' ': togglePlayback }[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

function pauseWhenHidden(): void {
  if (document.hidden) stopPlayback();
}

function openImport(): void {
  stopPlayback();
  importInput.click();
}

async function importTrace(): Promise<void> {
  const file = importInput.files?.[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Trace files must be at most 5 MiB.');
    const imported = parseTrace(await file.text());
    let option = scenarioSelect.querySelector<HTMLOptionElement>('option[value="imported"]');
    if (!option) {
      option = document.createElement('option');
      option.value = 'imported';
      scenarioSelect.append(option);
    }
    option.textContent = `Imported: ${imported.title}`;
    scenarioSelect.value = 'imported';
    loadTrace(imported);
    announce(`Imported ${imported.events.length} events from ${file.name}. The trace is replayed locally.`);
  } catch (error) {
    announceError(error);
  } finally {
    importInput.value = '';
  }
}

function fileStem(): string {
  return trace.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'rxjs-execution';
}

function downloadJson(): void {
  try { download(serializeTrace(trace), `${fileStem()}.trace.json`, 'application/json'); announce('Trace JSON exported.'); }
  catch (error) { announceError(error); }
}

function downloadSnapshot(): void {
  try { download(exportSnapshotSvg(trace, cursor), `${fileStem()}-step-${cursor + 1}.svg`, 'image/svg+xml'); announce('SVG snapshot exported at the selected step.'); }
  catch (error) { announceError(error); }
}

function downloadPlayer(): void {
  try { download(exportPlayerSvg(trace), `${fileStem()}-player.svg`, 'image/svg+xml'); announce('Portable SVG player exported. Open the file directly in a browser for controls; image embeds show its static preview.'); }
  catch (error) { announceError(error); }
}

function download(contents: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(function revokeDownload() { URL.revokeObjectURL(url); }, 30_000);
}

function announce(message: string): void {
  requiredElement('#status').textContent = message;
}

function announceError(error: unknown): void {
  announce(error instanceof Error ? error.message : 'The operation could not be completed.');
}
