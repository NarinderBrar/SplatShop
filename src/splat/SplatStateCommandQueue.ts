type SplatStateCommandType = "selection" | "edit" | "readback";

type SplatStateCommandStats = {
  enqueued: number;
  completed: number;
  failed: number;
  pending: number;
  running: boolean;
  lastCommandType: SplatStateCommandType | "none";
  lastCommandMs: number;
};

type SplatStateCommand<T> = {
  type: SplatStateCommandType;
  run: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

class SplatStateCommandQueue {
  private readonly commands: SplatStateCommand<unknown>[] = [];
  private disposed = false;
  private running = false;
  private enqueued = 0;
  private completed = 0;
  private failed = 0;
  private lastCommandType: SplatStateCommandType | "none" = "none";
  private lastCommandMs = 0;

  enqueue<T>(type: SplatStateCommandType, run: () => Promise<T> | T): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Splat state command queue is disposed."));
    }

    this.enqueued++;
    return new Promise<T>((resolve, reject) => {
      this.commands.push({
        type,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.pump();
    });
  }

  dispose(): void {
    this.disposed = true;
    const error = new Error("Splat state command queue is disposed.");
    while (this.commands.length > 0) {
      this.commands.shift()?.reject(error);
    }
  }

  getStats(): SplatStateCommandStats {
    return {
      enqueued: this.enqueued,
      completed: this.completed,
      failed: this.failed,
      pending: this.commands.length,
      running: this.running,
      lastCommandType: this.lastCommandType,
      lastCommandMs: this.lastCommandMs,
    };
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (!this.disposed && this.commands.length > 0) {
        const command = this.commands.shift();
        if (!command) {
          continue;
        }

        const start = performance.now();
        this.lastCommandType = command.type;
        try {
          const result = await command.run();
          this.lastCommandMs = performance.now() - start;
          this.completed++;
          command.resolve(result);
        } catch (error) {
          this.lastCommandMs = performance.now() - start;
          this.failed++;
          command.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (!this.disposed && this.commands.length > 0) {
        void this.pump();
      }
    }
  }
}

export { SplatStateCommandQueue };
export type { SplatStateCommandStats, SplatStateCommandType };
