import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

type GpuReadbackBufferPoolStats = {
  freeBuffers: number;
  checkedOutBuffers: number;
  totalBytes: number;
  peakBytes: number;
  allocationCount: number;
  reuseCount: number;
};

type GpuReadbackBufferLease = {
  buffer: StorageBuffer;
  byteLength: number;
  release: () => void;
};

type PooledReadbackBuffer = {
  buffer: StorageBuffer;
  byteLength: number;
};

class GpuReadbackBufferPool {
  private readonly free: PooledReadbackBuffer[] = [];
  private readonly checkedOut = new Set<StorageBuffer>();
  private totalBytes = 0;
  private peakBytes = 0;
  private allocationCount = 0;
  private reuseCount = 0;
  private disposed = false;

  constructor(private readonly engine: WebGPUEngine, private readonly label: string) {}

  acquire(byteLength: number): GpuReadbackBufferLease {
    if (this.disposed) {
      throw new Error("GPU readback buffer pool is disposed.");
    }

    const requestedBytes = roundUpPowerOfTwo(Math.max(4, byteLength));
    const freeIndex = this.free.findIndex((entry) => entry.byteLength >= requestedBytes);
    const entry =
      freeIndex >= 0
        ? this.free.splice(freeIndex, 1)[0]
        : {
            buffer: new StorageBuffer(this.engine, requestedBytes, undefined, `${this.label}:readback`),
            byteLength: requestedBytes,
          };

    if (freeIndex >= 0) {
      this.reuseCount++;
    } else {
      this.allocationCount++;
      this.totalBytes += entry.byteLength;
      this.peakBytes = Math.max(this.peakBytes, this.totalBytes);
    }

    this.checkedOut.add(entry.buffer);
    let released = false;
    return {
      buffer: entry.buffer,
      byteLength: entry.byteLength,
      release: () => {
        if (released || this.disposed) {
          return;
        }
        released = true;
        this.checkedOut.delete(entry.buffer);
        this.free.push(entry);
      },
    };
  }

  getStats(): GpuReadbackBufferPoolStats {
    return {
      freeBuffers: this.free.length,
      checkedOutBuffers: this.checkedOut.size,
      totalBytes: this.totalBytes,
      peakBytes: this.peakBytes,
      allocationCount: this.allocationCount,
      reuseCount: this.reuseCount,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.free.forEach((entry) => entry.buffer.dispose());
    this.free.length = 0;
    this.checkedOut.forEach((buffer) => buffer.dispose());
    this.checkedOut.clear();
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

export { GpuReadbackBufferPool };
export type { GpuReadbackBufferLease, GpuReadbackBufferPoolStats };
