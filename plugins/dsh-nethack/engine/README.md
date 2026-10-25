# @neth4ck/wasm-367

NetHack 3.6.7 compiled to WebAssembly via Emscripten.

## Installation

```bash
npm install @neth4ck/wasm-367
```

## Usage

### With the shim

```js
import nethackStart from "@neth4ck/neth4ck";
import createModule from "@neth4ck/wasm-367";

await nethackStart(createModule, myCallback, {
    nethackOptions: { name: "Bubba" },
});
```

### Direct usage

```js
import createModule from "@neth4ck/wasm-367";

const Module = await createModule({
    noInitialRun: true,
});
```

### Copying raw files

If you need the raw `.js` and `.wasm` files (e.g., for bundler copying):

```
node_modules/@neth4ck/wasm-367/build/nethack.js
node_modules/@neth4ck/wasm-367/build/nethack.wasm
```

## License

See [LICENSE.md](./LICENSE.md) — NetHack General Public License.
