import { replayTrace } from '../core/replay';
import type { ExecutionTrace, JsonValue, Lane, PipelineNode, SubscriptionLifetime, TraceEvent } from '../core/types';

export interface RenderTraceOptions {
  selectedNodeId?: string;
  idPrefix?: string;
}

interface Point { x: number; y: number }
interface PlacedEvent { event: TraceEvent; x: number; track: number }
interface LaneLayout { lane: Lane; y: number; height: number; events: PlacedEvent[] }
interface Layout {
  width: number;
  height: number;
  graphHeight: number;
  axisY: number;
  lifeY: number;
  plotLeft: number;
  plotRight: number;
  start: number;
  duration: number;
  nodes: Map<string, Point>;
  lanes: LaneLayout[];
  subscriptionIds: string[];
}

const SVG_STYLE = `
  .rx-root,.rx-scene { color:#203d35; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .rx-paper { fill:#fffefa; }
  .rx-band { fill:#f6f7f2; }
  .rx-rule { stroke:#dfe5da; stroke-width:1; }
  .rx-grid { stroke:#dfe5da; stroke-width:1; stroke-dasharray:3 5; }
  .rx-overline { fill:#61756a; font-size:10px; font-weight:750; letter-spacing:1.7px; }
  .rx-heading { fill:#203d35; font-size:16px; font-weight:700; }
  .rx-small { fill:#65776c; font-size:11px; }
  .rx-mono { font-family:"IBM Plex Mono","SFMono-Regular",Consolas,"Liberation Mono",monospace; }
  .rx-time { fill:#5d7266; font-size:10px; }
  .rx-edge { fill:none; stroke:#96aca0; stroke-width:1.6; }
  .rx-edge-label { fill:#72847a; font-size:10px; }
  .rx-node { cursor:pointer; outline:none; }
  .rx-node-box { fill:#ffffff; stroke:#cbd8cc; stroke-width:1.2; }
  .rx-node-source .rx-node-box { fill:#f0f7f0; }
  .rx-node-sink .rx-node-box { fill:#eaf5f0; }
  .rx-node:hover .rx-node-box,.rx-node:focus .rx-node-box { stroke:#24624e; stroke-width:2.5; }
  .rx-node-selected .rx-node-box { stroke:#235d49; stroke-width:2.5; }
  .rx-node-current .rx-node-box { fill:#fff6e7; stroke:#c27a39; stroke-width:2; }
  .rx-node-label { fill:#173d31; font-size:14px; font-weight:700; }
  .rx-node-kind { fill:#657b6c; font-size:9px; font-weight:750; letter-spacing:1.2px; }
  .rx-node-state { fill:#456654; font-size:10px; }
  .rx-node-id { fill:#789084; font-size:9px; }
  .rx-pill { fill:#eaf0e7; }
  .rx-pill-label { fill:#4d6a59; font-size:9px; font-weight:600; }
  .rx-lane-title { fill:#274638; font-size:13px; font-weight:700; }
  .rx-lane-desc { fill:#738478; font-size:10px; }
  .rx-event { cursor:pointer; outline:none; }
  .rx-event-hit { fill:transparent; }
  .rx-event-focus { fill:#edf3e5; stroke:#d0dfbf; stroke-width:1; opacity:0; }
  .rx-event:hover .rx-event-focus,.rx-event:focus .rx-event-focus { opacity:1; }
  .rx-event-current .rx-event-focus { opacity:1; fill:#fff0d6; stroke:#dcaa6b; }
  .rx-event-label { fill:#244438; font-size:11px; font-weight:600; }
  .rx-event-seq { fill:#6d8072; font-size:9px; }
  .rx-source-ink { fill:#3c805d; stroke:#3c805d; }
  .rx-internal-ink { fill:#cb843e; stroke:#b57531; }
  .rx-result-ink { fill:#197771; stroke:#197771; }
  .rx-error-ink { fill:#ba4b43; stroke:#ba4b43; }
  .rx-modelled { stroke-dasharray:3 2; }
  .rx-stem { stroke:#cbd6cb; stroke-width:1; }
  .rx-cursor { stroke:#bb7634; stroke-width:1.5; stroke-dasharray:5 4; }
  .rx-cursor-pill { fill:#244b39; }
  .rx-cursor-label { fill:#fffef8; font-size:10px; font-weight:650; }
  .rx-life { stroke:#69987c; stroke-width:4; stroke-linecap:round; }
  .rx-life-live { stroke:#69987c; stroke-dasharray:4 5; }
  .rx-life-ended { stroke:#93aa98; }
  .rx-life-cancelled { stroke:#b58149; }
  .rx-life-error { stroke:#ba4b43; }
  .rx-life-label { fill:#355a43; font-size:10px; }
  .rx-life-detail { fill:#6f8274; font-size:9px; }
  .rx-footer { fill:#6e8174; font-size:10px; }
`;

