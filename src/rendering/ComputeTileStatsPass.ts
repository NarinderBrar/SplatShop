import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

import { canCreateComputeShader } from "./GpuDepthKeyPass";
import type { GpuUniformArena, GpuUniformArenaFloatSlice } from "./GpuUniformArena";
import ComputeTileStatsPass_CLEAR_SOURCE_raw from "./shaders/compute-tile-stats-pass.clear-source.wgsl?raw";
import ComputeTileStatsPass_BIN_SOURCE_raw from "./shaders/compute-tile-stats-pass.bin-source.wgsl?raw";
import ComputeTileStatsPass_PREFIX_SOURCE_raw from "./shaders/compute-tile-stats-pass.prefix-source.wgsl?raw";
import ComputeTileStatsPass_CLEAR_CURSORS_SOURCE_raw from "./shaders/compute-tile-stats-pass.clear-cursors-source.wgsl?raw";
import ComputeTileStatsPass_SCATTER_SOURCE_raw from "./shaders/compute-tile-stats-pass.scatter-source.wgsl?raw";

const WORKGROUP_SIZE = 256;
const DEFAULT_TILE_SIZE = 32;
const MAX_TILES = 8192;
const STATS_OFFSET = MAX_TILES;
const COUNTER_COUNT = MAX_TILES + 4;
const OFFSET_COUNT = MAX_TILES + 1;

const withParamsBase = (source: string, paramsBase: number): string =>
  source.replaceAll("paramsBuffer[", `paramsBuffer[${paramsBase} + `);

const getClearSource = (paramsBase: number): string =>
  withParamsBase(
    ComputeTileStatsPass_CLEAR_SOURCE_raw.replaceAll("__CLEAR_SOURCE_EXPR_0__", String(WORKGROUP_SIZE)),
    paramsBase,
  );

const getBinSource = (paramsBase: number): string =>
  withParamsBase(
    ComputeTileStatsPass_BIN_SOURCE_raw
      .replaceAll("__BIN_SOURCE_EXPR_0__", String(WORKGROUP_SIZE))
      .replaceAll("__BIN_SOURCE_EXPR_1__", String(STATS_OFFSET + 1))
      .replaceAll("__BIN_SOURCE_EXPR_2__", String(STATS_OFFSET + 2))
      .replaceAll("__BIN_SOURCE_EXPR_3__", String(MAX_TILES))
      .replaceAll("__BIN_SOURCE_EXPR_4__", String(STATS_OFFSET + 3))
      .replaceAll("__BIN_SOURCE_EXPR_5__", String(STATS_OFFSET)),
    paramsBase,
  );

const getPrefixSource = (paramsBase: number): string =>
  withParamsBase(ComputeTileStatsPass_PREFIX_SOURCE_raw, paramsBase);

const getClearCursorsSource = (paramsBase: number): string =>
  withParamsBase(
    ComputeTileStatsPass_CLEAR_CURSORS_SOURCE_raw.replaceAll(
      "__CLEAR_CURSORS_SOURCE_EXPR_0__",
      String(WORKGROUP_SIZE),
    ),
    paramsBase,
  );

const getScatterSource = (paramsBase: number): string =>
  withParamsBase(
    ComputeTileStatsPass_SCATTER_SOURCE_raw
      .replaceAll("__SCATTER_SOURCE_EXPR_0__", String(WORKGROUP_SIZE))
      .replaceAll("__SCATTER_SOURCE_EXPR_1__", String(MAX_TILES))
      .replaceAll("__SCATTER_SOURCE_EXPR_2__", String(STATS_OFFSET + 3)),
    paramsBase,
  );

type ComputeTileStats = {
  enabled: boolean;
  dispatched: boolean;
  tileSize: number;
  tileCount: number;
  tileCols: number;
  tileRows: number;
  occupiedTiles: number;
  maxTileOccupancy: number;
  tileOccupancy?: Uint32Array;
  visibleSplats: number;
  behindSplats: number;
  clippedSplats: number;
  overflowSplats: number;
  tileOffsetsDispatched: boolean;
  tileListScatterDispatched: boolean;
  tileListValidated: boolean;
  tileListEntries: number;
  tileListCapacity: number;
  tileOffsetEntries: number;
  tileCursorEntries: number;
  tileListMismatchedTiles: number;
  lastTileOffsetMs: number;
  lastTileListScatterMs: number;
  lastDispatchMs: number;
  lastDispatchSplats: number;
};

