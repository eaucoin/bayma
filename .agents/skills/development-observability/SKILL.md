---
name: development-observability
description: Where this repository's development telemetry is configured, the OpenTelemetry settings every `bun run` script loads; for sending or finding the traces, metrics, and logs of bayma's own development, and for keeping its development tooling instrumented as you change it.
metadata:
  # For working on bayma: `npx skills add` leaves it out.
  internal: true
---

# Development Observability

bayma's development, its `bun run` scripts and what they run, sends OpenTelemetry traces, metrics, and logs where these files say:

- `otel.env.example`: the settings, each empty, and what each does
- `otel.env`: this checkout's own, which every `bun run` script loads, and git ignores

When you change bayma's development tooling, wire OpenTelemetry into what you add as the tooling already does.
