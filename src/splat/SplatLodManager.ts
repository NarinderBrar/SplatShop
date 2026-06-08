import { Vector3 } from "@babylonjs/core/Maths/math.vector";

type SplatLodChunk = {
  start: number;
  end: number;
  center: Vector3;
  radius: number;
};

type SplatLodSelection = {
  centers: Float32Array;
  indices: Uint32Array;
  activeChunks: number;
  selectedLods: number;
};

type SplatLodSelectOptions = {
  budget: number;
  cameraPosition?: Vector3;
  lodRangeMin: number;
  lodRangeMax: number;
  lodUnderfillLimit: number;
};

const DEFAULT_CHUNK_SIZE = 4096;

class SplatLodManager {
  readonly chunks: SplatLodChunk[];
  private lastSelectedStarts = new Set<number>();

  constructor(
    private readonly centerScale: Float32Array,
    private readonly chunkSize = DEFAULT_CHUNK_SIZE,
  ) {
    this.chunks = this.buildChunks();
  }

  select(optionsOrBudget: SplatLodSelectOptions | number, cameraPosition?: Vector3): SplatLodSelection {
    const options =
      typeof optionsOrBudget === "number"
        ? {
            budget: optionsOrBudget,
            cameraPosition,
            lodRangeMin: 0,
            lodRangeMax: 1,
            lodUnderfillLimit: 0.85,
          }
        : optionsOrBudget;
    const splatCount = this.centerScale.length / 4;
    const clampedBudget = Math.min(splatCount, Math.max(0, Math.floor(options.budget)));

    if (clampedBudget >= splatCount) {
      this.lastSelectedStarts = new Set(this.chunks.map((chunk) => chunk.start));
      return this.createSelection(this.chunks, splatCount, 0);
    }

    const rankedChunks = this.chunks
      .map((chunk, index) => ({
        chunk,
        index,
        priority: this.getChunkPriority(chunk, options),
      }))
      .sort((a, b) => b.priority - a.priority || a.index - b.index);

    const selected: SplatLodChunk[] = [];
    let selectedSplats = 0;
    const underfillTarget = clampedBudget * Math.min(1, Math.max(0, options.lodUnderfillLimit));

    for (const item of rankedChunks) {
      const chunkSplats = item.chunk.end - item.chunk.start;
      if (chunkSplats <= 0) {
        continue;
      }
      const nextSplats = selectedSplats + chunkSplats;
      if (selectedSplats > 0 && nextSplats > clampedBudget && selectedSplats >= underfillTarget) {
        continue;
      }

      selected.push(item.chunk);
      selectedSplats = nextSplats;

      if (selectedSplats >= clampedBudget) {
        break;
      }
    }

    if (selected.length === 0 && rankedChunks.length > 0) {
      selected.push(rankedChunks[0].chunk);
      selectedSplats = rankedChunks[0].chunk.end - rankedChunks[0].chunk.start;
    }

    selected.sort((a, b) => a.start - b.start);
    this.lastSelectedStarts = new Set(selected.map((chunk) => chunk.start));
    return this.createSelection(selected, selectedSplats, 1);
  }

  private buildChunks(): SplatLodChunk[] {
    const splatCount = this.centerScale.length / 4;
    const chunkCount = Math.ceil(splatCount / this.chunkSize);
    const chunks: SplatLodChunk[] = [];

    for (let chunk = 0; chunk < chunkCount; chunk++) {
      const start = chunk * this.chunkSize;
      const end = Math.min(start + this.chunkSize, splatCount);
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let minZ = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;

      for (let i = start; i < end; i++) {
        const offset = i * 4;
        const x = this.centerScale[offset + 0];
        const y = this.centerScale[offset + 1];
        const z = this.centerScale[offset + 2];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
      }

      const center = new Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
      const radius = Math.max(0.001, Vector3.Distance(center, new Vector3(maxX, maxY, maxZ)));
      chunks.push({ start, end, center, radius });
    }

    return chunks;
  }

  private getChunkPriority(chunk: SplatLodChunk, options: SplatLodSelectOptions): number {
    const chunkSplats = chunk.end - chunk.start;
    if (!options.cameraPosition) {
      return chunkSplats;
    }

    const distance = Vector3.Distance(options.cameraPosition, chunk.center);
    const nearDistance = Math.max(0.01, distance - chunk.radius);
    const screenRadius = chunk.radius / nearDistance;
    const range = Math.max(0.000001, options.lodRangeMax - options.lodRangeMin);
    const normalized = Math.min(1, Math.max(0, (screenRadius - options.lodRangeMin) / range));
    const hysteresis = this.lastSelectedStarts.has(chunk.start) ? 1.12 : 1;
    return normalized * Math.sqrt(chunkSplats) * hysteresis;
  }

  private createSelection(
    chunks: SplatLodChunk[],
    selectedSplats: number,
    selectedLods: number,
  ): SplatLodSelection {
    const centers = new Float32Array(selectedSplats * 3);
    const indices = new Uint32Array(selectedSplats);
    let written = 0;

    for (const chunk of chunks) {
      for (let splatIndex = chunk.start; splatIndex < chunk.end && written < selectedSplats; splatIndex++) {
        const src = splatIndex * 4;
        const dst = written * 3;
        indices[written] = splatIndex;
        centers[dst + 0] = this.centerScale[src + 0];
        centers[dst + 1] = this.centerScale[src + 1];
        centers[dst + 2] = this.centerScale[src + 2];
        written++;
      }
    }

    return {
      centers,
      indices,
      activeChunks: chunks.length,
      selectedLods,
    };
  }
}

export { SplatLodManager };
export type { SplatLodChunk, SplatLodSelection, SplatLodSelectOptions };