/** All dimensions derive from the full trace; moving the cursor never moves nodes or lanes. */
export function renderTraceSvg(trace: ExecutionTrace, cursor: number, options: RenderTraceOptions = {}): string {
  const layout = makeLayout(trace);
  const replay = replayTrace(trace, cursor);
  const visible = replay.visibleEvents;
  const current = replay.selected;
  const prefix = safeId(options.idPrefix ?? 'rx-trace');
  const titleId = `${prefix}-title`;
  const descriptionId = `${prefix}-description`;
  const title = `${trace.title} — execution at ${current ? `step ${current.seq + 1}, ${formatNumber(current.time)} ${trace.clock.unit}` : 'before subscription'}`;
  const description = 'A fixed pipeline graph and four synchronized lanes: time, source notifications, internal reactions, and resulting notifications. Dashed glyphs identify modelled explanations; solid glyphs identify observed events. Events at one time retain their sequence order. Subscription endings distinguish completion from cancellation.';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="rx-root" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-labelledby="${titleId} ${descriptionId}" data-trace-id="${escapeXml(trace.id)}">
    <title id="${titleId}">${escapeXml(title)}</title>
    <desc id="${descriptionId}">${escapeXml(description)}</desc>
    <defs><style>${SVG_STYLE}</style><marker id="${prefix}-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z" fill="#96aca0"/></marker></defs>
    <g class="rx-scene"><rect class="rx-paper" width="${layout.width}" height="${layout.height}" rx="16"/>
    ${renderGraph(trace, visible, current, layout, options, prefix)}
    ${renderTimeline(trace, visible, current, layout)}
    ${renderLifetimes(trace, replay.lifetimes, current, layout)}
    ${renderFooter(trace, layout)}</g>
  </svg>`;
}

/** XML 1.0 text/attributes cannot contain controls or isolated UTF-16 surrogates. */
function escapeXml(value: unknown): string {
  let clean = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)) clean += character;
  }
  return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function safeId(value: string): string {
  return `rx-${value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 70) || 'trace'}`;
}

function compact(value: string, limit = 28): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}

function preview(value: JsonValue | undefined, limit = 24): string {
  if (value === undefined) return '';
  return compact(typeof value === 'string' ? value : JSON.stringify(value), limit);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function timeX(time: number, layout: Layout): number {
  return Math.round((layout.plotLeft + ((time - layout.start) / layout.duration) * (layout.plotRight - layout.plotLeft)) * 100) / 100;
}

function makeLayout(trace: ExecutionTrace): Layout {
  const width = 1280;
  const columns = Math.min(5, Math.max(1, trace.nodes.length));
  const rows = Math.max(1, Math.ceil(trace.nodes.length / 5));
  const graphHeight = 74 + rows * 126;
  const nodes = new Map<string, Point>();
  const cellWidth = 236;
  const firstX = (width - columns * cellWidth + 22) / 2;
  for (let index = 0; index < trace.nodes.length; index += 1) {
    const node = trace.nodes[index];
    if (node) nodes.set(node.id, { x: firstX + (index % 5) * cellWidth, y: 66 + Math.floor(index / 5) * 126 });
  }
  const times = trace.events.map(eventTime);
  const start = Math.min(0, ...times);
  const end = Math.max(start + 1, ...times);
  const layout: Layout = {
    width, height: 0, graphHeight, axisY: graphHeight + 70, lifeY: 0,
    plotLeft: 228, plotRight: 1125, start, duration: end - start,
    nodes, lanes: [], subscriptionIds: [],
  };
  let nextY = layout.axisY + 29;
  const lanes: Lane[] = ['source', 'internal', 'result'];
  for (const lane of lanes) {
    const occupiedUntil: number[] = [];
    const events: PlacedEvent[] = [];
    for (const event of trace.events) {
      if (event.lane !== lane) continue;
      const x = timeX(event.time, layout);
      let track = occupiedUntil.findIndex(findAvailableTrack);
      function findAvailableTrack(until: number): boolean { return until < x - 10; }
      if (track === -1) track = occupiedUntil.length;
      occupiedUntil[track] = x + 136;
      events.push({ event, x, track });
    }
    const height = Math.max(92, 29 + occupiedUntil.length * 37);
    layout.lanes.push({ lane, y: nextY, height, events });
    nextY += height;
  }
  layout.lifeY = nextY + 35;
  const subscriptionIds = new Set<string>();
  for (const event of trace.events) {
    if (event.kind === 'subscribe') subscriptionIds.add(event.subscriptionId);
  }
  layout.subscriptionIds = Array.from(subscriptionIds);
  layout.height = layout.lifeY + 63 + Math.max(1, layout.subscriptionIds.length) * 36 + 63;
  return layout;
}

function eventTime(event: TraceEvent): number { return Number.isFinite(event.time) ? event.time : 0; }

function renderGraph(trace: ExecutionTrace, visible: TraceEvent[], current: TraceEvent | undefined, layout: Layout, options: RenderTraceOptions, prefix: string): string {
  const latest = new Map<string, TraceEvent>();
  const states = new Map<string, TraceEvent>();
  for (const event of visible) {
    latest.set(event.nodeId, event);
    if (event.kind === 'state' && event.state) states.set(event.nodeId, event);
  }
  let edges = '';
  for (const [index, edge] of trace.edges.entries()) {
    const from = layout.nodes.get(edge.from);
    const to = layout.nodes.get(edge.to);
    if (!from || !to) continue;
    const path = routeEdge(from, to, index, layout.width);
    edges += `<path class="rx-edge" data-edge-id="${escapeXml(edge.id)}" d="${path}" marker-end="url(#${prefix}-arrow)"><title>${escapeXml(`${edge.from} to ${edge.to}${edge.label ? `: ${edge.label}` : ''}`)}</title></path>`;
  }
  let nodeMarkup = '';
  for (const node of trace.nodes) {
    const point = layout.nodes.get(node.id);
    if (point) nodeMarkup += renderNode(node, point, latest.get(node.id), states.get(node.id), current, options);
  }
  return `<text class="rx-overline" x="34" y="29">01 / PIPELINE TOPOLOGY</text>
    <text class="rx-small" x="1246" y="29" text-anchor="end">Fixed connections · inspect a node</text>
    ${edges}${nodeMarkup}
    <line class="rx-rule" x1="34" x2="1246" y1="${layout.graphHeight}" y2="${layout.graphHeight}"/>`;
}

/** Orthogonal routes use row gaps or the outside gutter, never intervening node boxes. */
function routeEdge(from: Point, to: Point, index: number, width: number): string {
  const nodeWidth = 214;
  const nodeHeight = 86;
  const centerFrom = from.x + nodeWidth / 2;
  const centerTo = to.x + nodeWidth / 2;
  const gapOffset = 14 + (index % 3) * 8;
  const sourceBottom = from.y + nodeHeight;
  const targetBottom = to.y + nodeHeight;

  if (from.x === to.x && from.y === to.y) {
    return `M ${from.x + nodeWidth} ${from.y + nodeHeight / 2} H ${from.x + nodeWidth + 10} V ${sourceBottom + gapOffset} H ${from.x + nodeWidth - 35} V ${targetBottom + 6}`;
  }
  if (from.y === to.y && to.x - from.x === 236) {
    return `M ${from.x + nodeWidth} ${from.y + nodeHeight / 2} H ${to.x - 7}`;
  }
  if (from.y === to.y) {
    return `M ${centerFrom} ${sourceBottom} V ${sourceBottom + gapOffset} H ${centerTo} V ${targetBottom + 6}`;
  }
  if (to.y - from.y === 126) {
    return `M ${centerFrom} ${sourceBottom} V ${sourceBottom + gapOffset} H ${centerTo} V ${to.y - 6}`;
  }
  const outsideX = width - 28;
  if (to.y > from.y) {
    return `M ${centerFrom} ${sourceBottom} V ${sourceBottom + gapOffset} H ${outsideX} V ${to.y - 14} H ${centerTo} V ${to.y - 6}`;
  }
  return `M ${centerFrom} ${from.y} V ${from.y - 14} H ${outsideX} V ${targetBottom + gapOffset} H ${centerTo} V ${targetBottom + 6}`;
}

function renderNode(node: PipelineNode, point: Point, latest: TraceEvent | undefined, state: TraceEvent | undefined, current: TraceEvent | undefined, options: RenderTraceOptions): string {
  const classes = ['rx-node', `rx-node-${node.kind}`];
  if (node.id === options.selectedNodeId) classes.push('rx-node-selected');
  if (node.id === current?.nodeId) classes.push('rx-node-current');
  const status = latest ? `${latest.kind}${latest.kind === 'unsubscribe' ? ` · ${latest.reason ?? 'cancelled'}` : ''}` : 'not reached';
  const stateLabel = state?.state ? statePreview(state.state) : latest?.value !== undefined ? `value ${preview(latest.value, 24)}` : node.kind === 'source' ? 'Values enter here' : node.kind === 'sink' ? 'Subscriber receives' : 'Reacts to notifications';
  return `<g class="${classes.join(' ')}" transform="translate(${point.x} ${point.y})" data-node-id="${escapeXml(node.id)}" role="button" tabindex="0" aria-label="${escapeXml(`Inspect ${node.label}. ${node.description}. ${status}. ${stateLabel}`)}">
    <title>${escapeXml(`${node.label}: ${node.description}`)}</title>
    <rect class="rx-node-box" width="214" height="86" rx="12"/>
    <text class="rx-node-kind" x="15" y="19">${escapeXml(node.kind.toUpperCase())}</text>
    <text class="rx-node-id rx-mono" x="199" y="19" text-anchor="end">${escapeXml(compact(node.id, 16))}</text>
    <text class="rx-node-label rx-mono" x="15" y="41">${escapeXml(compact(node.label, 23))}</text>
    <text class="rx-node-state rx-mono" x="15" y="60">${escapeXml(compact(stateLabel, 30))}</text>
    <circle cx="17" cy="75" r="2.5" fill="${latest ? '#648b66' : '#b7c3b5'}"/>
    <text class="rx-pill-label" x="25" y="78">${escapeXml(compact(status, 24))}</text>
    ${state?.provenance === 'modelled' ? '<text class="rx-node-id" x="199" y="78" text-anchor="end">modelled</text>' : ''}
  </g>`;
}

function statePreview(state: { [key: string]: JsonValue }): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(state).slice(0, 2)) parts.push(`${key}=${preview(value, 14)}`);
  return parts.join(' · ') || 'state {}';
}

function renderTimeline(trace: ExecutionTrace, visible: TraceEvent[], current: TraceEvent | undefined, layout: Layout): string {
  const visibleSeqs = new Set<number>();
  for (const event of visible) visibleSeqs.add(event.seq);
  const nowX = current ? timeX(current.time, layout) : layout.plotLeft;
  const endY = layout.lanes.at(-1);
  const bottom = endY ? endY.y + endY.height : layout.axisY;
  let output = `<text class="rx-overline" x="34" y="${layout.graphHeight + 30}">02 / EXECUTION OVER TIME</text>
    <text class="rx-small" x="1246" y="${layout.graphHeight + 30}" text-anchor="end">Solid = observed · dashed = modelled · # = step order</text>
    <text class="rx-lane-title" x="35" y="${layout.axisY + 4}">Timeline</text>
    <text class="rx-lane-desc" x="35" y="${layout.axisY + 21}">${escapeXml(trace.clock.virtual ? 'Virtual clock' : 'Captured clock')} · ${escapeXml(trace.clock.unit)}</text>
    <line class="rx-rule" x1="${layout.plotLeft}" x2="${layout.plotRight}" y1="${layout.axisY}" y2="${layout.axisY}"/>`;
  for (let tick = 0; tick <= 6; tick += 1) {
    const time = layout.start + (layout.duration * tick) / 6;
    const x = timeX(time, layout);
    output += `<line class="rx-rule" x1="${x}" x2="${x}" y1="${layout.axisY - 4}" y2="${layout.axisY + 5}"/><text class="rx-time rx-mono" x="${x}" y="${layout.axisY - 11}" text-anchor="middle">${formatNumber(time)}</text>`;
  }
  for (const lane of layout.lanes) {
    output += renderLane(lane, visibleSeqs, current, layout);
  }
  if (current) {
    const cursorLabel = `${formatNumber(current.time)} ${trace.clock.unit} · #${current.seq + 1}`;
    const pillX = Math.max(layout.plotLeft - 6, Math.min(layout.width - 144, nowX - 56));
    output += `<line class="rx-cursor" x1="${nowX}" x2="${nowX}" y1="${layout.axisY + 2}" y2="${bottom}" pointer-events="none"/>
      <rect class="rx-cursor-pill" x="${pillX}" y="${layout.axisY + 7}" width="124" height="21" rx="5"/>
      <text class="rx-cursor-label rx-mono" x="${pillX + 62}" y="${layout.axisY + 21}" text-anchor="middle">${escapeXml(cursorLabel)}</text>`;
  } else {
    output += `<text class="rx-small" x="${layout.plotLeft}" y="${layout.axisY + 23}">Ready · subscription has not started</text>`;
  }
  return output;
}

