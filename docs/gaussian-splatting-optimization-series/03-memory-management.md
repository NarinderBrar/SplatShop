# 03 -- Memory & Buffer Management

GPU memory is precious and allocation is expensive. Creating and destroying GPU buffers
every frame would tank performance. We use several patterns to minimize allocation.

---

## GPU Buffer Arena

An arena allocator pre-allocates a large buffer and hands out sub-regions as needed. When
the arena runs out, it grows by doubling.

### How It Works

```
Arena (capacity: 1 MB):
[allocated][allocated][allocated][free...]
 ^          ^          ^          ^
 offset=0   offset=256 offset=512 cursor

After allocate(128):
[allocated][allocated][allocated][allocated][free...]
 ^          ^          ^          ^          ^
 offset=0   offset=256 offset=512 offset=640 cursor

After reset():
[free...]
 ^
 offset=0  (cursor reset, buffer reused)
```

### Implementation

```typescript
class GpuBufferArena {
  private buffer: GPUBuffer;
  private capacity: number;
  private offset = 0;

  constructor(device: GPUDevice, initialCapacity: number) {
    this.capacity = nextPowerOfTwo(initialCapacity);
    this.buffer = device.createBuffer({
      size: this.capacity,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  allocate(size: number): { buffer: GPUBuffer; offset: number } {
    // WebGPU requires 256-byte alignment for storage buffers
    const aligned = alignUp(size, 256);

    if (this.offset + aligned > this.capacity) {
      this.grow(aligned);
    }

    const result = { buffer: this.buffer, offset: this.offset };
    this.offset += aligned;
    return result;
  }

  reset(): void {
    this.offset = 0;
  }

  private grow(needed: number): void {
    while (this.capacity < needed) {
      this.capacity *= 2;
    }
    // Recreate buffer at new capacity
    this.buffer = device.createBuffer({
      size: this.capacity,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }
}
```

### Why Power-of-Two?

Doubling the capacity when growing means:
- At most O(log n) reallocations for n bytes of total allocation
- Each reallocation doubles the previous size
- Over time, the arena stabilizes at the peak frame size

After a few seconds of rendering, the arena stops growing. Every subsequent frame
reuses the same buffer with zero allocations.

---

## GPU Uniform Arena

Multiple compute passes need the same camera matrices and settings. Instead of creating a
uniform buffer per pass, we share one buffer with aligned sub-regions:

```
Shared uniform buffer:
[cam_matrix][viewport][settings][cam_matrix][viewport][settings]
 ^           ^         ^         ^
 pass 0      pass 0    pass 0    pass 1

Each pass gets a (buffer, offset) pair
```

### Implementation

```typescript
class UniformArena {
  private buffer: GPUBuffer;
  private cursor = 0;

  begin(): void {
    this.cursor = 0;
  }

  write(data: Float32Array): { buffer: GPUBuffer; offset: number } {
    // WebGPU requires 16-byte alignment for uniform buffers
    const aligned = alignUp(data.byteLength, 16);
    const offset = this.cursor;
    this.cursor += aligned;

    device.queue.writeBuffer(this.buffer, offset, data);
    return { buffer: this.buffer, offset };
  }

  end(): GPUBuffer {
    return this.buffer;
  }
}
```

One buffer, multiple passes, zero extra allocations.

---

## Typed Array Pool

On the CPU side, we constantly create temporary arrays for sorting, projection results,
and other intermediate data. Creating a new `Float32Array` triggers garbage collection
pressure.

We pool typed arrays by size:

```typescript
class TypedArrayPool {
  private free = new Map<number, Float32Array[]>();

  lease(size: number): Float32Array {
    const bucketSize = nextPowerOfTwo(size);
    const bucket = this.free.get(bucketSize);

    if (bucket && bucket.length > 0) {
      return bucket.pop()!;
    }

    return new Float32Array(bucketSize);
  }

  release(array: Float32Array): void {
    const bucketSize = array.length;
    if (!this.free.has(bucketSize)) {
      this.free.set(bucketSize, []);
    }
    this.free.get(bucketSize)!.push(array);
  }
}
```

### The Lease/Release Pattern

```
Frame 1:
  temp1 = pool.lease(100)    // Allocates Float32Array(128)
  temp2 = pool.lease(200)    // Allocates Float32Array(256)
  // ... use temp1, temp2 ...
  pool.release(temp1)
  pool.release(temp2)

Frame 2:
  temp1 = pool.lease(100)    // Reuses Float32Array(128) from pool
  temp2 = pool.lease(200)    // Reuses Float32Array(256) from pool
  // ... no allocation ...
```

When you need a temporary array, you lease one from the pool. When you are done, you
return it. The next request for that size gets the same array back.

### Power-of-Two Sizing

Arrays are allocated at power-of-two sizes (128, 256, 512, 1024, ...). This means:
- A request for 100 floats gets a 128-float array
- A request for 200 floats gets a 256-float array
- Multiple request sizes share the same pool bucket

