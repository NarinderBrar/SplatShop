# 10 -- Rendering Pipeline

All the preparation -- loading, LOD, culling, sorting, binning -- leads to this: actually
drawing splats on screen.

---

## Reverse-Z Depth Buffer

Traditional depth buffers use Z=0 at the near plane and Z=1 at the far plane. Float
precision is non-uniform: there is much more precision near Z=0 than near Z=1. For large
scenes where the far/near ratio is 10,000:1, this means distant objects suffer from
z-fighting.

### The Problem

```
Traditional Z:
Near (Z=0):  [========================]  lots of precision
Far (Z=1):  [==]                        very little precision

Result: distant objects z-fight because they cannot be distinguished
```

### The Solution: Reverse-Z

**Reverse-Z** flips this: Z=1 at near, Z=0 at far. Float precision is highest near 1,
so distant objects get more precision:

```typescript
const projection = mat4.perspective(fov, aspect, near, far);
projection[10] = near / (near - far);      // Instead of far / (near - far)
projection[14] = (near * far) / (near - far);  // Negated

// Clear depth to 0 (far plane in reverse-Z)
renderPass.setDepthClearValue(0);
```

```
Reverse-Z:
Near (Z=1):  [==]                        less precision (but close objects are large)
Far (Z=0):   [========================]  lots of precision

Result: distant objects have enough precision to render correctly
```

This is a free improvement -- just flip the projection matrix and clear value.

---

## Temporal Jitter Accumulation

Gaussian Splatting can look noisy, especially with fewer splats. Temporal accumulation
blends multiple frames together with sub-pixel jitter to reduce noise:

```typescript
class TemporalAccumulation {
  private sampleCount = 0;
  private maxSamples = 8;

  getJitter(frameIndex: number): { x: number; y: number } {
    const u = halton(frameIndex, 2);  // Base-2 Halton sequence
    const v = halton(frameIndex, 3);  // Base-3 Halton sequence

    return {
      x: (u - 0.5) / screenWidth,
      y: (v - 0.5) / screenHeight,
    };
  }

  shouldAccumulate(camera: Camera, lastCamera: Camera): boolean {
    const moved = distance(camera.position, lastCamera.position) > 0.001;
    return !moved && this.sampleCount < this.maxSamples;
  }

  reset(): void {
    this.sampleCount = 0;
  }
}
```

### How It Works

```
Frame 1: render at offset (+0.1, +0.2) pixels
Frame 2: render at offset (-0.3, +0.1) pixels
Frame 3: render at offset (+0.2, -0.2) pixels
...
Frame 8: composite all 8 frames -> smooth anti-aliased result
```

The Halton sequence produces well-distributed sub-pixel offsets. Each frame renders
slightly offset, and the temporal buffer blends them. After 8 frames, you get an
anti-aliased result that looks much smoother than any single frame.

### Stability Detection

When the camera stops moving, accumulation continues. When it starts moving, we reset:

```typescript
if (shouldAccumulate(camera, lastCamera)) {
  // Blend current frame with accumulated buffer
  blendWithAccumulation(currentFrame, accumulatedBuffer, sampleCount);
  sampleCount++;
} else {
  // Camera moved -- start fresh
  resetAccumulation();
  sampleCount = 1;
}
```

---

## Custom WebGPU Render Pipeline

We bypass Babylon.js's default rendering and directly control the GPU render pass:

```typescript
class WebGpuRenderPipeline {
  private renderPassEncoder: GPURenderPassEncoder;

  beginFrame(): void {
    // End Babylon.js's default render pass
    this.scene.getEngine().endFrame();

    // Start our custom pass
    this.renderPassEncoder = this.commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.frameTargets.colorView,
        loadOp: "load",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: this.frameTargets.depthView,
        depthLoadOp: "load",
        depthStoreOp: "store",
      },
    });
  }
}
```

### Why Custom?

Babylon.js's default rendering is designed for triangle-based meshes. Gaussian Splatting
needs custom compute passes, custom sort orders, and custom blending. By taking control
of the render pass, we can:

- Run compute passes before rendering
- Control the exact order of operations
- Use custom blend modes
- Avoid Babylon.js overhead

---

## Instanced Quad Rendering

Each Gaussian is rendered as a small quad (two triangles). We batch 128 quads per draw
call using GPU instancing:

```typescript
const SPLATS_PER_INSTANCE = 128;
const VERTICES_PER_SPLAT = 6;  // Two triangles

function drawSplatBatch(renderPass: GPURenderPassEncoder, count: number) {
  const instances = Math.ceil(count / SPLATS_PER_INSTANCE);
  const vertices = SPLATS_PER_INSTANCE * VERTICES_PER_SPLAT;

  renderPass.draw(vertices, instances);
}
```

### How Instancing Works

```
One draw call:
  vertices: 128 quads * 6 vertices = 768 vertices
  instances: ceil(500000 / 128) = 3907 instances

  GPU processes 3907 * 768 = 3,000,384 vertices in one call
  (vs 500,000 individual draw calls without instancing)
```

128 splats per instance means a scene with 500,000 splats needs only ~3,907 draw calls
instead of 500,000. Each draw call is amortized across 128 splats.

