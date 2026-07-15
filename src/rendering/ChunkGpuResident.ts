import { SogBuffers } from "../splat/SogBuffers";
import type { SsogGpuPageAllocation as PageAllocation } from "./SsogGpuPagePool";

export type { PageAllocation };

export class ChunkGpuResident {
  constructor(
    readonly buffers: SogBuffers,
    readonly pageAllocation: PageAllocation,
  ) {}

  dispose(): void {
    this.buffers.dispose();
  }
}
