import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { Scene } from "@babylonjs/core/scene";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";

const SPLAT_STATE_SELECTED = 1 << 0;
const SPLAT_STATE_HIDDEN = 1 << 1;
const SPLAT_STATE_LOCKED = 1 << 2;
const SPLAT_STATE_FILTERED = 1 << 3;
const SPLAT_STATE_DELETED = 1 << 4;

const SPLAT_STATE_RENDER_DISABLED = SPLAT_STATE_HIDDEN | SPLAT_STATE_FILTERED | SPLAT_STATE_DELETED;

type SplatStateFlag =
  | typeof SPLAT_STATE_SELECTED
  | typeof SPLAT_STATE_HIDDEN
  | typeof SPLAT_STATE_LOCKED
  | typeof SPLAT_STATE_FILTERED
  | typeof SPLAT_STATE_DELETED;

class SplatStateBuffer {
  readonly data: Uint32Array;
  readonly storage: StorageBuffer;
  private dirtyStart = Number.POSITIVE_INFINITY;
  private dirtyEnd = -1;

  constructor(scene: Scene, readonly numSplats: number) {
    const engine = scene.getEngine() as WebGPUEngine;
    this.data = new Uint32Array(Math.max(1, numSplats));
    this.storage = new StorageBuffer(engine, Math.max(this.data.byteLength, 4), undefined, "SplatState");
    this.storage.update(this.data);
  }

  dispose(): void {
    this.storage.dispose();
  }

  has(index: number, flag: SplatStateFlag): boolean {
    return index >= 0 && index < this.numSplats && (this.data[index] & flag) !== 0;
  }

  set(index: number, flag: SplatStateFlag, enabled: boolean): boolean {
    if (index < 0 || index >= this.numSplats) {
      return false;
    }

    const previous = this.data[index];
    const next = enabled ? previous | flag : previous & ~flag;
    if (next === previous) {
      return false;
    }

    this.data[index] = next;
    this.markDirty(index);
    return true;
  }

  setMany(indices: ArrayLike<number>, flag: SplatStateFlag, enabled: boolean): number {
    let changed = 0;
    for (let item = 0; item < indices.length; item++) {
      if (this.set(indices[item], flag, enabled)) {
        changed++;
      }
    }
    return changed;
  }

  clearFlag(flag: SplatStateFlag): number {
    let changed = 0;
    for (let index = 0; index < this.numSplats; index++) {
      const previous = this.data[index];
      const next = previous & ~flag;
      if (next !== previous) {
        this.data[index] = next;
        this.markDirty(index);
        changed++;
      }
    }
    if (!changed) {
      this.clearDirty();
    }
    return changed;
  }

  count(flag: SplatStateFlag): number {
    let total = 0;
    for (let index = 0; index < this.numSplats; index++) {
      if ((this.data[index] & flag) !== 0) {
        total++;
      }
    }
    return total;
  }

  flush(): void {
    if (this.dirtyEnd < this.dirtyStart) {
      return;
    }

    const start = Math.max(0, this.dirtyStart);
    const end = Math.min(this.numSplats - 1, this.dirtyEnd);
    if (start === 0 && end === this.numSplats - 1) {
      this.storage.update(this.data, 0, this.data.byteLength);
    } else {
      const slice = this.data.subarray(start, end + 1);
      this.storage.update(slice, start * Uint32Array.BYTES_PER_ELEMENT, slice.byteLength);
    }
    this.clearDirty();
  }

  private markDirty(index: number): void {
    this.dirtyStart = Math.min(this.dirtyStart, index);
    this.dirtyEnd = Math.max(this.dirtyEnd, index);
  }

  private clearDirty(): void {
    this.dirtyStart = Number.POSITIVE_INFINITY;
    this.dirtyEnd = -1;
  }
}

export {
  SplatStateBuffer,
  SPLAT_STATE_DELETED,
  SPLAT_STATE_FILTERED,
  SPLAT_STATE_HIDDEN,
  SPLAT_STATE_LOCKED,
  SPLAT_STATE_RENDER_DISABLED,
  SPLAT_STATE_SELECTED,
};
export type { SplatStateFlag };
