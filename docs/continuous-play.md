# Continuous play and direction prompt fix

The chat loop no longer has a 16-round execution limit. It stops when the model finishes, when the user aborts, on model/transport failure, or after two consecutive rounds of tool exceptions. The 120-second client inactivity timeout remains (not a total runtime limit). Progress events are emitted before model/tool calls and after tool results, including recent action records. Stop preserves received text and steps, but cannot undo game actions already performed.

Long runs retain the original question/text history and the latest eight complete tool rounds; assistant tool calls and their results are evicted together. The last 40 action records and 24,000 characters of generated text are retained. This is a rolling context window, not semantic summarization: very old details may be forgotten.

Direction reproduction used a separate WASM engine, never the user's live game. With number_pad enabled, sending `h` at `In what direction?` reproduces `cmdassist: Invalid direction key!` and the `7 8 9` help display. Sending `north` leaks trailing characters into other commands. Numeric mappings were already correct; prompt classification and reply validation were missing.

The worker now distinguishes direction prompts from yes/no prompts. `respond` accepts one numpad direction (12346789), vertical/self (< > . s), or Escape, rejecting words/vi keys before queueing. The Host tool also guards legacy live engines still reporting the question as `yn`, so the existing game need not be restarted. Raw keystrokes remain a literal escape hatch and can still produce engine errors.

Tests cover 75 rounds with complete bounded history, manual cancellation, natural completion, exception protection, and actual-engine direction behavior. Other chat/model/panel regressions pass. Real-provider continuous play and browser Stop delivery still require user verification. Plugin reload preserves the existing engine; updated worker classification applies to newly created engines, with Host validation covering the retained game.
