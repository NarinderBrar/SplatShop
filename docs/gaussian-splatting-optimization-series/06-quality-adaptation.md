# 06 -- Quality Adaptation

Not every device can render 500,000 splats at 60 FPS. A phone might only handle 100,000.
A desktop GPU can handle more. Quality adaptation ensures the renderer looks good on every
device.

---

## Quality Presets

We define multiple quality tiers, each controlling a set of rendering parameters:

```typescript
const QUALITY_PRESETS = {
  fast: {
    maxSplats: 100_000,
    maxDpr: 1.0,
    minPixelRadius: 1.0,
    maxPixelRadius: 10.0,
    maxChunks: 4,
  },
  balanced: {
    maxSplats: 300_000,
    maxDpr: 1.5,
    minPixelRadius: 0.5,
    maxPixelRadius: 20.0,
    maxChunks: 8,
  },
  full: {
    maxSplats: 800_000,
    maxDpr: 2.0,
    minPixelRadius: 0.2,
    maxPixelRadius: 30.0,
    maxChunks: 16,
  },
  idle: {
    maxSplats: 800_000,
    maxDpr: 2.0,
    minPixelRadius: 0.1,
    maxPixelRadius: 40.0,
    maxChunks: 16,
  },
  screenshot: {
    maxSplats: 2_000_000,
    maxDpr: 3.0,
    minPixelRadius: 0.05,
    maxPixelRadius: 50.0,
    maxChunks: 32,
  },
};
```

### What Each Parameter Controls

- **maxSplats**: Total splat budget for LOD selection
- **maxDpr**: Maximum device pixel ratio (limits resolution on high-DPI screens)
- **minPixelRadius**: Minimum splat size on screen (smaller = more detail)
- **maxPixelRadius**: Maximum splat size (larger = more coverage per splat)
- **maxChunks**: Maximum loaded chunks in GPU memory

### The Preset Lifecycle

```
User opens scene:
  -> balanced (interactive rendering)

User stops moving:
  -> idle (higher quality, no interaction pressure)

User takes screenshot:
  -> screenshot (maximum quality, one frame)

User switches to minimap:
  -> fast (low resolution, small budget)

User returns to main view:
  -> balanced (back to interactive)
```

---

## Device Tier Detection

We detect the platform and choose a preset automatically:

```typescript
function detectQualityTier(): string {
  const gpu = navigator.gpu;
  if (!gpu) return "fast";

  const adapter = gpu.requestAdapter();
  const features = adapter.features;

  if (features.has("float32-filterable") && adapter.limits.maxBufferSize > 1e9) {
    return "full";
  }

  if (features.has("float32-filterable")) {
    return "balanced";
  }

  return "fast";
}
```

### Detection Criteria

| Device | GPU Feature | Buffer Limit | Preset |
|---|---|---|---|
| High-end desktop | float32-filterable | >1GB | full |
| Mid-range desktop/laptop | float32-filterable | <1GB | balanced |
| Mobile/older device | no float32 | any | fast |

---

## Max DPR Capping

On high-DPI displays (like Retina screens), the device pixel ratio (DPR) can be 2 or 3.
That means each CSS pixel is 2x2 or 3x3 physical pixels. Rendering at native DPR on
a 4K phone would be 5760x2560 -- way too many pixels.

```typescript
function getMaxDpr(preset: QualityPreset): number {
  const hardwareDpr = window.devicePixelRatio;
  return Math.min(hardwareDpr, preset.maxDpr);
}
```

### The Math

```
Screen: 1920x1080 CSS pixels

DPR 1.0: 1920x1080 = 2.1M pixels
DPR 1.5: 2880x1620 = 4.7M pixels
DPR 2.0: 3840x2160 = 8.3M pixels
DPR 3.0: 5760x3240 = 18.7M pixels
```

A phone with DPR=3 and the `fast` preset renders at DPR=1. That is a 9x reduction in
pixel count, making the difference between 10 FPS and 60 FPS.

---

## Adaptive Quality Scaling

Even within a preset, we adapt in real-time based on frame time:

```typescript
class AdaptiveQuality {
  private targetFrameMs = 16.67;
  private currentScale = 1.0;

  adjust(frameTimeMs: number): number {
    if (frameTimeMs > this.targetFrameMs * 1.2) {
      this.currentScale = Math.max(0.25, this.currentScale * 0.9);
    } else if (frameTimeMs < this.targetFrameMs * 0.8) {
      this.currentScale = Math.min(1.5, this.currentScale * 1.05);
    }

    return this.currentScale;
  }
}
```

### How It Works

```
Frame time > 20ms (too slow):
  scale *= 0.9 -> fewer splats, lower DPR

Frame time < 13ms (fast enough):
  scale *= 1.05 -> more splats, higher DPR

Frame time 13-20ms (just right):
  no change
```

This keeps the frame rate stable while maximizing visual quality.

---

## View-Context-Aware Budget

Different views need different budgets. A minimap in the corner needs far fewer splats
than the main viewport:

```typescript
function getSplatBudget(viewType: string, preset: QualityPreset): number {
  switch (viewType) {
    case "interactive": return preset.maxSplats;
    case "minimap":     return 10_000;
    case "thumbnail":   return 50_000;
    case "screenshot":  return 2_000_000;
    case "portal":      return 5_000;
    default:            return preset.maxSplats;
  }
}
```

### Budget Examples

```
Interactive view: 500,000 splats (full detail)
Minimap:          10,000 splats (overview only)
Thumbnail:        50,000 splats (decent preview)
Screenshot:       2,000,000 splats (maximum quality)
Portal (doorway): 5,000 splats (just enough for the preview)
```

---

## Per-Preset LOD Chunk Limits

The number of chunks loaded into GPU memory is limited by the quality preset:

```typescript
function getSsogMaxChunks(preset: string): number {
  switch (preset) {
    case "fast":     return 4;
    case "balanced": return 8;
    case "full":     return 16;
    case "idle":     return 16;
    default:         return 8;
  }
}
```

### Why Limit Chunks?

Each chunk uses GPU memory for its splat data, state buffers, and rendering resources.
Loading too many chunks causes:
- GPU memory exhaustion
- Slower page allocation
- More eviction churn

The chunk limit keeps GPU memory usage predictable and prevents the streaming system
from loading more data than the GPU can handle.

---

## Putting It All Together

The quality system works as a cascade:

```
1. Device tier detection -> choose base preset
2. View context -> choose splat budget
3. DPR capping -> limit resolution
4. Adaptive scaling -> fine-tune in real-time
5. Chunk limits -> control GPU memory
```

Each layer reduces quality just enough to maintain the target frame rate. The result is a
renderer that looks great on a high-end desktop and still runs smoothly on a phone.

---

## Key Takeaways

1. **Presets** -- pre-defined quality tiers for different devices and use cases
2. **Device detection** -- auto-select preset based on GPU capabilities
3. **DPR capping** -- limit resolution on high-DPI displays
4. **Adaptive scaling** -- adjust quality in real-time based on frame time
5. **View-context budgets** -- different splat counts for minimap, thumbnail, screenshot

---

[Previous: Visibility & Culling](./05-visibility-culling.md) | [Next: GPU Sorting](./07-gpu-sorting.md)