function renderLane(lane: LaneLayout, visibleSeqs: Set<number>, current: TraceEvent | undefined, layout: Layout): string {
  const titles: Record<Lane, string> = { source: 'Source emissions', internal: 'Internal reactions', result: 'Resulting emissions' };
  const descriptions: Record<Lane, string> = { source: 'What arrives', internal: 'How the operator reacts', result: 'What the subscriber receives' };
  let output = `${lane.lane === 'internal' ? `<rect class="rx-band" x="20" y="${lane.y}" width="1240" height="${lane.height}" rx="8"/>` : ''}
    <line class="rx-rule" x1="34" x2="1246" y1="${lane.y}" y2="${lane.y}"/>
    <text class="rx-lane-title" x="35" y="${lane.y + 28}">${titles[lane.lane]}</text>
    <text class="rx-lane-desc" x="35" y="${lane.y + 45}">${descriptions[lane.lane]}</text>`;
  for (let tick = 0; tick <= 6; tick += 1) {
    const x = timeX(layout.start + (layout.duration * tick) / 6, layout);
    output += `<line class="rx-grid" x1="${x}" x2="${x}" y1="${lane.y + 5}" y2="${lane.y + lane.height - 5}"/>`;
  }
  let shown = 0;
  for (const placed of lane.events) {
    if (!visibleSeqs.has(placed.event.seq)) continue;
    const y = lane.y + 26 + placed.track * 37;
    output += renderEvent(placed.event, placed.x, y, current?.seq === placed.event.seq);
    shown += 1;
  }
  if (!shown) output += `<text class="rx-lane-desc" x="${layout.plotLeft + 15}" y="${lane.y + 31}">No events yet</text>`;
  return output;
}

