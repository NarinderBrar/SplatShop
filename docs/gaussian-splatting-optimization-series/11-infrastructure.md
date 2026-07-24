# 11 -- Infrastructure & Error Handling

A production renderer needs robust error handling. WebGPU can fail for many reasons:
unsupported features, validation errors, out-of-memory conditions.

---

## Compute Capability Probing

Before enabling the GPU compute pipeline, we verify that the device supports it:

```typescript
function canCreateComputeShader(): boolean {
  if (!navigator.gpu) return false;

  const adapter = navigator.gpu.requestAdapter();
  if (!adapter) return false;

  if (!adapter.features.has("subgroups")) return false;

  return true;
}
```

### What We Check

| Check | Why |
|---|---|
| `navigator.gpu` exists | WebGPU is supported |
| `requestAdapter()` returns | GPU is available |
| `subgroups` feature | Required for parallel reduction in compute shaders |

If any check fails, we fall back to CPU-based rendering. The fallback is transparent to
the user.

---

## Renderer Backend Selection

We try the requested backend and fall back gracefully:

```typescript
function resolveRendererBackend(requested: string): string {
  if (requested === "webgpu" && canCreateComputeShader()) {
    return "webgpu";
  }

  if (requested === "webgl2") {
    return "webgl2";
  }

  if (canCreateComputeShader()) return "webgpu";
  return "webgl2";
}
```

### Fallback Chain

```
Requested: webgpu
  -> webgpu available? -> use webgpu
  -> webgpu unavailable? -> try webgl2
  -> webgl2 unavailable? -> report error

Requested: webgl2
  -> use webgl2 (no compute shaders, CPU fallback)
```

### Reporting Fallback Reason

```typescript
function resolveWithReason(requested: string): {
  backend: string;
  reason?: string;
} {
  if (requested === "webgpu" && !canCreateComputeShader()) {
    return {
      backend: "webgl2",
      reason: "WebGPU compute not available, falling back to WebGL2",
    };
  }
  return { backend: requested };
}
```

---

## WebGPU Error Scope Validation

Pipeline creation can fail silently. We wrap it in error scopes to catch failures:

```typescript
async function createPipelineSafely(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor
): Promise<GPURenderPipeline | null> {
  device.pushErrorScope("validation");

  const pipeline = device.createRenderPipeline(descriptor);

  const error = await device.popErrorScope();
  if (error) {
    console.error("Pipeline creation failed:", error.message);
    return null;
  }

  return pipeline;
}
```

### How Error Scopes Work

```
pushErrorScope("validation")
  -> createRenderPipeline()  // might fail
popErrorScope()
  -> returns error if creation failed, null otherwise
```

Error scopes act like a try-catch for GPU operations. They catch validation errors
without crashing the renderer. The pipeline returns null, and the caller can fall back
to a simpler rendering path.

### Common Validation Errors

| Error | Cause |
|---|---|
| "invalid bind group layout" | Buffer bindings do not match shader |
| "invalid pipeline" | Shader compilation failed |
| "invalid texture format" | Texture format not supported |
| "not enough storage buffers" | Too many bindings for the limit |

---

## WebGPU Error Deduplication

WebGPU can emit the same error message repeatedly (once per frame for some errors).
Logging every instance floods the console:

```typescript
class RenderDiagnostics {
  private errors = new Map<string, number>();
  private maxUniqueErrors = 128;

  reportError(message: string): void {
    const key = message.replace(/\d+/g, "N");

    const count = this.errors.get(key) ?? 0;
    if (count >= this.maxUniqueErrors) return;

    this.errors.set(key, count + 1);

    if (count === 0) {
      console.error(`[RenderError] ${message}`);
    } else {
      console.warn(`[RenderError] ${message} (repeated ${count + 1} times)`);
    }
  }
}
```

### How Deduplication Works

```
Error 1: "Buffer size 1024 is not aligned" -> logged as ERROR
Error 2: "Buffer size 2048 is not aligned" -> same pattern -> logged as WARN (2 times)
Error 3: "Buffer size 4096 is not aligned" -> same pattern -> logged as WARN (3 times)
...
Error 129: -> silently dropped (maxUniqueErrors reached)
```

The first occurrence is logged as an error. Subsequent identical errors are counted and
logged as warnings. After 128 unique errors, new errors are silently dropped.

### Message Normalization

Numbers are replaced with "N" to group similar errors:

```
Original: "Buffer size 1024 is not aligned to 256"
Normalized: "Buffer size N is not aligned to N"

Original: "Buffer size 2048 is not aligned to 256"
Normalized: "Buffer size N is not aligned to N"  (same key)
```

---

## Uncaptured Error Dedup

Some errors bypass error scopes. We hook the global error handler:

```typescript
function installWebGpuErrorDedupe(device: GPUDevice): void {
  device.addEventListener("uncapturederror", (event) => {
    event.preventDefault();
    diagnostics.reportError(event.error.message);
  });
}
```

### Why preventDefault?

Without `preventDefault()`, the browser prints the error to the console automatically.
Our deduplication system handles it instead, preventing log flooding.

```
Without preventDefault:
  [WebGPU] ERROR: Buffer size 1024 is not aligned (printed 60 times per second)

With preventDefault:
  [RenderError] Buffer size N is not aligned to N (logged once, counted thereafter)
```

---

## Putting It All Together

The infrastructure layer provides:

```
1. Capability probing -> can we use compute shaders?
2. Backend selection -> webgpu or webgl2?
3. Error scopes -> catch validation errors safely
4. Error deduplication -> prevent console flooding
5. Uncaptured error handling -> catch everything else
```

Each layer handles a different failure mode. Together, they ensure the renderer degrades
gracefully instead of crashing.

---

## Key Takeaways

1. **Capability probing** -- check WebGPU, compute shaders, required features
2. **Graceful fallback** -- try requested backend, fall back to CPU if needed
3. **Error scopes** -- pushErrorScope/popErrorScope for safe pipeline creation
4. **Error deduplication** -- normalize messages, count repeats, cap at 128 unique
5. **Uncaptured errors** -- hook device error event with preventDefault

---

[Previous: Rendering Pipeline](./10-rendering-pipeline.md) | [Next: Dirty Tracking](./12-dirty-tracking.md)
