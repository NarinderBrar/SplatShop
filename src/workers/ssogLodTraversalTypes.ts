import type { SsogLodSelectOptions } from "../splat/SsogLodSelector";

type SsogLodTraversalRequest = {
  requestId: number;
  kind: "visible" | "prefetch";
  entryIndices: Uint32Array;
  nodeIds: Uint32Array;
  depths: Uint16Array;
  lods: Uint16Array;
  counts: Uint32Array;
  flags: Uint8Array;
  lodScales: Float32Array;
  bounds: Float32Array;
  options: SsogLodSelectOptions;
};

type SsogLodTraversalResponse = {
  requestId: number;
  kind: "visible" | "prefetch";
  selectedEntryIndices: Uint32Array;
  selectedSplats: number;
  elapsedMs: number;
  backend: "rust-wasm";
};

export type { SsogLodTraversalRequest, SsogLodTraversalResponse };