function renderEvent(event: TraceEvent, x: number, y: number, selected: boolean): string {
  const primary = event.kind === 'next' && event.value !== undefined ? preview(event.value, 20) : compact(event.label || event.kind, 20);
  const detail = compact(`#${event.seq + 1} · ${event.provenance === 'modelled' ? 'model · ' : ''}${compact(event.nodeId, 14)}`, 24);
  const accessible = `Step ${event.seq + 1} at ${formatNumber(event.time)}. ${event.nodeId}: ${event.label}. ${event.kind}. ${event.provenance}${event.value !== undefined ? `. Value ${preview(event.value, 120)}` : ''}`;
  return `<g class="rx-event${selected ? ' rx-event-current' : ''}" transform="translate(${x} ${y})" data-event-seq="${event.seq}" role="button" tabindex="0" aria-label="${escapeXml(accessible)}">
    <title>${escapeXml(accessible)}</title>
    <rect class="rx-event-hit" x="-12" y="-14" width="150" height="34" rx="6"/>
    <rect class="rx-event-focus" x="-12" y="-14" width="150" height="34" rx="6"/>
    ${renderGlyph(event)}
    <text class="rx-event-label rx-mono" x="14" y="0">${escapeXml(primary)}</text>
    <text class="rx-event-seq rx-mono" x="14" y="13">${escapeXml(detail)}</text>
  </g>`;
}

