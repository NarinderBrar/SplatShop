type RenderDiagnosticStats = {
  totalErrors: number;
  uniqueErrors: number;
  suppressedErrors: number;
  lastKind: string;
  lastMessage: string;
  lastCount: number;
};

const MAX_MESSAGE_LENGTH = 240;
const MAX_UNIQUE_ERRORS = 128;

class RenderDiagnostics {
  private readonly errors = new Map<string, { count: number; lastSeenFrame: number }>();
  private frame = 0;
  private totalErrors = 0;
  private suppressedErrors = 0;
  private lastKind = "";
  private lastMessage = "";
  private lastCount = 0;

  beginFrame(): void {
    this.frame++;
  }

  reportError(kind: string, error: unknown, log: (message: string, error?: unknown) => void = console.warn): void {
    const message = this.normalizeMessage(error);
    const key = `${kind}:${message}`;
    const existing = this.errors.get(key);
    this.totalErrors++;
    this.lastKind = kind;
    this.lastMessage = message;

    if (existing) {
      existing.count++;
      existing.lastSeenFrame = this.frame;
      this.suppressedErrors++;
      this.lastCount = existing.count;
      return;
    }

    if (this.errors.size >= MAX_UNIQUE_ERRORS) {
      const oldest = Array.from(this.errors.entries()).sort(
        (a, b) => a[1].lastSeenFrame - b[1].lastSeenFrame,
      )[0]?.[0];
      if (oldest) {
        this.errors.delete(oldest);
      }
    }

    this.errors.set(key, { count: 1, lastSeenFrame: this.frame });
    this.lastCount = 1;
    log(`[${kind}] ${message}`, error);
  }

  getStats(): RenderDiagnosticStats {
    return {
      totalErrors: this.totalErrors,
      uniqueErrors: this.errors.size,
      suppressedErrors: this.suppressedErrors,
      lastKind: this.lastKind,
      lastMessage: this.lastMessage,
      lastCount: this.lastCount,
    };
  }

  private normalizeMessage(error: unknown): string {
    const raw =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message)
          : String(error);
    return raw.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);
  }
}

const renderDiagnostics = new RenderDiagnostics();

const installWebGpuErrorDedupe = (engine: unknown): void => {
  const device = (engine as { _device?: GPUDevice })._device;
  if (!device || (device as unknown as { __splatshopErrorDedupe?: boolean }).__splatshopErrorDedupe) {
    return;
  }

  (device as unknown as { __splatshopErrorDedupe: boolean }).__splatshopErrorDedupe = true;
  device.addEventListener("uncapturederror", (event: GPUUncapturedErrorEvent) => {
    event.preventDefault();
    renderDiagnostics.reportError("webgpu-uncaptured", event.error);
  });
}

export { installWebGpuErrorDedupe, renderDiagnostics };
export type { RenderDiagnosticStats };
