/// <reference lib="webworker" />

import init, { select_ssog_lod } from "../wasm/ssog_lod_traversal_pkg/ssog_lod_traversal";
import wasmUrl from "../wasm/ssog_lod_traversal_pkg/ssog_lod_traversal_bg.wasm?url";
import type { SsogLodTraversalRequest, SsogLodTraversalResponse } from "./ssogLodTraversalTypes";

const workerSelf = self as unknown as DedicatedWorkerGlobalScope;

let wasmReady: Promise<void> | undefined;

const ensureWasmReady = async (): Promise<void> => {
  wasmReady ??= init(wasmUrl).then(() => undefined);
  return wasmReady;
};

workerSelf.onmessage = (event: MessageEvent<SsogLodTraversalRequest>) => {
  void handleRequest(event.data);
};

const handleRequest = async (request: SsogLodTraversalRequest): Promise<void> => {
  const start = performance.now();
  await ensureWasmReady();
  const options = request.options;
  const selectedCandidateIndices = select_ssog_lod(
    request.nodeIds,
    request.depths,
    request.lods,
    request.counts,
    request.flags,
    request.lodScales,
    request.bounds,
    Math.max(0, Math.floor(options.budget)),
    options.cameraPosition.x,
    options.cameraPosition.y,
    options.cameraPosition.z,
    options.cameraForward?.x ?? 0,
    options.cameraForward?.y ?? 0,
    options.cameraForward?.z ?? 1,
    options.focalPixels,
    options.lodRangeMin,
    options.lodRangeMax,
    options.lodUnderfillLimit,
    options.forceFineScreenRatio ?? 0.9,
    options.forceFineViewDot ?? 0.2,
    options.coneFov0Cos ?? 1,
    options.coneFovCos ?? 1,
    options.coneFoveate ?? 0,
    options.behindFoveate ?? 0,
  );

  const selectedEntryIndices = new Uint32Array(selectedCandidateIndices.length);
  let selectedSplats = 0;
  for (let index = 0; index < selectedCandidateIndices.length; index++) {
    const candidateIndex = selectedCandidateIndices[index];
    selectedEntryIndices[index] = request.entryIndices[candidateIndex] ?? 0;
    selectedSplats += request.counts[candidateIndex] ?? 0;
  }

  const response: SsogLodTraversalResponse = {
    requestId: request.requestId,
    kind: request.kind,
    selectedEntryIndices,
    selectedSplats,
    elapsedMs: performance.now() - start,
    backend: "rust-wasm",
  };
  workerSelf.postMessage(response, [selectedEntryIndices.buffer]);
};