function renderGlyph(event: TraceEvent): string {
  const ink = event.kind === 'error' ? 'rx-error-ink' : `rx-${event.lane}-ink`;
  const model = event.provenance === 'modelled' ? ' rx-modelled' : '';
  if (event.kind === 'complete') return `<circle class="${ink}${model}" cx="0" cy="-3" r="7" fill-opacity="0.08" stroke-width="1.5"/><path class="${ink}" d="M -3 -3 L -1 -1 L 4 -6" fill="none" stroke-width="1.5"/>`;
  if (event.kind === 'unsubscribe') return `<circle class="${ink}${model}" cx="0" cy="-3" r="7" fill-opacity="0.05" stroke-width="1"/><path class="${ink}" d="M -3 -6 L 3 0 M 3 -6 L -3 0" fill="none" stroke-width="1.5"/>`;
  if (event.kind === 'subscribe') return `<circle class="${ink}${model}" cx="0" cy="-3" r="7" fill-opacity="0.08" stroke-width="1.5"/><path class="${ink}" d="M -3 -3 H 3 M 0 -6 V 0" fill="none" stroke-width="1.5"/>`;
  if (event.kind === 'state') return `<path class="${ink}${model}" d="M 0 -11 L 8 -3 L 0 5 L -8 -3 Z" fill-opacity="0.12" stroke-width="1.5"/>`;
  if (event.kind === 'error') return `<path class="${ink}${model}" d="M 0 -11 L 8 4 H -8 Z" fill-opacity="0.12" stroke-width="1.5"/><text x="0" y="1" text-anchor="middle" fill="#ba4b43" font-size="10" font-weight="800">!</text>`;
  return `<circle class="${ink}${model}" cx="0" cy="-3" r="6" fill-opacity="${event.provenance === 'modelled' ? '0.16' : '1'}" stroke-width="1.5"/>`;
}

