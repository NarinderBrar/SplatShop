import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GpuBufferArena } from "./GpuBufferArena";

type GpuBufferWriterStats = {
  totalUploadBytes: number;
  totalUploadCount: number;
  totalErrorCount: number;
  totalFallbackCount: number;
  pooledBufferCount: number;
  pooledBufferBytes: number;
  pooledBufferReuses: number;
  pooledBufferReleases: number;
  pooledBufferDisposals: number;
  scratchReuseCount: number;
  arenaBufferCount: number;
  arenaTotalBytes: number;
  frameUploadBytes: number;
  frameUploadCount: number;
  frameErrorCount: number;
  lastErrorMessage: string;
};

const MAX_ERROR_MESSAGE_LENGTH = 200;

type PooledStorageBuffer = {
  buffer: StorageBuffer;
  byteLength: number;
};

class GpuBufferWriter {
  private readonly scratchArena: GpuBufferArena;
  private readonly freeStorageBuffers = new Map<string, PooledStorageBuffer[]>();
  private readonly storageBufferByteLengths = new WeakMap<StorageBuffer, number>();
  private totalUploadBytes = 0;
  private totalUploadCount = 0;
  private totalErrorCount = 0;
  private totalFallbackCount = 0;
  private pooledBufferBytes = 0;
  private pooledBufferReuses = 0;
  private pooledBufferReleases = 0;
  private pooledBufferDisposals = 0;
  private scratchReuseCount = 0;
  private frameUploadBytes = 0;
  private frameUploadCount = 0;
  private frameErrorCount = 0;
  private lastErrorMessage = "";

  constructor(private readonly engine: WebGPUEngine, label: string) {
    this.scratchArena = new GpuBufferArena(engine, `${label}-writer-scratch`);
  }

  createStorageBuffer(name: string, data: Uint32Array | Float32Array, poolKey?: string): StorageBuffer | null {
    this.totalUploadCount++;
    this.frameUploadCount++;
    this.totalUploadBytes += data.byteLength;
    this.frameUploadBytes += data.byteLength;

    const pooled = poolKey ? this.acquirePooledStorageBuffer(poolKey, name, data.byteLength) : undefined;
    if (pooled) {
      try {
        pooled.update(data, 0, data.byteLength);
        return pooled;
      } catch (e) {
        this.totalErrorCount++;
        this.frameErrorCount++;
        this.lastErrorMessage = `GpuBufferWriter::reuse(${name}): ${String(e).slice(0, MAX_ERROR_MESSAGE_LENGTH)}`;
        pooled.dispose();
      }
    }

    try {
      const buffer = new StorageBuffer(this.engine, data.byteLength, undefined, name);
      this.storageBufferByteLengths.set(buffer, Math.max(4, data.byteLength));
      buffer.update(data);
      return buffer;
    } catch (e) {
      this.totalErrorCount++;
      this.frameErrorCount++;
      this.lastErrorMessage = `GpuBufferWriter::createStorageBuffer(${name}): ${String(e).slice(0, MAX_ERROR_MESSAGE_LENGTH)}`;
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
    try {
      fallback.update(data);
    } catch (e) {
      this.totalErrorCount++;
      this.frameErrorCount++;
      this.lastErrorMessage = `GpuBufferWriter::fallback(${name}): ${String(e).slice(0, MAX_ERROR_MESSAGE_LENGTH)}`;
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
      pooledBufferCount: this.getPooledBufferCount(),
      pooledBufferBytes: this.pooledBufferBytes,
      pooledBufferReuses: this.pooledBufferReuses,
      pooledBufferReleases: this.pooledBufferReleases,
      pooledBufferDisposals: this.pooledBufferDisposals,
      scratchReuseCount: this.scratchReuseCount,
      arenaBufferCount: arenaStats.bufferCount,
      arenaTotalBytes: arenaStats.totalBytes,
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
    this.pooledBufferBytes = 0;
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
}

export { GpuBufferWriter };
export type { GpuBufferWriterStats };
