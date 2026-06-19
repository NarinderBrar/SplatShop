import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

type GpuBufferArenaStats = {
  bufferCount: number;
  totalBytes: number;
  peakBytes: number;
  allocationCount: number;
  reuseCount: number;
  growCount: number;
};

type ArenaBuffer = {
  buffer: StorageBuffer;
  byteLength: number;
};

class GpuBufferArena {
  private readonly buffers = new Map<string, ArenaBuffer>();
  private totalBytes = 0;
  private peakBytes = 0;
  private allocationCount = 0;
  private reuseCount = 0;
  private growCount = 0;

  constructor(private readonly engine: WebGPUEngine, private readonly label: string) {}

  getStorageBuffer(name: string, byteLength: number): StorageBuffer {
    const key = `${this.label}:${name}`;
    const requestedBytes = Math.max(4, byteLength);
    const existing = this.buffers.get(key);
    if (existing && existing.byteLength >= requestedBytes) {
      this.reuseCount++;
      return existing.buffer;
    }

    if (existing) {
      existing.buffer.dispose();
      this.totalBytes -= existing.byteLength;
      this.growCount++;
    }

    const capacity = roundUpPowerOfTwo(requestedBytes);
    const buffer = new StorageBuffer(this.engine, capacity, undefined, key);
    this.buffers.set(key, { buffer, byteLength: capacity });
    this.totalBytes += capacity;
    this.peakBytes = Math.max(this.peakBytes, this.totalBytes);
    this.allocationCount++;
    return buffer;
  }

  getStats(): GpuBufferArenaStats {
    return {
      bufferCount: this.buffers.size,
      totalBytes: this.totalBytes,
      peakBytes: this.peakBytes,
      allocationCount: this.allocationCount,
      reuseCount: this.reuseCount,
      growCount: this.growCount,
    };
  }

  dispose(): void {
    this.buffers.forEach((entry) => entry.buffer.dispose());
    this.buffers.clear();
    this.totalBytes = 0;
  }
}

const roundUpPowerOfTwo = (value: number): number => {
  let result = 4;
  while (result < value) {
    result *= 2;
  }
  return result;
};

export { GpuBufferArena };
export type { GpuBufferArenaStats };
