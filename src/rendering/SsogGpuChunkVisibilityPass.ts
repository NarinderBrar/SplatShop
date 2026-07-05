import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { Plane } from "@babylonjs/core/Maths/math.plane";
import type { Scene } from "@babylonjs/core/scene";

import type { SsogChunkEntry } from "../splat/SplatAsset";
import { canCreateComputeShader } from "./GpuDepthKeyPass";
import SsogGpuChunkVisibilityPass_SOURCE_raw from "./shaders/ssog-gpu-chunk-visibility-pass.compute-source.wgsl?raw";

const WORKGROUP_SIZE = 64;
const PLANE_FLOATS = 6 * 4;
const PARAM_FLOAT_COUNT = PLANE_FLOATS + 4;
const COUNTER_COUNT = 4;

const COMPUTE_SOURCE = SsogGpuChunkVisibilityPass_SOURCE_raw.replaceAll(
  "__COMPUTE_SOURCE_EXPR_0__",
  String(WORKGROUP_SIZE),
);

type SsogGpuChunkVisibilityStats = {
  supported: boolean;
  enabled: boolean;
  dispatched: boolean;
  readbackPending: boolean;
  chunkCount: number;
  visibleChunks: number;
  culledChunks: number;
  lastDispatchMs: number;
};

class SsogGpuChunkVisibilityPass {
  private readonly shader: ComputeShader;
  private readonly bounds: StorageBuffer;
  private readonly visibilityMask: StorageBuffer;
  private readonly counters: StorageBuffer;
  private readonly params: StorageBuffer;
  private readonly paramsData = new Float32Array(PARAM_FLOAT_COUNT);
  private readonly zeroCounters = new Uint32Array(COUNTER_COUNT);
  private readbackPending = false;
  private stats: SsogGpuChunkVisibilityStats;

  constructor(scene: Scene, entries: SsogChunkEntry[]) {
    const engine = scene.getEngine() as WebGPUEngine;
    const boundsData = new Float32Array(Math.max(1, entries.length) * 8);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const offset = index * 8;
      boundsData[offset + 0] = entry.bound.min[0];
      boundsData[offset + 1] = entry.bound.min[1];
      boundsData[offset + 2] = entry.bound.min[2];
      boundsData[offset + 4] = entry.bound.max[0];
      boundsData[offset + 5] = entry.bound.max[1];
      boundsData[offset + 6] = entry.bound.max[2];
    }

    this.bounds = new StorageBuffer(engine, boundsData.byteLength, undefined, "SsogGpuChunkVisibilityBounds");
    this.bounds.update(boundsData);
    this.visibilityMask = new StorageBuffer(
      engine,
      Math.max(1, entries.length) * Uint32Array.BYTES_PER_ELEMENT,
      undefined,
      "SsogGpuChunkVisibilityMask",
    );
    this.counters = new StorageBuffer(
      engine,
      this.zeroCounters.byteLength,
      undefined,
      "SsogGpuChunkVisibilityCounters",
    );
    this.params = new StorageBuffer(engine, this.paramsData.byteLength, undefined, "SsogGpuChunkVisibilityParams");
    this.shader = new ComputeShader(
      "SsogGpuChunkVisibilityPass",
      engine,
      { computeSource: COMPUTE_SOURCE },
      {
        bindingsMapping: {
          boundsBuffer: { group: 0, binding: 0 },
          visibilityMask: { group: 0, binding: 1 },
          counters: { group: 0, binding: 2 },
          paramsBuffer: { group: 0, binding: 3 },
        },
      },
    );
    this.shader.setStorageBuffer("boundsBuffer", this.bounds);
    this.shader.setStorageBuffer("visibilityMask", this.visibilityMask);
    this.shader.setStorageBuffer("counters", this.counters);
    this.shader.setStorageBuffer("paramsBuffer", this.params);
    this.stats = {
      supported: true,
      enabled: true,
      dispatched: false,
      readbackPending: false,
      chunkCount: entries.length,
      visibleChunks: 0,
      culledChunks: 0,
      lastDispatchMs: 0,
    };
  }

  static isSupported(scene: Scene): boolean {
    return canCreateComputeShader(scene);
  }

  dispose(): void {
    this.bounds.dispose();
    this.visibilityMask.dispose();
    this.counters.dispose();
    this.params.dispose();
  }

  dispatch(planes: Plane[], margin: number): boolean {
    if (this.readbackPending) {
      this.stats = {
        ...this.stats,
        readbackPending: true,
      };
      return false;
    }

    const start = performance.now();
    for (let index = 0; index < 6; index++) {
      const plane = planes[index];
      const offset = index * 4;
      this.paramsData[offset + 0] = plane.normal.x;
      this.paramsData[offset + 1] = plane.normal.y;
      this.paramsData[offset + 2] = plane.normal.z;
      this.paramsData[offset + 3] = plane.d;
    }
    this.paramsData[PLANE_FLOATS + 0] = this.stats.chunkCount;
    this.paramsData[PLANE_FLOATS + 1] = Math.max(0, margin);
    this.params.update(this.paramsData);
    this.counters.update(this.zeroCounters);

    const dispatched = this.shader.dispatch(Math.ceil(Math.max(1, this.stats.chunkCount) / WORKGROUP_SIZE));
    this.stats = {
      ...this.stats,
      enabled: true,
      dispatched,
      readbackPending: dispatched || this.readbackPending,
      lastDispatchMs: dispatched ? performance.now() - start : 0,
    };
    if (dispatched) {
      this.scheduleReadback();
    }
    return dispatched;
  }

  markSkipped(visibleChunks: number, culledChunks: number): void {
    this.stats = {
      ...this.stats,
      enabled: false,
      dispatched: false,
      visibleChunks,
      culledChunks,
      readbackPending: this.readbackPending,
      lastDispatchMs: 0,
    };
  }

  getStats(): SsogGpuChunkVisibilityStats {
    return {
      ...this.stats,
      readbackPending: this.readbackPending,
    };
  }

  private scheduleReadback(): void {
    if (this.readbackPending) {
      return;
    }
    this.readbackPending = true;
    void this.counters
      .read(0, this.zeroCounters.byteLength)
      .then((counterView) => {
        const counters = new Uint32Array(counterView.buffer, counterView.byteOffset, counterView.byteLength / 4);
        const visibleChunks = counters[0] ?? 0;
        this.stats = {
          ...this.stats,
          visibleChunks,
          culledChunks: counters[1] ?? Math.max(0, this.stats.chunkCount - visibleChunks),
        };
      })
      .finally(() => {
        this.readbackPending = false;
        this.stats = {
          ...this.stats,
          readbackPending: false,
        };
      });
  }
}

export { SsogGpuChunkVisibilityPass };
export type { SsogGpuChunkVisibilityStats };
