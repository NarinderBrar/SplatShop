import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

type GpuReadbackBufferPoolStats = {
  freeBuffers: number;
  checkedOutBuffers: number;
  totalBytes: number;
  peakBytes: number;
  allocationCount: number;
  reuseCount: number;
  queuedReads: number;
  inFlightReads: number;
  completedReads: number;
  failedReads: number;
  totalReadBytes: number;
  peakQueueDepth: number;
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
  private queuedReads = 0;
  private inFlightReads = 0;
  private completedReads = 0;
  private failedReads = 0;
  private totalReadBytes = 0;
  private peakQueueDepth = 0;
  private pendingReadCount = 0;
  private readQueue: Promise<void> = Promise.resolve();
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

  readStorageBuffer<T extends ArrayBufferView>(
    source: StorageBuffer,
    offset: number,
    byteLength: number,
    target: T,
    noDelay = false,
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("GPU readback buffer pool is disposed."));
    }

    this.queuedReads++;
    this.pendingReadCount++;
    this.peakQueueDepth = Math.max(this.peakQueueDepth, this.pendingReadCount);

    const read = this.readQueue.then(async () => {
      this.pendingReadCount = Math.max(0, this.pendingReadCount - 1);
      this.inFlightReads++;
      try {
        const result = await source.read(offset, byteLength, target, noDelay);
        this.completedReads++;
        this.totalReadBytes += byteLength;
        return result as T;
      } catch (error) {
        this.failedReads++;
        throw error;
      } finally {
        this.inFlightReads = Math.max(0, this.inFlightReads - 1);
      }
    });

    this.readQueue = read.then(
      () => undefined,
      () => undefined,
    );
    return read;
  }

  getStats(): GpuReadbackBufferPoolStats {
    return {
      freeBuffers: this.free.length,
      checkedOutBuffers: this.checkedOut.size,
      totalBytes: this.totalBytes,
      peakBytes: this.peakBytes,
      allocationCount: this.allocationCount,
      reuseCount: this.reuseCount,
      queuedReads: this.queuedReads,
      inFlightReads: this.inFlightReads,
      completedReads: this.completedReads,
      failedReads: this.failedReads,
      totalReadBytes: this.totalReadBytes,
      peakQueueDepth: this.peakQueueDepth,
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