---

## Bind Group Caching

Bind groups tell the GPU where to find buffers. Creating them is expensive. We cache them:

```typescript
class BindGroupCache {
  private cachedGroups = new Map<string, GPUBindGroup>();

  getBindGroup(
    key: string,
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    entries: GPUBindGroupEntry[]
  ): GPUBindGroup {
    if (this.cachedGroups.has(key)) {
      return this.cachedGroups.get(key)!;
    }

    const group = device.createBindGroup({ layout, entries });
    this.cachedGroups.set(key, group);
    return group;
  }
}
```

### Cache Key

The cache key is built from the native buffer references:

```typescript
function buildCacheKey(buffers: GPUBuffer[]): string {
  return buffers.map(b => b.label || b.id).join(":");
}
```

If the same buffers are bound in the same configuration as the previous frame, we reuse
the existing bind group. This avoids the overhead of creating and garbage-collecting
bind groups every frame.

---

## Dummy Storage Buffer

WebGPU requires all declared bindings to have a buffer, even if the shader does not use
them. Instead of creating null-like buffers for unused slots, we use a single pre-allocated
dummy:

```typescript
const DUMMY_BUFFER_SIZE = 4;

const dummyBuffer = device.createBuffer({
  size: DUMMY_BUFFER_SIZE,
  usage: GPUBufferUsage.STORAGE,
});
```

One tiny buffer, shared across all unused slots. This satisfies WebGPU validation without
wasting memory.

---

## Multi-Render Target (MRT) Frame Targets

We render to multiple outputs simultaneously:

```typescript
class FrameTargets {
  createTargets(width: number, height: number): GPURenderPassDescriptor {
    return {
      colorAttachments: [
        {
          view: this.colorTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          format: "rgba16float",  // Half-float for HDR
        },
        {
          view: this.motionTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          format: "rg16float",  // 2D motion vectors
        },
        {
          view: this.selectionTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          format: "r32uint",  // Integer selection ID
        },
      ],
    };
  }
}
```

### What Each Target Does

| Target | Format | Purpose |
|---|---|---|
| Color | rgba16float | HDR color output |
| Motion | rg16float | Per-pixel motion vectors |
| Selection | r32uint | Splat ID under cursor |

### Why Half-Float?

Half-float (16-bit) saves 50% of memory compared to full float (32-bit), while still
providing enough precision for color and motion. The integer selection texture avoids
blending artifacts when identifying which splat is under the cursor.

---

## Allocation Failure Caching

Texture allocation can fail on memory-constrained devices. We cache failures to avoid
repeated attempts:

```typescript
class FrameTargets {
  private failedSizes = new Set<string>();

  tryAllocate(width: number, height: number): boolean {
    const key = `${width}x${height}`;

    if (this.failedSizes.has(key)) {
      return false;  // Already failed, do not try again
    }

    try {
      this.allocate(width, height);
      return true;
    } catch {
      this.failedSizes.add(key);
      return false;
    }
  }
}
```

---

## Disabled Camera Inertia

Babylon.js has a camera inertia setting that makes the camera coast after you release
the mouse. This is bad for splat sorting:

```typescript
camera.inertia = 0;
```

### Why Disable It?

When inertia is enabled, the camera keeps moving between sort frames. The sort order
from the previous frame is no longer correct, causing visible rendering artifacts:

```
With inertia:
  Frame 1: Camera at position A -> sort for A
  Frame 2: Camera coasting to B -> rendering with sort for A (wrong!)
  Frame 3: Camera coasting to C -> rendering with sort for A (wrong!)

Without inertia:
  Frame 1: Camera at position A -> sort for A -> render A
  Frame 2: Camera moved to B -> sort for B -> render B
  Frame 3: Camera moved to C -> sort for C -> render C
```

---

## WebGPU Limits Negotiation

The compute pipeline needs many storage buffer bindings simultaneously. WebGPU has a
default limit of 8. We request more:

```typescript
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice({
  requiredLimits: {
    maxStorageBuffersPerShaderStage: 16,
  },
});
```

### Why 16?

The compute pipeline binds many buffers at once:
- Splat positions (1)
- Splat colors (1)
- Splat opacity (1)
- Depth keys (1)
- State buffer (1)
- Tile counts (1)
- Tile splat lists (1)
- Frustum planes (1)
- Hi-Z texture (1)
- Visible chunks (1)
- Work queue (1)
- Camera matrices (1)
- ...

16 bindings gives enough headroom for the full pipeline without splitting into multiple
passes.

---

## Key Takeaways

1. **Reverse-Z** -- near=1, far=0 for improved float precision at distance
2. **Temporal jitter** -- Halton-sequence sub-pixel jitter with stability detection
3. **Custom pipeline** -- bypass Babylon.js for direct GPU control
4. **Instanced quads** -- 128 splats per draw call for massive batching
5. **Bind group caching** -- skip recreate when buffers are unchanged
6. **MRT targets** -- color, motion, selection in half-float
7. **Camera inertia = 0** -- prevent momentum from causing sort artifacts

---

[Previous: Streaming & Page Management](./09-streaming-page-management.md) | [Next: Infrastructure & Error Handling](./11-infrastructure.md)
