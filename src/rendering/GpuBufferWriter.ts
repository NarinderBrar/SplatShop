import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GpuBufferArena } from "./GpuBufferArena";

type GpuBufferWriterStats = {
  totalUploadBytes: number;
  totalUploadCount: number;
  totalErrorCount: number;
  totalFallbackCount: number;
  totalValidationErrorCount: number;
  scopedOperationCount: number;
  unscopedOperationCount: number;
  lastUploadLabel: string;
  lastUploadBytes: number;
  lastFailureLabel: string;
  lastFailureBytes: number;
  lastFailurePath: string;
  pooledBufferCount: number;
  pooledBufferBytes: number;
  pooledBufferReuses: number;
  pooledBufferReleases: number;
  pooledBufferDisposals: number;
  arenaAllocationCount: number;
  arenaReuseCount: number;
  arenaFreeRangeCount: number;
  arenaSegmentCount: number;
  arenaTotalBytes: number;
  scratchReuseCount: number;
  scratchArenaBufferCount: number;
  scratchArenaTotalBytes: number;
  frameUploadBytes: number;
  frameUploadCount: number;
  frameErrorCount: number;
  lastErrorMessage: string;
};

const MAX_ERROR_MESSAGE_LENGTH = 200;

type ErrorScopeCapableDevice = {
  pushErrorScope?: (filter: "validation" | "out-of-memory" | "internal") => void;
  popErrorScope?: () => Promise<unknown>;
};

type PooledStorageBuffer = {
  buffer: StorageBuffer;
  byteLength: number;
};

type GpuBufferWriterArenaAllocation = {
  key: string;
  buffer: StorageBuffer;
  elementOffset: number;
  elementLength: number;
  byteOffset: number;
  byteLength: number;
  standalone?: boolean;
};

type ArenaFreeRange = {
  byteOffset: number;
  byteLength: number;
};

type ArenaSegment = {
  buffer: StorageBuffer;
  byteLength: number;
  usedBytes: number;
  freeRanges: ArenaFreeRange[];
};

const DEFAULT_ARENA_SEGMENT_BYTES = 4 * 1024 * 1024;

class GpuBufferWriter {
  private readonly scratchArena: GpuBufferArena;
  private readonly freeStorageBuffers = new Map<string, PooledStorageBuffer[]>();
  private readonly arenaSegments = new Map<string, ArenaSegment[]>();
  private readonly storageBufferByteLengths = new WeakMap<StorageBuffer, number>();
  private totalUploadBytes = 0;
  private totalUploadCount = 0;
  private totalErrorCount = 0;
  private totalFallbackCount = 0;
  private totalValidationErrorCount = 0;
  private scopedOperationCount = 0;
  private unscopedOperationCount = 0;
  private lastUploadLabel = "";
  private lastUploadBytes = 0;
  private lastFailureLabel = "";
  private lastFailureBytes = 0;
  private lastFailurePath = "";
  private pooledBufferBytes = 0;
  private pooledBufferReuses = 0;
  private pooledBufferReleases = 0;
  private pooledBufferDisposals = 0;
  private arenaAllocationCount = 0;
  private arenaReuseCount = 0;
  private arenaTotalBytes = 0;
  private scratchReuseCount = 0;
  private frameUploadBytes = 0;
  private frameUploadCount = 0;
  private frameErrorCount = 0;
  private lastErrorMessage = "";
  private readonly device: ErrorScopeCapableDevice | undefined;

  constructor(private readonly engine: WebGPUEngine, label: string) {
    this.scratchArena = new GpuBufferArena(engine, `${label}-writer-scratch`);
    this.device = (engine as unknown as { _device?: ErrorScopeCapableDevice })._device;
  }

  createStorageBuffer(name: string, data: Uint32Array | Float32Array, poolKey?: string): StorageBuffer | null {
    this.recordUploadAttempt(name, data.byteLength);

    const pooled = poolKey ? this.acquirePooledStorageBuffer(poolKey, name, data.byteLength) : undefined;
    if (pooled) {
      this.pushValidationScope();
      try {
        pooled.update(data, 0, data.byteLength);
        this.popValidationScope("reuse", name, data.byteLength);
        return pooled;
      } catch (e) {
        this.popValidationScope("reuse", name, data.byteLength);
        this.recordFailure("reuse", name, data.byteLength, e);
        pooled.dispose();
      }
    }

    this.pushValidationScope();
    try {
      const buffer = new StorageBuffer(this.engine, data.byteLength, undefined, name);
      this.storageBufferByteLengths.set(buffer, Math.max(4, data.byteLength));
      buffer.update(data);
      this.popValidationScope("createStorageBuffer", name, data.byteLength);
      return buffer;
    } catch (e) {
      this.popValidationScope("createStorageBuffer", name, data.byteLength);
      this.recordFailure("createStorageBuffer", name, data.byteLength, e);
      return null;
    }
  }

