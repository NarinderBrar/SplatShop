# SSOG LOD Traversal WASM

Rust/WASM implementation target for Spark step 14: move SSOG LOD traversal off the main thread behind a compact typed-array ABI.

The exported `select_ssog_lod` function accepts the same candidate SoA buffers used by the TypeScript selector and returns selected candidate indices. JavaScript can map those indices back to `SsogChunkEntry` values without copying chunk metadata into Rust.

Build from the repository root:

```powershell
npm run wasm:build
```

Required local tools:

- Rust via `rustup`
- `wasm32-unknown-unknown` target
- `wasm-pack`

The generated package is intentionally kept out of the normal `npm run build` path until the runtime worker integration is enabled.
