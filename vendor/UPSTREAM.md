# Pinned Upstream Revisions & Notices

STATUS: **placeholder — to be filled during the runtime spike (milestone 1).**
Do not package a demo until this file reflects actual pinned commits.

| Component | Repo | Pinned revision | Commit date | License(s) observed | Notes preserved |
|---|---|---|---|---|---|
| NetHack engine (5.0) | https://github.com/NetHack/NetHack | _TBD (pin exact commit on NetHack-5.0 branch)_ | _TBD_ | NetHack Community License (verify at pin) | Keep `dat` files + notices |
| WASM shim / WebUI | https://github.com/e3sh/Nethack-wasm-webUI | _TBD_ | _TBD_ | _verify at pin_ | Initial integration candidate |
| Tileset / font assets | _as bundled by the above_ | _TBD_ | _TBD_ | _per-asset_ | Some tilesets carry separate GPL/BSD-style terms |
| Emscripten toolchain | https://github.com/emscripten-core/emscripten | _TBD (exact version used for reproducible build)_ | _TBD_ | MIT-like dual license | Record in build log |

Rules (from the handoff, section 3):
1. Pin exact upstream revisions and the WASM toolchain before building the app.
2. Reproduce a working browser build; record the commands in docs/runtime-spike.md.
3. Preserve all upstream notices; final packaging follows the actual files here.
4. If essential hooks are missing, document the gap and implement a narrow shim
   extension rather than expanding the UI or silently substituting a runtime.