class ComputeTileStatsPass {
  private readonly clearShader: ComputeShader;
  private readonly binShader: ComputeShader;
  private readonly prefixShader: ComputeShader;
  private readonly clearCursorsShader: ComputeShader;
  private readonly scatterShader: ComputeShader;
  private readonly counters: StorageBuffer;
  private readonly tileOffsets: StorageBuffer;
  private readonly tileCursors: StorageBuffer;
  private readonly tileSplatList: StorageBuffer;
  private readonly params: StorageBuffer;
  private readonly paramsSlice?: GpuUniformArenaFloatSlice;
  private readonly paramsData = new Float32Array(25);
  private readPending = false;
  private stats: ComputeTileStats;

  constructor(
    scene: Scene,
    private readonly centerBuffer: StorageBuffer,
    private readonly splatCount: number,
    private readonly tileSize = DEFAULT_TILE_SIZE,
    private readonly centerOffset = 0,
    paramsArena?: GpuUniformArena,
  ) {
    const engine = scene.getEngine() as WebGPUEngine;
    const countersData = new Uint32Array(COUNTER_COUNT);
    this.counters = new StorageBuffer(engine, countersData.byteLength, undefined, "ComputeTileStatsCounters");
    this.counters.update(countersData);
    const tileOffsetsData = new Uint32Array(OFFSET_COUNT);
    this.tileOffsets = new StorageBuffer(engine, tileOffsetsData.byteLength, undefined, "ComputeTileOffsets");
    this.tileOffsets.update(tileOffsetsData);
    const tileCursorsData = new Uint32Array(MAX_TILES);
    this.tileCursors = new StorageBuffer(engine, tileCursorsData.byteLength, undefined, "ComputeTileCursors");
    this.tileCursors.update(tileCursorsData);
    const tileSplatListData = new Uint32Array(Math.max(1, this.splatCount));
    this.tileSplatList = new StorageBuffer(
      engine,
      tileSplatListData.byteLength,
      undefined,
      "ComputeTileSplatList",
    );
    this.tileSplatList.update(tileSplatListData);
    this.paramsSlice = paramsArena?.allocateFloat32("ComputeTileStatsParams", this.paramsData.length);
    this.params =
      this.paramsSlice?.buffer ?? new StorageBuffer(engine, this.paramsData.byteLength, undefined, "ComputeTileStatsParams");
    const paramsBase = this.paramsSlice?.floatOffset ?? 0;

    this.clearShader = new ComputeShader(
      "ComputeTileStatsClear",
      engine,
      { computeSource: getClearSource(paramsBase) },
      {
        bindingsMapping: {
          counters: { group: 0, binding: 0 },
          paramsBuffer: { group: 0, binding: 1 },
        },
      },
    );
    this.clearShader.setStorageBuffer("counters", this.counters);
    this.clearShader.setStorageBuffer("paramsBuffer", this.params);

    this.binShader = new ComputeShader(
      "ComputeTileStatsBin",
      engine,
      { computeSource: getBinSource(paramsBase) },
      {
        bindingsMapping: {
          centerBuffer: { group: 0, binding: 0 },
          counters: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );
    this.binShader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.binShader.setStorageBuffer("counters", this.counters);
    this.binShader.setStorageBuffer("paramsBuffer", this.params);

    this.prefixShader = new ComputeShader(
      "ComputeTilePrefix",
      engine,
      { computeSource: getPrefixSource(paramsBase) },
      {
        bindingsMapping: {
          counters: { group: 0, binding: 0 },
          tileOffsets: { group: 0, binding: 1 },
          paramsBuffer: { group: 0, binding: 2 },
        },
      },
    );
    this.prefixShader.setStorageBuffer("counters", this.counters);
    this.prefixShader.setStorageBuffer("tileOffsets", this.tileOffsets);
    this.prefixShader.setStorageBuffer("paramsBuffer", this.params);

    this.clearCursorsShader = new ComputeShader(
      "ComputeTileCursorClear",
      engine,
      { computeSource: getClearCursorsSource(paramsBase) },
      {
        bindingsMapping: {
          tileCursors: { group: 0, binding: 0 },
          paramsBuffer: { group: 0, binding: 1 },
        },
      },
    );
    this.clearCursorsShader.setStorageBuffer("tileCursors", this.tileCursors);
    this.clearCursorsShader.setStorageBuffer("paramsBuffer", this.params);

    this.scatterShader = new ComputeShader(
      "ComputeTileScatter",
      engine,
      { computeSource: getScatterSource(paramsBase) },
      {
        bindingsMapping: {
          centerBuffer: { group: 0, binding: 0 },
          tileOffsets: { group: 0, binding: 1 },
          tileCursors: { group: 0, binding: 2 },
          tileSplatList: { group: 0, binding: 3 },
          counters: { group: 0, binding: 4 },
          paramsBuffer: { group: 0, binding: 5 },
        },
      },
    );
    this.scatterShader.setStorageBuffer("centerBuffer", this.centerBuffer);
    this.scatterShader.setStorageBuffer("tileOffsets", this.tileOffsets);
    this.scatterShader.setStorageBuffer("tileCursors", this.tileCursors);
    this.scatterShader.setStorageBuffer("tileSplatList", this.tileSplatList);
    this.scatterShader.setStorageBuffer("counters", this.counters);
    this.scatterShader.setStorageBuffer("paramsBuffer", this.params);

    this.stats = {
      enabled: true,
      dispatched: false,
      tileSize: this.tileSize,
      tileCount: 0,
      tileCols: 0,
      tileRows: 0,
      occupiedTiles: 0,
      maxTileOccupancy: 0,
      visibleSplats: 0,
      behindSplats: 0,
      clippedSplats: 0,
      overflowSplats: 0,
      tileOffsetsDispatched: false,
      tileListScatterDispatched: false,
      tileListValidated: false,
      tileListEntries: 0,
      tileListCapacity: this.splatCount,
      tileOffsetEntries: 0,
      tileCursorEntries: 0,
      tileListMismatchedTiles: 0,
      lastTileOffsetMs: 0,
      lastTileListScatterMs: 0,
      lastDispatchMs: 0,
      lastDispatchSplats: 0,
    };
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.counters.dispose();
    this.tileOffsets.dispose();
    this.tileCursors.dispose();
    this.tileSplatList.dispose();
    if (!this.paramsSlice) {
      this.params.dispose();
    }
  }

  dispatch(transform: Matrix, viewportWidth: number, viewportHeight: number, splatCount = this.splatCount): boolean {
    const start = performance.now();
    const tileCols = Math.max(1, Math.ceil(viewportWidth / this.tileSize));
    const tileRows = Math.max(1, Math.ceil(viewportHeight / this.tileSize));
    const tileCount = Math.min(MAX_TILES, tileCols * tileRows);
    const matrix = transform.toArray();
    for (let i = 0; i < 16; i++) {
      this.paramsData[i] = matrix[i];
    }
    this.paramsData[16] = viewportWidth;
    this.paramsData[17] = viewportHeight;
    this.paramsData[18] = this.tileSize;
    this.paramsData[19] = tileCols;
    this.paramsData[20] = tileRows;
    this.paramsData[21] = Math.min(this.splatCount, Math.max(0, Math.floor(splatCount)));
    this.paramsData[22] = COUNTER_COUNT;
    this.paramsData[23] = tileCount;
    this.paramsData[24] = this.centerOffset;
    this.updateParams();

    const cleared = this.clearShader.dispatch(Math.ceil(COUNTER_COUNT / WORKGROUP_SIZE));
    const dispatched = cleared && this.binShader.dispatch(Math.ceil(this.paramsData[21] / WORKGROUP_SIZE));
    const prefixStart = performance.now();
    const offsetsDispatched = dispatched && this.prefixShader.dispatch(1);
    const scatterStart = performance.now();
    const cursorsCleared =
      offsetsDispatched && this.clearCursorsShader.dispatch(Math.ceil(tileCount / WORKGROUP_SIZE));
    const scatterDispatched =
      cursorsCleared && this.scatterShader.dispatch(Math.ceil(this.paramsData[21] / WORKGROUP_SIZE));
    if (dispatched) {
      this.stats = {
        ...this.stats,
        dispatched: true,
        tileOffsetsDispatched: offsetsDispatched,
        tileListScatterDispatched: scatterDispatched,
        tileCount,
        tileCols,
        tileRows,
        lastDispatchMs: performance.now() - start,
        lastTileOffsetMs: offsetsDispatched ? performance.now() - prefixStart : 0,
        lastTileListScatterMs: scatterDispatched ? performance.now() - scatterStart : 0,
        lastDispatchSplats: this.paramsData[21],
      };
      this.scheduleReadback(tileCount);
    }
    return dispatched;
  }

  getStats(): ComputeTileStats {
    return this.stats;
  }

  getTileOffsetsBuffer(): StorageBuffer {
    return this.tileOffsets;
  }

  getTileCountersBuffer(): StorageBuffer {
    return this.counters;
  }

  getTileSplatListBuffer(): StorageBuffer {
    return this.tileSplatList;
  }

  private updateParams(): void {
    if (this.paramsSlice) {
      this.paramsSlice.update(this.paramsData);
      return;
    }
    this.params.update(this.paramsData);
  }

  private scheduleReadback(tileCount: number): void {
    if (this.readPending) {
      return;
    }
    this.readPending = true;
    void Promise.all([
      this.counters.read(0, COUNTER_COUNT * 4),
      this.tileOffsets.read(0, OFFSET_COUNT * 4),
      this.tileCursors.read(0, MAX_TILES * 4),
    ])
      .then(([counterView, offsetView, cursorView]) => {
        const counters = new Uint32Array(counterView.buffer, counterView.byteOffset, counterView.byteLength / 4);
        const offsets = new Uint32Array(offsetView.buffer, offsetView.byteOffset, offsetView.byteLength / 4);
        const cursors = new Uint32Array(cursorView.buffer, cursorView.byteOffset, cursorView.byteLength / 4);
        let occupiedTiles = 0;
        let maxTileOccupancy = 0;
        let cursorEntries = 0;
        let mismatchedTiles = 0;
        let offsetsMonotonic = true;
        for (let i = 0; i < tileCount; i++) {
          const value = counters[i];
          if (value > 0) {
            occupiedTiles++;
            maxTileOccupancy = Math.max(maxTileOccupancy, value);
          }
          cursorEntries += cursors[i];
          if (cursors[i] !== value) {
            mismatchedTiles++;
          }
          if (i > 0 && offsets[i] < offsets[i - 1]) {
            offsetsMonotonic = false;
          }
        }
        if (offsets[tileCount] < offsets[Math.max(0, tileCount - 1)]) {
          offsetsMonotonic = false;
        }
        const visibleSplats = counters[STATS_OFFSET];
        const offsetEntries = offsets[tileCount];
        const tileListValidated =
          offsetsMonotonic &&
          offsetEntries === visibleSplats &&
          cursorEntries === visibleSplats &&
          mismatchedTiles === 0;
        this.stats = {
          ...this.stats,
          occupiedTiles,
          maxTileOccupancy,
          tileOccupancy: counters.slice(0, tileCount),
          visibleSplats,
          tileListValidated,
          tileListEntries: visibleSplats,
          tileOffsetEntries: offsetEntries,
          tileCursorEntries: cursorEntries,
          tileListMismatchedTiles: mismatchedTiles,
          behindSplats: counters[STATS_OFFSET + 1],
          clippedSplats: counters[STATS_OFFSET + 2],
          overflowSplats: counters[STATS_OFFSET + 3],
        };
      })
      .catch(() => {
        this.stats = {
          ...this.stats,
          tileListValidated: false,
        };
      })
      .finally(() => {
        this.readPending = false;
      });
  }
}

export { ComputeTileStatsPass };
export type { ComputeTileStats };
