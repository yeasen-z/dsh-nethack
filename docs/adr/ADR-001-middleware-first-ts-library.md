# ADR-001: Middleware-first TypeScript library (not a network service yet)

Date: 2026-09-30 · Status: Accepted (per handoff §1)

Context: We want a reusable interaction contract for humans + LLM agents over
NetHack WASM, with the web client as first consumer.
Decision: Implement the middleware as a TS library running alongside the
browser app (game in a Web Worker); publish model-independent, UI-independent
interfaces (`NetHackSession`, `GameAdapter`). One serialized write path.
Consequences: Zero-latency local validation; evaluation runner reuses the same
package; backend only proxies provider credentials (see apps/model-gateway).
A future network-service split is possible because boundaries are already
message-shaped (async interfaces).
