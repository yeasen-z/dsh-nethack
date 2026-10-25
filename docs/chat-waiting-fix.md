# Chat waiting indefinitely: verified defects and limits

User symptom: sending a message leaves the NetHack panel waiting indefinitely.

## Reproduced defects

1. NetHackChat mount effect only set `alive=false` in cleanup. Effect setup/cleanup/setup replay left it false, so a completed NDJSON reply could not clear busy. The actual component test passed without replay and failed with replay before the fix. Setup now restores alive, and cleanup cancels the active request.
2. The LLM service contract represents adapter errors and cancellation as `finish.reason.kind = error | aborted` with `failure`. The chat loop ignored these and returned empty success. Tests reproduced missing rejection. Such frames now enter the route's error-event path, including code/status/message. Missing finish and empty result also report errors.
3. First game-id adoption reset an in-flight conversation; stale request completion could unlock a newer request. A request identity now gates updates; initial identity adoption preserves the exchange, while real game changes invalidate/cancel old work.

## Escape from pending network calls

The send button becomes Stop while busy. An AbortController cancels fetch on Stop, unmount, or game change. A 120-second no-data deadline aborts a silent request; incoming stream data resets it. A timeout/cancellation is shown rather than leaving the composer disabled. Actions already taken in the game are not undone.

The Host response stream now implements cancel to abort the model signal. Its start callback does not return the long-running generation promise, so cancellation can execute while generation is pending.

## Verification

Workspace test results:
- chat-lifecycle: 5 passed (actual component, minimal hook runner; replay, Stop, adoption, stale request isolation).
- chat-failures: 7 passed (actual runChatTurn with contract-shaped chunks).
- chat-route: 2 passed (actual apply/route, fake model; error event and cancellation signal).
- panel-visibility: 8 passed.
- Syntax checks passed for all three modified source modules.

Existing scratch client suite run: 15 suites passed; `deadlock.mjs` has one obsolete source-regex assertion requiring `setBusy(false)` before a stale-game guard. The new request-identity guard intentionally runs before clearing busy, to avoid unlocking a newer request. Its new behavioral replacement is chat-lifecycle's stale-A/active-B test. Do not count the scratch run as wholly green.

These tests do NOT establish that React effect replay occurred in the user's live tree or that the real configured provider is healthy. They establish reproducible defects and fixes. No real provider request or refreshed Desktop rendering was verified in this turn. Refresh/reload is still required to load the changed Host and Client halves.
