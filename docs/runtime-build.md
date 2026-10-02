# Build the real NetHack runtime

The runtime is compiled from the pinned upstream source. It is not checked into
this repository. Run `npm run bootstrap` after cloning to fetch the source,
build the WASM files, verify their hashes, and typecheck the middleware.

## Requirements

- Node.js 20 and npm 10.8.2 (the repository pins Node in `.nvmrc`).
- Git with submodule support.
- Either an activated Emscripten 4.0.23 checkout, or Docker/OrbStack.

The default build uses Docker when `EMSDK` is not set. The container is pinned
to the digest in `vendor/upstream-lock.json`. To use a locally installed SDK:

```sh
source /path/to/emsdk/emsdk_env.sh
NETHACK_BUILD_MODE=local npm run runtime:build
```

For a source checkout you already have at the pinned revision:

```sh
NETHACK_SRC=/path/to/NetHack npm run runtime:fetch
NETHACK_SRC=/path/to/NetHack npm run runtime:build
```

The fetch step validates an external checkout and will not change its revision.
For a normal clone, it stores upstream source under `.cache/upstream/nethack`.
Git honors the usual `https_proxy`, `http_proxy`, and `all_proxy` environment
variables when fetching. For example:

```sh
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897
npm run bootstrap
```

## What the build emits

`apps/web/public/runtime/` contains `nethack.js`, `nethack.wasm`, and
`runtime-manifest.json`. The manifest records the upstream revision, toolchain,
file sizes, and SHA-256 hashes. The game data and NetHack license are embedded
in the WASM module by upstream's `CROSS_TO_WASM=1` build.

On macOS, upstream's makefiles may print `nroff: command not found` and `expr:
syntax error` while checking optional manpage/package-manager settings. The
WASM target can still succeed; the build script fails on a nonzero make exit,
and `runtime:verify` checks that the loader and module are complete.

## Upstream build recipe

The selected upstream revision documents the WASM recipe in `sys/libnh/README.md`:

```sh
sys/unix/setup.sh sys/unix/hints/macOS.501 # use linux.501 inside Docker
mkdir -p targets/wasm/wasm-data
make CROSS_TO_WASM=1 all
```

The upstream source and toolchain commits, container digest, and license notes
are recorded in `vendor/UPSTREAM.md` and `vendor/upstream-lock.json`.

## Current smoke-test boundary

`runtime:verify` initializes the generated module under Node with `noInitialRun`,
checks the exported engine/shim functions, and confirms that `nhdat` and the
upstream license are embedded. After `npm run bootstrap`, serve the public
directory to repeat the initialization check in a browser:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory apps/web/public
```

Then open `http://127.0.0.1:4173/runtime-smoke.html`. The page reports whether
Chrome loaded the WASM, exports, embedded game data, and license. This initializes
the engine with `noInitialRun`; starting a game and driving its first input prompt
remain untested until the Worker bridge is implemented.
