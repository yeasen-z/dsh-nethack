# Pinned upstream revisions and notices

The real runtime is built from the upstream source at the revisions below.
`vendor/upstream-lock.json` is the machine-readable source of truth.

| Component | Repository / version | Pinned revision | License and handling |
|---|---|---|---|
| NetHack engine | [NetHack](https://github.com/NetHack/NetHack), `NetHack-5.0` | `9c3a54d0473ec9ebdf8951f85af13ef63acf0a87` | NetHack General Public License; the upstream `dat/license` is included in the generated embedded data. |
| Emscripten SDK | [emsdk](https://github.com/emscripten-core/emsdk), `4.0.23` | `c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56` | SDK release pin; build container is also pinned by digest in the lock file. |
| Reference WebUI | [Nethack-wasm-webUI](https://github.com/e3sh/Nethack-wasm-webUI) | `4f3f6df7ad5f3cc516f1fc2b72a623f051aa811c` | Its package metadata declares MIT. No standalone license file was present at the pinned revision; treat this as reference material and verify before copying files. |

The reference WebUI is not part of the engine build. Its prebuilt game binary is
not used. The engine build uses NetHack's own `sys/libnh` shim and preserves
upstream notices through NetHack's embedded `license` data file.

The selected NetHack commit is from 2026-10-01. The SDK tag is `4.0.23`. The
upstream repository can move; builds must use the full commit IDs above rather
than branch names.
