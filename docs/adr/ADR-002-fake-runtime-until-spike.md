# ADR-002: Labelled fake runtime for contract development before the spike

Date: 2026-09-30 · Status: Accepted, EXPIRES when milestone 1 lands

Context: The real NH5.0 WASM build is not pinned/built in this repo yet, but
milestones 2–3 (contracts, execution core) can proceed and be tested now.
Decision: Ship `FakeWasmAdapter` implementing the exact `GameAdapter`
interface, deterministically modeling rooms/doors/prompts/menus/monsters.
It is labeled `runtime_id: "fake-nh@0.1"` everywhere, refuses to masquerade,
and acceptance cases requiring a real session SKIP explicitly rather than
passing falsely.
Consequences: Interruption/epoch/dedup semantics are provable today; swapping
in the real bridge later touches only `packages/adapter-wasm`. The MVP demo
gate ("no mocked game in the delivered demo") remains unmet until the spike.
Alternative considered: waiting on the WASM build — rejected because the
execution/interruption contract is the risky part and should be verified first
(handoff §14 order keeps skills/agent after core anyway).
