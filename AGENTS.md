# Working on RxJS execution viewer

- Keep RxJS pinned to 7.8.2 unless a version change is explicitly requested.
- Use TypeScript, named functions, and plain data. Do not introduce application classes.
- Keep replay and SVG generation pure. Confine subscriptions, clocks, DOM updates, and file operations to explicit boundaries.
- Write down an operator's Mealy model (S, S0, Z, A, T, G) before adding semantic state events.
- Preserve the distinction between observed boundary data and modelled state. Do not label inferred state as inspected internals.
- Use explicit schedulers and subscription identities. Preserve same-time event order and cancellation versus terminal notifications.
- Do not re-execute an observable during replay, scrubbing, or export.
- Escape and bound payload previews. Imported traces are data, never executable code or arbitrary SVG.
- Preserve the four visual lanes: Timeline, Source, Internal reactions, Result.
- Add meaningful tests for behavior, teardown, or interchange changes. Run `npm run check` before proposing a commit.
- Keep documentation accurate about implemented features and limits.
- Preserve the requested README credit and the initial co-authorship attribution.