This reduces fragmentation and makes the pool simpler to manage.

---

## GPU Readback Buffer Pool

Reading data back from the GPU (for picking, stats, etc.) requires staging buffers.
Creating one per readback is expensive. We pool them:

```typescript
class ReadbackBufferPool {
  private available: GPUBuffer[] = [];

  acquire(device: GPUDevice, size: number): GPUBuffer {
    const aligned = nextPowerOfTwo(size);
    const index = this.available.findIndex(b => b.size >= aligned);

    if (index >= 0) {
      return this.available.splice(index, 1)[0];
    }

    return device.createBuffer({
      size: aligned,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  release(buffer: GPUBuffer): void {
    this.available.push(buffer);
  }
}
```

### Serial Read Queue

WebGPU does not allow mapping multiple buffers simultaneously. We serialize readbacks:

```typescript
class ReadbackQueue {
  private pending: Array<{
    buffer: GPUBuffer;
    resolve: (data: ArrayBuffer) => void;
  }> = [];

  async readback(buffer: GPUBuffer): Promise<ArrayBuffer> {
    return new Promise(resolve => {
      this.pending.push({ buffer, resolve });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.pending.length === 0) return;

    const { buffer, resolve } = this.pending[0];
    await buffer.mapAsync(GPUMapMode.READ);
    resolve(buffer.getMappedRange());
    buffer.unmap();

    this.pending.shift();
    this.processNext();
  }
}
```

---

## Dirty-Range GPU Upload

When a user selects or hides some splats, we update the state buffer on the CPU side.
But uploading the entire million-element buffer to the GPU every time would be wasteful.

Instead, we track the dirty range -- the minimum and maximum index that was modified:

```typescript
class SplatStateBuffer {
  private dirtyMin = Infinity;
  private dirtyMax = -1;

  setState(index: number, bits: number): void {
    this.data[index] = bits;
    this.dirtyMin = Math.min(this.dirtyMin, index);
    this.dirtyMax = Math.max(this.dirtyMax, index);
  }

  flush(device: GPUDevice, gpuBuffer: GPUBuffer): void {
    if (this.dirtyMin > this.dirtyMax) return;

    const byteOffset = this.dirtyMin * 4;
    const byteLength = (this.dirtyMax - this.dirtyMax + 1) * 4;

    device.queue.writeBuffer(
      gpuBuffer, byteOffset,
      this.data.buffer, byteOffset, byteLength
    );

    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }
}
```

### The Impact

If the user selects splat 500, only 4 bytes are uploaded instead of 4 MB. That is a
1,000,000x reduction in upload cost for a single selection change.

```
Full upload:     4,000,000 bytes  (1M splats x 4 bytes)
Dirty upload:    4 bytes         (1 splat selected)
```

---

## Buffer Version Tracking

WebGPU bind groups reference specific buffers. If a buffer has not changed, recreating
the bind group is wasted work. We track version numbers:

```typescript
class BufferVersionTracker {
  private versions = new Map<string, number>();

  rebindStorageBuffer(
    binding: number,
    buffer: GPUBuffer,
    resourceName: string
  ): void {
    const version = this.versions.get(resourceName) ?? -1;
    const currentVersion = this.getResourceVersion(buffer);

    if (version === currentVersion) {
      return;  // Buffer unchanged -- skip rebinding
    }

    this.versions.set(resourceName, currentVersion);
    this.updateBindGroup(binding, buffer);
  }
}
```

When the camera moves but no splats change, buffer versions stay the same and bind groups
are reused. This eliminates unnecessary GPU state changes.

---

## Command Queue Serialization

State-modifying operations (selection, hiding, filtering) must be serialized to prevent
race conditions. We use a single-threaded command queue:

```typescript
class CommandQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  enqueue(command: () => Promise<void>): void {
    this.queue.push(command);
    if (!this.running) {
      this.processNext();
    }
  }

  private async processNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.running = false;
      return;
    }

    this.running = true;
    const command = this.queue.shift()!;
    await command();
    this.processNext();
  }
}

// Usage
commandQueue.enqueue(async () => {
  stateBuffer.setSelected(42, true);
  await stateBuffer.flush(device, gpuBuffer);
});
```

Only one command runs at a time. This prevents concurrent modifications that could
corrupt state or cause visual artifacts.

---

## Key Takeaways

1. **Arena allocation** -- pre-allocate once, reset each frame, zero allocation in steady state
2. **Pool everything** -- typed arrays, readback buffers, staging buffers
3. **Dirty-range uploads** -- track min/max modified index, upload only what changed
4. **Version tracking** -- skip bind group recreation when buffers are unchanged
5. **Serialize state changes** -- prevent race conditions with a command queue

---

[Previous: Data Layout & CPU Optimization](./02-data-layout.md) | [Next: LOD Selection](./04-lod-selection.md)
