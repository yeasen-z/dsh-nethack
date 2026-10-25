# Right-sidebar startup polling regression

## Corrected diagnosis

The earlier claim that `--More--` explains the persistent “Starting NetHack” notice was not established. The actual client renders that notice only while `state` is null and no request error has been recorded. A received observation with `waiting_for: "more"` instead enters the loaded-state branch.

The shared panel still gated its polling on `usePanelInfo().activePanelId === "nethack"`. The right-sidebar slot also supplies `usePanelInfo`, but this describes the centre panel. When the centre shows a conversation, that check is false even while the game tab is visible. Every scheduled request is skipped, leaving `state` null indefinitely.

## Change

- Prefer the right-sidebar hook `useTabInfo().tab.visible` when supplied.
- Preserve the centre-panel visibility check only for the main-slot fallback.
- Restart polling immediately when tab visibility changes.
- Do not fetch for a hidden game tab merely because the browser returns to the foreground.
- No engine reset, saved-game deletion, or Host modification in this fix.

## Verification

`plugins/dsh-nethack/tests/panel-visibility.mjs` executes the actual component and its effects with deterministic HTTP/timer doubles and both slot hooks. The old source fails the first assertion: zero requests instead of one for a visible right tab beside a conversation.

After the change, all eight scenarios pass: visible right tab fetches and renders a map, hidden tab skips, revealing tab fetches immediately, browser foreground does not wake a hidden tab, main fallback works, unselected main skips, hidden browser skips, and HTTP errors replace the startup notice.

Existing client suites: 250 assertions pass; all 16 processes exit zero. Together with the new suite: 258 passing assertions.

This verifies the polling defect and source fix, not the refreshed Desktop rendering. The existing page must load the updated Client half before the visible result can be confirmed. No automatic HMR watcher was verified.