  createStorageBufferWithFallback(name: string, data: Uint32Array | Float32Array, poolKey?: string): StorageBuffer {
    const buffer = this.createStorageBuffer(name, data, poolKey);
    if (buffer) {
      return buffer;
    }

    this.totalFallbackCount++;
    const fallback = new StorageBuffer(this.engine, Math.max(4, data.byteLength), undefined, `${name}-fallback`);
    this.storageBufferByteLengths.set(fallback, Math.max(4, data.byteLength));
    this.pushValidationScope();
    try {
      fallback.update(data);
      this.popValidationScope("fallback", name, data.byteLength);
    } catch (e) {
      this.popValidationScope("fallback", name, data.byteLength);
      this.recordFailure("fallback", name, data.byteLength, e);
    }
    return fallback;
  }

  releaseStorageBuffer(name: string, buffer: StorageBuffer, poolKey?: string): void {
    if (!poolKey) {
      buffer.dispose();
      return;
    }

    const key = this.getStoragePoolKey(poolKey, name);
    const byteLength = this.storageBufferByteLengths.get(buffer) ?? 0;
    const list = this.freeStorageBuffers.get(key) ?? [];
    if (list.length >= 4) {
      this.pooledBufferDisposals++;
      buffer.dispose();
      return;
    }

    list.push({ buffer, byteLength });
    this.freeStorageBuffers.set(key, list);
    this.pooledBufferBytes += byteLength;
    this.pooledBufferReleases++;
  }

  allocateFloat32ArenaBuffer(key: string, name: string, data: Float32Array): GpuBufferWriterArenaAllocation {
    return this.allocateArenaBuffer(key, name, data, Float32Array.BYTES_PER_ELEMENT);
  }

  allocateUint32ArenaBuffer(key: string, name: string, data: Uint32Array): GpuBufferWriterArenaAllocation {
    return this.allocateArenaBuffer(key, name, data, Uint32Array.BYTES_PER_ELEMENT);
  }

  private allocateArenaBuffer(
    key: string,
    name: string,
    data: Uint32Array | Float32Array,
    bytesPerElement: number,
  ): GpuBufferWriterArenaAllocation {
    this.recordUploadAttempt(name, data.byteLength);

    const byteLength = alignBytes(Math.max(4, data.byteLength));
    const segments = this.arenaSegments.get(key) ?? [];
    this.arenaSegments.set(key, segments);

    let segment = this.findArenaSegment(segments, byteLength);
    if (!segment) {
      const segmentBytes = roundUpPowerOfTwo(Math.max(DEFAULT_ARENA_SEGMENT_BYTES, byteLength));
      const segmentName = `${key}:${name}:segment${segments.length}`;
      this.pushValidationScope();
      try {
        segment = {
          buffer: new StorageBuffer(this.engine, segmentBytes, undefined, segmentName),
          byteLength: segmentBytes,
          usedBytes: 0,
          freeRanges: [],
        };
        this.popValidationScope("arenaSegment", name, segmentBytes);
      } catch (e) {
        this.popValidationScope("arenaSegment", name, segmentBytes);
        this.recordFailure("arenaSegment", name, segmentBytes, e);
        const buffer = this.createStorageBufferWithFallback(`${name}-arena-fallback`, data);
        return {
          key,
          buffer,
          elementOffset: 0,
          elementLength: data.length,
          byteOffset: 0,
          byteLength,
          standalone: true,
        };
      }
      segments.push(segment);
      this.arenaTotalBytes += segmentBytes;
    }

    const byteOffset = this.allocateArenaRange(segment, byteLength);
    this.pushValidationScope();
    try {
      segment.buffer.update(data, byteOffset, data.byteLength);
      this.popValidationScope("arenaWrite", name, data.byteLength);
    } catch (e) {
      this.popValidationScope("arenaWrite", name, data.byteLength);
      this.recordFailure("arenaWrite", name, data.byteLength, e);
    }

    this.arenaAllocationCount++;
    return {
      key,
      buffer: segment.buffer,
      elementOffset: byteOffset / bytesPerElement,
      elementLength: data.length,
      byteOffset,
      byteLength,
    };
  }

