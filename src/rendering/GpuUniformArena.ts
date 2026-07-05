import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

type GpuUniformArenaStats = {
  capacityBytes: number;
  usedBytes: number;
  allocationCount: number;
  updateCount: number;
  frameUpdateCount: number;
  frameUpdateBytes: number;
};

type GpuUniformArenaFloatSlice = {
  label: string;
  buffer: StorageBuffer;
  floatOffset: number;
  floatLength: number;
  update: (data: Float32Array) => void;
};

const FLOATS_PER_ALIGNMENT = 4;

class GpuUniformArena {
  private readonly buffer: StorageBuffer;
  private cursorFloats = 0;
  private allocationCount = 0;
  private updateCount = 0;
  private frameUpdateCount = 0;
  private frameUpdateBytes = 0;

  constructor(
    engine: WebGPUEngine,
    private readonly label: string,
    private readonly capacityBytes = 64 * 1024,
  ) {
    this.buffer = new StorageBuffer(engine, capacityBytes, undefined, label);
  }

  allocateFloat32(label: string, floatLength: number): GpuUniformArenaFloatSlice {
    const alignedOffset = alignFloats(this.cursorFloats);
    const alignedLength = alignFloats(Math.max(1, floatLength));
    const end = alignedOffset + alignedLength;
    if (end * Float32Array.BYTES_PER_ELEMENT > this.capacityBytes) {
      throw new Error(`GpuUniformArena ${this.label} exhausted while allocating ${label}.`);
    }

    this.cursorFloats = end;
    this.allocationCount++;
    return {
      label,
      buffer: this.buffer,
      floatOffset: alignedOffset,
      floatLength,
      update: (data) => this.updateSlice(label, alignedOffset, floatLength, data),
    };
  }

  beginFrame(): void {
    this.frameUpdateCount = 0;
    this.frameUpdateBytes = 0;
  }

  getStats(): GpuUniformArenaStats {
    return {
      capacityBytes: this.capacityBytes,
      usedBytes: this.cursorFloats * Float32Array.BYTES_PER_ELEMENT,
      allocationCount: this.allocationCount,
      updateCount: this.updateCount,
      frameUpdateCount: this.frameUpdateCount,
      frameUpdateBytes: this.frameUpdateBytes,
    };
  }

  dispose(): void {
    this.buffer.dispose();
  }

  private updateSlice(label: string, floatOffset: number, floatLength: number, data: Float32Array): void {
    if (data.length > floatLength) {
      throw new Error(`GpuUniformArena ${this.label} update for ${label} exceeds slice length.`);
    }

    const byteLength = data.byteLength;
    this.buffer.update(data, floatOffset * Float32Array.BYTES_PER_ELEMENT, byteLength);
    this.updateCount++;
    this.frameUpdateCount++;
    this.frameUpdateBytes += byteLength;
  }
}

const alignFloats = (value: number): number =>
  Math.ceil(value / FLOATS_PER_ALIGNMENT) * FLOATS_PER_ALIGNMENT;

export { GpuUniformArena };
export type { GpuUniformArenaFloatSlice, GpuUniformArenaStats };
