type SsogGpuPageAllocation = {
  pages: number[];
  overflowPages: number;
  splats: number;
};

type SsogGpuPagePoolStats = {
  pageCapacitySplats: number;
  totalPages: number;
  usedPages: number;
  freePages: number;
  allocatedChunks: number;
  residentSplats: number;
  overflowChunks: number;
  overflowPages: number;
  pressure: number;
};

class SsogGpuPagePool {
  private readonly pageOwners: Array<string | undefined>;
  private readonly chunkPages = new Map<string, SsogGpuPageAllocation>();
  private residentSplats = 0;

  constructor(private readonly pageCapacitySplats: number, pageCount: number) {
    this.pageOwners = new Array(Math.max(1, pageCount));
  }

  allocateChunk(key: string, splats: number): SsogGpuPageAllocation {
    this.freeChunk(key);

    const requiredPages = Math.max(1, Math.ceil(splats / this.pageCapacitySplats));
    const pages: number[] = [];
    for (let index = 0; index < this.pageOwners.length && pages.length < requiredPages; index++) {
      if (this.pageOwners[index] === undefined) {
        this.pageOwners[index] = key;
        pages.push(index);
      }
    }

    const allocation: SsogGpuPageAllocation = {
      pages,
      overflowPages: requiredPages - pages.length,
      splats,
    };
    this.chunkPages.set(key, allocation);
    this.residentSplats += splats;
    return allocation;
  }

  freeChunk(key: string): void {
    const allocation = this.chunkPages.get(key);
    if (!allocation) {
      return;
    }

    for (const page of allocation.pages) {
      if (this.pageOwners[page] === key) {
        this.pageOwners[page] = undefined;
      }
    }
    this.residentSplats -= allocation.splats;
    this.chunkPages.delete(key);
  }

  clear(): void {
    this.pageOwners.fill(undefined);
    this.chunkPages.clear();
    this.residentSplats = 0;
  }

  getStats(): SsogGpuPagePoolStats {
    let usedPages = 0;
    this.pageOwners.forEach((owner) => {
      if (owner !== undefined) {
        usedPages++;
      }
    });

    let overflowChunks = 0;
    let overflowPages = 0;
    this.chunkPages.forEach((allocation) => {
      if (allocation.overflowPages > 0) {
        overflowChunks++;
        overflowPages += allocation.overflowPages;
      }
    });

    return {
      pageCapacitySplats: this.pageCapacitySplats,
      totalPages: this.pageOwners.length,
      usedPages,
      freePages: this.pageOwners.length - usedPages,
      allocatedChunks: this.chunkPages.size,
      residentSplats: this.residentSplats,
      overflowChunks,
      overflowPages,
      pressure: usedPages / Math.max(1, this.pageOwners.length),
    };
  }
}

export { SsogGpuPagePool };
export type { SsogGpuPageAllocation, SsogGpuPagePoolStats };
