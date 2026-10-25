# NetHack chat model selection

The right-sidebar chat now subscribes to the same `modelDirectories.directoryFor(sessionId)` store as DSH's composer. The source contract was read from the installed `dsh-client-ui-model-selection` client (directoryFor, load, store current/groups/failures). This service is not catalogued by Inspect; its implementation is the evidence, not a guessed service name.

## Behavior

- Starts in **Follow main chat** mode. Every send reads the current session directory snapshot, including reasoning effort when present.
- Selecting another model overrides only NetHack chat. The plugin never calls the directory's `select`, session `selectModel`, or default-model save methods.
- Select Follow again to return to the current main conversation's model.
- Local override lasts for the mounted chat and resets on switching DSH sessions. It is not persisted globally.
- Candidates come from the native directory groups, not a separate hard-coded model list. Provider/catalog errors are shown; a missing model blocks send instead of silently choosing a different model.
- The actual provider/model is displayed below the selector.

## Host validation

New clients send an explicit `selection`. The chat route validates provider, model and optional reasoning effort against `sessionController.modelCatalog()`, the same Host catalog DSH uses. Invalid selections return 400, unavailable catalogs/providers return 503. Only old clients that omit selection retain the global-default fallback.

## Verification limits

Tests execute actual client handlers/Host routes with deterministic directory and LLM doubles. They do not prove that the connected Desktop page loaded the new Client half, or that a real provider request succeeds. Look for the Model selector and the Stop button after reloading to distinguish the updated UI from the old one. No real model request or game reset is needed for these tests.
