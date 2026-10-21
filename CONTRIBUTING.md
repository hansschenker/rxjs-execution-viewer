# Contributing

Start with `npm ci`, then `npm run dev`. Run `npm run check` before submitting a change. The project uses exact dependency versions and commits its lockfile.

## Add a useful execution

1. State the question the example should answer: what value is forwarded, what is cancelled, who owns a subscription, or when completion occurs.
2. Describe the pipeline nodes and connections separately from runtime subscriptions.
3. Write the operator model: S, S₀, Z, A, T, and G. Use plain language before implementing the trace.
4. Run the real RxJS 7.8.2 operators with an explicit scheduler and finite source.
5. Observe the relevant boundaries without creating extra subscriptions. Record semantic explanations as `modelled`.
6. Verify the material behavior: values, ordering, inner cancellation, completion/error, and teardown. Include reentrancy or sharing when relevant.
7. Register the scenario and update the README only after it works.

Replay and rendering must not execute the pipeline. Imported traces must pass the same validation as bundled traces. Avoid adding a broad test merely to mirror implementation; tests should catch a meaningful behavioral or interoperability failure.

## Design principles

Prefer named functions and immutable data projections. The recorder and browser integration are intentionally effectful; keep those effects explicit. Use no custom application classes.

Keep nodes in stable positions across replay. Do not silently drop repeated values or simultaneous events. Use the event ledger when a spatial view becomes dense. A static declaration, one execution, and a complete state space are different things and should remain labelled accordingly.

## Attribution

Preserve the project credit in the README. If a contribution is made with GPT-6 Astra, use the commit trailer:

```text
Co-authored-by: GPT-6 Astra <noreply@openai.com>
```

Credit upstream code under its actual license when copying it. Acknowledging an idea does not replace license compliance for copied code.