function renderLifetimes(trace: ExecutionTrace, subscriptions: SubscriptionLifetime[], current: TraceEvent | undefined, layout: Layout): string {
  const lifetimes = new Map<string, SubscriptionLifetime>();
  for (const lifetime of subscriptions) lifetimes.set(lifetime.id, lifetime);
  let output = `<line class="rx-rule" x1="34" x2="1246" y1="${layout.lifeY - 13}" y2="${layout.lifeY - 13}"/>
    <text class="rx-overline" x="34" y="${layout.lifeY + 10}">03 / SUBSCRIPTION LIFETIMES</text>
    <text class="rx-small" x="1246" y="${layout.lifeY + 10}" text-anchor="end">+ start · ✓ complete · × cancelled · ! error · dashed = active</text>`;
  if (subscriptions.length === 0) output += `<text class="rx-small" x="35" y="${layout.lifeY + 49}">Lifetimes appear as subscriptions begin.</text>`;
  for (let index = 0; index < layout.subscriptionIds.length; index += 1) {
    const id = layout.subscriptionIds[index];
    const lifetime = id ? lifetimes.get(id) : undefined;
    if (!lifetime) continue;
    const y = layout.lifeY + 45 + index * 36;
    const startX = timeX(lifetime.start, layout);
    const endX = timeX(lifetime.end ?? current?.time ?? lifetime.start, layout);
    const status = lifetime.end === undefined ? 'active' : lifetime.reason ?? 'unsubscribed';
    const node = trace.nodes.find(findLifetimeNode);
    function findLifetimeNode(candidate: PipelineNode): boolean { return candidate.id === lifetime?.nodeId; }
    const label = `${lifetime.parentId ? '↳ ' : ''}${lifetime.id}`;
    const endDetail = lifetime.endSeq !== undefined ? `#${lifetime.startSeq + 1} → #${lifetime.endSeq + 1}` : `since #${lifetime.startSeq + 1}`;
    output += `<g data-subscription-id="${escapeXml(lifetime.id)}" data-lifetime-status="${escapeXml(status)}" aria-label="${escapeXml(`${lifetime.id}, ${node?.label ?? lifetime.nodeId}, ${status}, ${endDetail}`)}">
      <title>${escapeXml(`${lifetime.id}${lifetime.parentId ? `; parent ${lifetime.parentId}` : ''}; ${status}; ${endDetail}`)}</title>
      <text class="rx-life-label rx-mono" x="35" y="${y - 1}">${escapeXml(compact(label, 29))}</text>
      <text class="rx-life-detail rx-mono" x="35" y="${y + 12}">${escapeXml(compact(`${node?.label ?? lifetime.nodeId} · ${endDetail}`, 31))}</text>
      <line class="rx-rule" x1="${layout.plotLeft}" x2="${layout.plotRight}" y1="${y - 3}" y2="${y - 3}"/>
      <line class="rx-life ${lifetime.end === undefined ? 'rx-life-live' : lifetime.reason === 'cancelled' ? 'rx-life-cancelled' : lifetime.reason === 'error' ? 'rx-life-error' : 'rx-life-ended'}" x1="${startX}" x2="${Math.max(startX + 2, endX)}" y1="${y - 3}" y2="${y - 3}"/>
      <circle cx="${startX}" cy="${y - 3}" r="3" fill="#fffefa" stroke="#69987c" stroke-width="1.4"/>
      ${renderLifetimeEnd(lifetime, endX, y - 3)}
      <text class="rx-life-detail rx-mono" x="${Math.min(1215, Math.max(startX, endX) + 13)}" y="${y + 1}">${escapeXml(status)}</text>
    </g>`;
  }
  return output;
}

