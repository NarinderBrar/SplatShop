import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";

type BufferVersionTrackerStats = {
  bindGroupGeneration: number;
  trackedBufferCount: number;
  contentGeneration: number;
  rebindAttemptCount: number;
  rebindSkippedCount: number;
  rebindAppliedCount: number;
  resourceGeneration: number;
};

type BoundBufferState = {
  buffer: StorageBuffer;
  resourceVersion: number;
};

class BufferVersionTracker {
  private readonly resourceVersions = new Map<StorageBuffer, number>();
  private readonly contentVersions = new Map<StorageBuffer, number>();
  private readonly boundBuffers = new Map<string, BoundBufferState>();
  private nextResourceVersion = 1;
  private nextContentVersion = 1;
  private _bindGroupGeneration = 0;
  private _contentGeneration = 0;
  private _rebindAttemptCount = 0;
  private _rebindSkippedCount = 0;

  track(buffer: StorageBuffer): void {
    if (!this.resourceVersions.has(buffer)) {
      this.resourceVersions.set(buffer, this.nextResourceVersion++);
    }
  }

  bump(buffer: StorageBuffer): void {
    this.track(buffer);
    this.contentVersions.set(buffer, this.nextContentVersion++);
    this._contentGeneration++;
  }

  getVersion(buffer: StorageBuffer): number {
    this.track(buffer);
    return this.resourceVersions.get(buffer) ?? 0;
  }

  trackAll(buffers: Record<string, StorageBuffer | undefined>): void {
    for (const key of Object.keys(buffers)) {
      const b = buffers[key];
      if (b) {
        this.track(b);
      }
    }
  }

  rebindStorageBuffer(material: { setStorageBuffer: (name: string, buffer: StorageBuffer) => void }, bindName: string, buffer: StorageBuffer | undefined): boolean {
    if (!buffer) {
      return false;
    }
    this._rebindAttemptCount++;
    const resourceVersion = this.getVersion(buffer);
    const bound = this.boundBuffers.get(bindName);
    if (!bound || bound.buffer !== buffer || bound.resourceVersion !== resourceVersion) {
      material.setStorageBuffer(bindName, buffer);
      this.boundBuffers.set(bindName, { buffer, resourceVersion });
      this._bindGroupGeneration++;
      return true;
    }
    this._rebindSkippedCount++;
    return false;
  }

  get bindGroupGeneration(): number {
    return this._bindGroupGeneration;
  }

  get contentGeneration(): number {
    return this._contentGeneration;
  }

  getStats(): BufferVersionTrackerStats {
    return {
      bindGroupGeneration: this._bindGroupGeneration,
      trackedBufferCount: this.resourceVersions.size,
      contentGeneration: this._contentGeneration,
      rebindAttemptCount: this._rebindAttemptCount,
      rebindSkippedCount: this._rebindSkippedCount,
      rebindAppliedCount: this._bindGroupGeneration,
      resourceGeneration: this.nextResourceVersion - 1,
    };
  }
}

export { BufferVersionTracker };
export type { BufferVersionTrackerStats };
