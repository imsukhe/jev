# Contributing

1. Keep host-neutral policy in `skills/`.
2. Put provider or host details in `adapters/`.
3. Add fixture-based tests before adding transcript collectors or hooks.
4. Do not add telemetry that sends data by default.
5. Run `npm test`, `npm run lint`, and `npm run validate` before opening a pull request.

When proposing a cost-control rule, state the measurable source of waste, the expected savings mechanism, quality risk, and rollback path.