function renderLifetimeEnd(lifetime: SubscriptionLifetime, x: number, y: number): string {
  if (lifetime.end === undefined) return `<circle cx="${x}" cy="${y}" r="4" fill="#69987c"/>`;
  if (lifetime.reason === 'cancelled') return `<path d="M ${x - 4} ${y - 5} L ${x + 4} ${y + 3} M ${x + 4} ${y - 5} L ${x - 4} ${y + 3}" fill="none" stroke="#aa713a" stroke-width="2"/>`;
  if (lifetime.reason === 'error') return `<path d="M ${x} ${y - 7} L ${x + 6} ${y + 4} H ${x - 6} Z" fill="#ba4b43"/>`;
  if (lifetime.reason === undefined) return `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="#fffefa" stroke="#608770" stroke-width="1.5"/>`;
  return `<circle cx="${x}" cy="${y}" r="6" fill="#fffefa" stroke="#608770" stroke-width="1.5"/><path d="M ${x - 3} ${y} L ${x - 1} ${y + 2} L ${x + 3} ${y - 3}" fill="none" stroke="#608770" stroke-width="1.5"/>`;
}

function renderFooter(trace: ExecutionTrace, layout: Layout): string {
  const y = layout.height - 27;
  return `<line class="rx-rule" x1="34" x2="1246" y1="${y - 20}" y2="${y - 20}"/>
    <text class="rx-footer" x="35" y="${y}">Every marker is one event. Same-time markers are stacked; # preserves their exact order.</text>
    <text class="rx-footer rx-mono" x="1245" y="${y}" text-anchor="end">${escapeXml(trace.truncated ? 'BOUNDED CAPTURE · trace truncated' : `${trace.clock.scheduler} · ${trace.clock.unit}`)}</text>`;
}
