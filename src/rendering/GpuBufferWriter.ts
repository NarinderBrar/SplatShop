import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { GpuBufferArena } from "./GpuBufferArena";

type GpuBufferWriterStats = {
  totalUploadBytes: number;
  totalUploadCount: number;
  totalErrorCount: number;
  totalFallbackCount: number;
  scratchReuseCount: number;
  arenaBufferCount: number;
  arenaTotalBytes: number;
  frameUploadBytes: number;
  frameUploadCount: number;
  frameErrorCount: number;
  lastErrorMessage: string;
};

const MAX_ERROR_MESSAGE_LENGTH = 200;

class GpuBufferWriter {
  private readonly scratchArena: GpuBufferArena;
  private totalUploadBytes = 0;
  private totalUploadCount = 0;
  private totalErrorCount = 0;
  private totalFallbackCount = 0;
  private scratchReuseCount = 0;
  private frameUploadBytes = 0;
  private frameUploadCount = 0;
  private frameErrorCount = 0;
  private lastErrorMessage = "";

  constructor(private readonly engine: WebGPUEngine, label: string) {
    this.scratchArena = new GpuBufferArena(engine, `${label}-writer-scratch`);
  }

  createStorageBuffer(name: string, data: Uint32Array | Float32Array): StorageBuffer | null {
    this.totalUploadCount++;
    this.frameUploadCount++;
    this.totalUploadBytes += data.byteLength;
    this.frameUploadBytes += data.byteLength;

    try {
      const buffer = new StorageBuffer(this.engine, data.byteLength, undefined, name);
      buffer.update(data);
      return buffer;
    } catch (e) {
      this.totalErrorCount++;
      this.frameErrorCount++;
      this.lastErrorMessage = `GpuBufferWriter::createStorageBuffer(${name}): ${String(e).slice(0, MAX_ERROR_MESSAGE_LENGTH)}`;
      return null;
    }
  }

  createStorageBufferWithFallback(name: string, data: Uint32Array | Float32Array): StorageBuffer {
    const buffer = this.createStorageBuffer(name, data);
    if (buffer) {
      return buffer;
    }

    this.totalFallbackCount++;
    const fallback = new StorageBuffer(this.engine, Math.max(4, data.byteLength), undefined, `${name}-fallback`);
    try {
      fallback.update(data);
    } catch (e) {
      this.totalErrorCount++;
      this.frameErrorCount++;
      this.lastErrorMessage = `GpuBufferWriter::fallback(${name}): ${String(e).slice(0, MAX_ERROR_MESSAGE_LENGTH)}`;
    }
    return fallback;
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
  }
}

export { GpuBufferWriter };
export type { GpuBufferWriterStats };