  releaseArenaAllocation(allocation: GpuBufferWriterArenaAllocation): void {
    if (allocation.standalone) {
      allocation.buffer.dispose();
      return;
    }

    const segments = this.arenaSegments.get(allocation.key);
    const segment = segments?.find((item) => item.buffer === allocation.buffer);
    if (!segment) {
      return;
    }

    segment.freeRanges.push({
      byteOffset: allocation.byteOffset,
      byteLength: allocation.byteLength,
    });
    this.mergeFreeRanges(segment.freeRanges);
  }

  getScratchBuffer(name: string, byteLength: number): StorageBuffer {
    this.scratchReuseCount++;
    return this.scratchArena.getStorageBuffer(name, byteLength);
  }

  beginFrame(): void {
    this.frameUploadBytes = 0;
    this.frameUploadCount = 0;
    this.frameErrorCount = 0;
  }

  getFrameUploadBytes(): number {
    return this.frameUploadBytes;
  }

  getFrameUploadCount(): number {
    return this.frameUploadCount;
  }

  getFrameErrorCount(): number {
    return this.frameErrorCount;
  }

  getStats(): GpuBufferWriterStats {
    const arenaStats = this.scratchArena.getStats();
    return {
      totalUploadBytes: this.totalUploadBytes,
      totalUploadCount: this.totalUploadCount,
      totalErrorCount: this.totalErrorCount,
      totalFallbackCount: this.totalFallbackCount,
      totalValidationErrorCount: this.totalValidationErrorCount,
      scopedOperationCount: this.scopedOperationCount,
      unscopedOperationCount: this.unscopedOperationCount,
      lastUploadLabel: this.lastUploadLabel,
      lastUploadBytes: this.lastUploadBytes,
      lastFailureLabel: this.lastFailureLabel,
      lastFailureBytes: this.lastFailureBytes,
      lastFailurePath: this.lastFailurePath,
      pooledBufferCount: this.getPooledBufferCount(),
      pooledBufferBytes: this.pooledBufferBytes,
      pooledBufferReuses: this.pooledBufferReuses,
      pooledBufferReleases: this.pooledBufferReleases,
      pooledBufferDisposals: this.pooledBufferDisposals,
      scratchReuseCount: this.scratchReuseCount,
      arenaAllocationCount: this.arenaAllocationCount,
      arenaReuseCount: this.arenaReuseCount,
      arenaFreeRangeCount: this.getArenaFreeRangeCount(),
      arenaSegmentCount: this.getArenaSegmentCount(),
      arenaTotalBytes: this.arenaTotalBytes,
      scratchArenaBufferCount: arenaStats.bufferCount,
      scratchArenaTotalBytes: arenaStats.totalBytes,
      frameUploadBytes: this.frameUploadBytes,
      frameUploadCount: this.frameUploadCount,
      frameErrorCount: this.frameErrorCount,
      lastErrorMessage: this.lastErrorMessage,
    };
  }

  dispose(): void {
    this.scratchArena.dispose();
    for (const list of this.freeStorageBuffers.values()) {
      for (const entry of list) {
        entry.buffer.dispose();
      }
    }
    this.freeStorageBuffers.clear();
    for (const segments of this.arenaSegments.values()) {
      for (const segment of segments) {
        segment.buffer.dispose();
      }
    }
    this.arenaSegments.clear();
    this.pooledBufferBytes = 0;
    this.arenaTotalBytes = 0;
  }

  private acquirePooledStorageBuffer(poolKey: string, name: string, byteLength: number): StorageBuffer | undefined {
    const key = this.getStoragePoolKey(poolKey, name);
    const list = this.freeStorageBuffers.get(key);
    if (!list) {
      return undefined;
    }

    for (let index = 0; index < list.length; index++) {
      const entry = list[index];
      if (entry.byteLength < byteLength) {
        continue;
      }

      list.splice(index, 1);
      this.pooledBufferBytes -= entry.byteLength;
      this.pooledBufferReuses++;
      return entry.buffer;
    }
    return undefined;
  }

