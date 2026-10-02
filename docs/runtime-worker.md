# Worker runtime probe

Phase 2 of the real-runtime plan adds a browser Worker boundary around the
pinned NetHack WebAssembly build. The probe page is `apps/web/public/runtime-probe.html`;
the Worker implementation is `apps/web/public/runtime-probe.worker.js`.

## Run it

Build the pinned runtime first, then serve `apps/web/public` over HTTP (Workers
and WebAssembly are not reliably available from `file://` URLs):

```sh
npm run runtime:build
python3 -m http.server 4173 --bind 127.0.0.1 --directory apps/web/public
```

Open `http://127.0.0.1:4173/runtime-probe.html`, select **Start game**, press
Space at the opening `--More--` page, and answer `n` to the tutorial question.
The probe should then stop at **NetHack is waiting for a command**. Movement
keys can be submitted to exercise the input/turn loop. This is a diagnostic
page, not yet the production game UI or the `RealWasmAdapter`.

## Worker protocol

The page sends `{ type: "start", playerName }`, then sends
`{ type: "respond", requestId, value }` for each `input_required` message.
Worker output is copied data only:

- `started` / `ended` / `error` describe the engine lifecycle.
- `event` carries monotonically sequenced shim observations such as messages,
  menu contents, glyph/map callbacks, window changes, and status callbacks.
- `input_required` identifies an actual blocking shim boundary (key, text,
  yes/no, menu choice, or `--More--`).

The shim's `PICK_NONE` menu is emitted as an observation and returned
immediately; it is not an input boundary. Selectable menus are returned to the
page, and the Worker translates selected accelerators into the shim's
`menu_item` array.

The upstream glue's pointer helper does not cover every current upstream ABI
type. The Worker installs local `getPointerValue`/`setPointerValue`
compatibility helpers at initialization (including 16-bit values and
pointer-valued strings) rather than modifying the pinned upstream runtime.

## Current limits

This is a protocol probe, not a complete game integration. In particular,
`status_raw.valueOrPointer` is currently recorded as a raw value/pointer and
not decoded into typed player status. Rendering currently records glyph events
but does not provide a polished map UI. Persistence, restart/quit behavior,
production error recovery, and broader browser coverage remain follow-up work.
