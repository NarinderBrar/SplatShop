# 01 -- File Loading & Decoding

Before you can render a single Gaussian, you need to get the data from disk. Gaussian
Splatting files can be large -- a million splats stored as `.ply` files might be 50-100 MB.
For streaming scenarios (web-based viewers), you cannot load the entire file at once.

---

## The Problem

Imagine you have a 100 MB file of splat data on a server. Your viewer needs to show a
small region of the scene. Loading the entire file over the network would take seconds.
You need to load only the bytes you need.

```
Server: scene.sog (100 MB)
         |
         |  HTTP Range Request (bytes 50000-54096)
         v
Client: [chunk of 4096 splats]
```

---

## Range-Based Decoding

Instead of decoding the entire file, we extract only the byte range that contains the
splats we want. The file format stores splat data in packed chunks, and each chunk has a
known byte offset and length.

```typescript
function createPackedSogDataRange(
  backingStore: ArrayBuffer,
  chunkOffset: number,
  chunkLength: number
): ArrayBuffer {
  return backingStore.slice(chunkOffset, chunkOffset + chunkLength);
}
```

The key insight: `ArrayBuffer.slice()` gives us a view into the decoded data without
re-reading or re-decompressing the entire file. We decode the file once, then pull
arbitrary ranges from it on demand.

### How It Works

```
Decoded backing store (full file in memory):
[------all decoded bytes------]
            |                |
            +--offset        +--offset+length
            |                |
            +---->slice<-----+
                   |
                   v
            [requested range]
```

The first decode is expensive. Every subsequent read from the same file is just a
memory copy of the bytes you need.

---

## Decoded Backing Store Cache

What happens when multiple chunks from the same file need to be loaded? Without a cache,
each request would trigger a separate decode of the same file. That is wasteful.

We cache the decoded data per filename:

```typescript
class DecodedBackingStoreCache {
  private stores = new Map<string, ArrayBuffer>();

  getOrCreate(filename: string): ArrayBuffer {
    if (this.stores.has(filename)) {
      return this.stores.get(filename)!;
    }

    const decoded = decodeFile(filename);
    this.stores.set(filename, decoded);
    return decoded;
  }
}
```

When two requests come in for different chunks of the same file, they share the same
decoded backing store. The first request pays the decode cost. Every subsequent request
just reads bytes from the already-decoded buffer.

### Deduplicating Concurrent Requests

If the viewer needs chunks A and B from the same file simultaneously, only one decode
happens:

```
Request 1: "Give me bytes 0-4095 from scene.sog"
Request 2: "Give me bytes 4096-8191 from scene.sog"

Without cache:  decode(scene.sog) x2
With cache:     decode(scene.sog) x1
                both read from same buffer
```

This is critical for streaming, where the LOD selector might request multiple chunks
from the same file in the same frame.

---

## Morton-Order Spatial Sort

Here is a subtlety that matters a lot for GPU performance later: the order in which splats
are stored in the file affects how fast the GPU can process them.

If splats are stored in random order, the GPU has to jump around in memory to read each
one. That kills cache performance. We want spatially nearby splats to be stored near each
other in memory.

### What Is a Morton Curve?

A **Morton curve** (also called a Z-order curve) is a way to map 3D positions to a 1D
sequence while preserving spatial locality. Think of it as folding a 3D space into a
1D line by interleaving the bits of the x, y, and z coordinates.

```
3D space:                Morton order:
+-------+               0---1
| 0 | 1 |               |   |
+---+---+               2---3
| 2 | 3 |
+-------+

Bit interleaving:
x=0, y=0 -> 0b000 = 0
x=1, y=0 -> 0b001 = 1
x=0, y=1 -> 0b010 = 2
x=1, y=1 -> 0b011 = 3
```

### Computing Morton Codes

```typescript
function mortonCode(x: number, y: number, z: number): number {
  let code = 0;
  for (let i = 0; i < 21; i++) {
    code |= ((x >> i) & 1) << (i * 3);
    code |= ((y >> i) & 1) << (i * 3 + 1);
    code |= ((z >> i) & 1) << (i * 3 + 2);
  }
  return code;
}
```

### Why It Matters

When we sort splats by their Morton code, nearby splats end up adjacent in memory:

```
Before Morton sort:
[splat at corner, splat at center, splat at edge, splat far away, ...]

After Morton sort:
[splat1, splat2, splat3, splat4, ...]  (spatially grouped)
```

The GPU can then fetch them in cache-friendly bursts. When the GPU processes splat 1,
it pulls in a cache line that likely contains splat 2 and splat 3 as well. This
significantly improves throughput.

### One-Time Cost

Morton sorting happens once at load time. The cost is O(n log n) for the sort. But it
pays dividends every single frame for the entire lifetime of the scene. For a 10 million
splat scene at 60 FPS, that is 600 million frames of improved GPU cache behavior.

---

## Putting It All Together

The complete loading pipeline:

```
1. HTTP Range Request (fetch bytes from server)
         |
2. Decode (if compressed, e.g. WebP)
         |
3. Cache decoded backing store
         |
4. Slice requested range from backing store
         |
5. Morton-sort non-SOG splats (one-time)
         |
6. Partition into chunks of 4096 splats
         |
7. Ready for LOD selection and rendering
```

Each step is optimized:
- Range requests avoid downloading the full file
- Caching avoids redundant decodes
- Morton sort improves all downstream GPU operations
- Chunk partitioning enables fast culling and LOD

---

## Key Takeaways

1. **Do not decode the whole file** -- use range-based extraction
2. **Cache decoded data** -- one decode per file, shared across all chunk requests
3. **Sort by spatial locality** -- Morton order at load time improves GPU cache hits forever
4. **Partition into chunks** -- enables fast per-chunk culling and LOD decisions later

---

[Next: Data Layout & CPU Optimization](./02-data-layout.md)