  private getPooledBufferCount(): number {
    let count = 0;
    for (const list of this.freeStorageBuffers.values()) {
      count += list.length;
    }
    return count;
  }

  private getStoragePoolKey(poolKey: string, name: string): string {
    return `${poolKey}:${name}`;
  }

  private findArenaSegment(segments: ArenaSegment[], byteLength: number): ArenaSegment | undefined {
    for (const segment of segments) {
      if (segment.freeRanges.some((range) => range.byteLength >= byteLength)) {
        return segment;
      }
      if (segment.usedBytes + byteLength <= segment.byteLength) {
        return segment;
      }
    }
    return undefined;
  }

  private allocateArenaRange(segment: ArenaSegment, byteLength: number): number {
    for (let index = 0; index < segment.freeRanges.length; index++) {
      const range = segment.freeRanges[index];
      if (range.byteLength < byteLength) {
        continue;
      }

      const byteOffset = range.byteOffset;
      range.byteOffset += byteLength;
      range.byteLength -= byteLength;
      if (range.byteLength === 0) {
        segment.freeRanges.splice(index, 1);
      }
      this.arenaReuseCount++;
      return byteOffset;
    }

    const byteOffset = segment.usedBytes;
    segment.usedBytes += byteLength;
    return byteOffset;
  }

  private mergeFreeRanges(ranges: ArenaFreeRange[]): void {
    ranges.sort((a, b) => a.byteOffset - b.byteOffset);
    for (let index = 0; index < ranges.length - 1;) {
      const current = ranges[index];
      const next = ranges[index + 1];
      if (current.byteOffset + current.byteLength >= next.byteOffset) {
        const end = Math.max(current.byteOffset + current.byteLength, next.byteOffset + next.byteLength);
        current.byteLength = end - current.byteOffset;
        ranges.splice(index + 1, 1);
      } else {
        index++;
      }
    }
  }

  private getArenaFreeRangeCount(): number {
    let count = 0;
    for (const segments of this.arenaSegments.values()) {
      for (const segment of segments) {
        count += segment.freeRanges.length;
      }
    }
    return count;
  }

  private getArenaSegmentCount(): number {
    let count = 0;
    for (const segments of this.arenaSegments.values()) {
      count += segments.length;
    }
    return count;
  }

  private recordUploadAttempt(label: string, byteLength: number): void {
    this.totalUploadCount++;
    this.frameUploadCount++;
    this.totalUploadBytes += byteLength;
    this.frameUploadBytes += byteLength;
    this.lastUploadLabel = label;
    this.lastUploadBytes = byteLength;
  }

  private recordFailure(path: string, label: string, byteLength: number, error: unknown): void {
    this.totalErrorCount++;
    this.frameErrorCount++;
    this.lastFailurePath = path;
    this.lastFailureLabel = label;
    this.lastFailureBytes = byteLength;
    this.lastErrorMessage = `GpuBufferWriter::${path}(${label}, ${formatBytes(byteLength)}): ${String(error).slice(0, MAX_ERROR_MESSAGE_LENGTH)}`;
  }

  private pushValidationScope(): void {
    if (this.device?.pushErrorScope && this.device.popErrorScope) {
      this.scopedOperationCount++;
      this.device.pushErrorScope("validation");
    } else {
      this.unscopedOperationCount++;
    }
  }

  private popValidationScope(path: string, label: string, byteLength: number): void {
    if (!this.device?.popErrorScope) {
      return;
    }

    this.device.popErrorScope()
      .then((error) => {
        if (!error) {
          return;
        }
        this.totalValidationErrorCount++;
        this.recordFailure(path, label, byteLength, error);
      })
      .catch((error) => {
        this.recordFailure("popErrorScope", label, byteLength, error);
      });
  }
}

const alignBytes = (value: number): number => Math.ceil(value / 16) * 16;

const formatBytes = (value: number): string => `${value} bytes`;

const roundUpPowerOfTwo = (value: number): number => {
  let result = 4;
  while (result < value) {
    result *= 2;
  }
  return result;
};

export { GpuBufferWriter };
export type { GpuBufferWriterArenaAllocation, GpuBufferWriterStats };
