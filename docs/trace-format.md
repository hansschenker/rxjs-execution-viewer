# Trace format v1

The TypeScript contract is [src/core/types.ts](../src/core/types.ts). Runtime validation is in [src/core/serialization.ts](../src/core/serialization.ts). JSON import is a data operation; it never evaluates the `pipeline` description or accepts arbitrary SVG.

## Envelope

| Field | Meaning |
| --- | --- |
| `version` | Exactly `1` |
| `id` | Stable trace identifier |
| `title`, `description` | Human-readable context |
| `pipeline` | Display-only source description |
| `clock` | `unit` (`ms` or `frame`), scheduler description, and whether the clock is virtual |
| `nodes` | Declared source, operator, and sink nodes; an operator may include a Mealy model |
| `edges` | Declared connections with unique IDs and known endpoints |
| `events` | Ordered events; `seq` is exactly the array index |
| `truncated` | Whether capture stopped logging because its event-count or event-data byte budget was reached |

An empty event array is valid; an empty node array is not. Topology is metadata, not a deduction from notifications. Cycles in declared topology are allowed; causal event references must always point backward.

## Events

Every event has these fields:

| Field | Meaning |
| --- | --- |
| `seq` | Zero-based consecutive total order; the UI presents it as a one-based step |
| `time` | Finite, nonnegative, nondecreasing time in the trace clock's unit |
| `nodeId` | Known pipeline declaration node |
| `subscriptionId` | Unique runtime subscription identity |
| `kind` | `subscribe`, `next`, `complete`, `error`, `unsubscribe`, or `state` |
| `lane` | `source`, `internal`, or `result`; the fourth visual lane is the clock axis |
| `provenance` | `observed` or `modelled` |
| `label` | A short explanation |

Optional fields are `parentSubscriptionId`, `value`, `state`, `cause`, and `reason`.

Every subscription ID first appears in a `subscribe` event. Its node and parent must stay unchanged. A parent must already exist and differ from its child. `cause`, when present, points to a lower sequence number. `reason`, when present, belongs to an `unsubscribe` event and is `complete`, `error`, or `cancelled`.

Do not equate parent ownership with the direction of a pipeline edge. Subscribing travels upstream; notifications travel downstream. Higher-order operators and sharing make runtime ownership a separate concern from declaration topology.

### Minimal valid trace

```json
{
  "version": 1,
  "id": "example",
  "title": "One value",
  "description": "A finite observed boundary.",
  "pipeline": "of(7)",
  "clock": { "unit": "frame", "scheduler": "Synchronous", "virtual": true },
  "nodes": [
    { "id": "source", "label": "of(7)", "kind": "source", "description": "One value then completion." }
  ],
  "edges": [],
  "events": [
    { "seq": 0, "time": 0, "nodeId": "source", "subscriptionId": "s1", "kind": "subscribe", "lane": "source", "provenance": "observed", "label": "Source" },
    { "seq": 1, "time": 0, "nodeId": "source", "subscriptionId": "s1", "kind": "next", "lane": "source", "provenance": "observed", "label": "Source", "value": 7 },
    { "seq": 2, "time": 0, "nodeId": "source", "subscriptionId": "s1", "kind": "complete", "lane": "source", "provenance": "observed", "label": "Source" },
    { "seq": 3, "time": 0, "nodeId": "source", "subscriptionId": "s1", "kind": "unsubscribe", "lane": "source", "provenance": "observed", "label": "Source", "reason": "complete" }
  ],
  "truncated": false
}
```

## Limits

Version 0.1 deliberately targets finite, inspectable traces:

| Resource | Bound |
| --- | --- |
| JSON input / output | 5 MiB UTF-8 |
| Events | 2,000 |
| Nodes / edges | 100 / 500 |
| General string length | 20,000 characters; several label and ID fields have smaller bounds |
| Identifier length | 128 characters; letters, digits, `.`, `_`, `:`, `/`, `-` |
| JSON nesting | 32 levels |
| Nested JSON values | 100,000 |
| Portable SVG events | 200, plus the before-execution frame |
| Portable SVG output | 8 MiB |

The recorder defaults to at most **2,000 events** and **4 MiB (4,194,304 bytes) of event data**. It measures each event as compact UTF-8 JSON; envelope metadata is separate. Set `maxEvents` or `maxBytes` to use a smaller capture budget. The 4 MiB event budget leaves room for ordinary metadata within the separate 5 MiB whole-file import/export limit; final serialization still validates that whole-file limit.

Reaching either capture budget stops logging, **not the source execution**. The exported trace sets `truncated: true`, and no further events are appended. Lifetimes still open at the end of a partial trace are not evidence that the underlying subscriptions never ended.

Imported objects must be plain JSON data. Functions, accessors, symbol properties, sparse arrays, cycles, nonfinite numbers, unsupported object prototypes, and dangerous object keys are rejected. Unknown version-1 schema fields are rejected as well.

Values are previews. They may contain explicit markers for cycles, unsupported types, or omitted detail. A missing payload and a payload of `null` are different. JSON data is escaped before becoming SVG or HTML text.

## Recording your own execution

The recorder is an internal project API, not yet a separately published npm package. Import `createRecorder` from `src/core/recorder.ts`, supply declared node metadata, a clock, and `now`, then place `recorder.observe(...)` at selected pipeline boundaries. Call `recorder.snapshot()` after the finite execution, and pass it through `serializeTrace` before writing it to a file.

Use an explicit scheduler for operators that depend on time. Subscribe once through the actual pipeline. Do not add another subscription merely to obtain visualization events: doing so can duplicate work or change sharing behavior.

State explanations belong in `recorder.state(...)`, attached to an already observed subscription. The `onEvent` observation hook provides that subscription identity. See the [bundled scenarios](../src/scenarios/) for complete working examples, including higher-order and shared lifetimes.
