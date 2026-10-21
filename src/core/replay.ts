import type { ExecutionTrace, ReplayState, SubscriptionLifetime } from './types';

/** Pure reconstruction from captured JSON. Scrubbing never runs the source again. */
export function replayTrace(trace: ExecutionTrace, cursor: number): ReplayState {
  const last = trace.events.length - 1;
  const position = Number.isFinite(cursor) ? Math.min(last, Math.max(-1, Math.floor(cursor))) : -1;
  const visibleEvents = trace.events.slice(0, position + 1);
  const latestByNode: ReplayState['latestByNode'] = Object.create(null) as ReplayState['latestByNode'];
  const modelByNode: ReplayState['modelByNode'] = Object.create(null) as ReplayState['modelByNode'];
  const lifetimes = new Map<string, SubscriptionLifetime>();

  for (const event of visibleEvents) {
    latestByNode[event.nodeId] = event;
    if (event.kind === 'state' && event.state) modelByNode[event.nodeId] = event.state;
    if (event.kind === 'subscribe') {
      lifetimes.set(event.subscriptionId, {
        id: event.subscriptionId,
        nodeId: event.nodeId,
        ...(event.parentSubscriptionId ? { parentId: event.parentSubscriptionId } : {}),
        label: event.label,
        start: event.time,
        startSeq: event.seq,
      });
    } else if (event.kind === 'unsubscribe') {
      const lifetime = lifetimes.get(event.subscriptionId);
      if (lifetime) {
        lifetime.end = event.time;
        lifetime.endSeq = event.seq;
        if (event.reason) lifetime.reason = event.reason;
      }
    }
  }

  const selected = trace.events[position];
  return {
    cursor: position,
    ...(selected ? { selected } : {}),
    visibleEvents,
    latestByNode,
    modelByNode,
    lifetimes: [...lifetimes.values()],
  };
}
