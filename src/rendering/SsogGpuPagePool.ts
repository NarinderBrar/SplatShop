type SsogGpuPageAllocation = {
  pages: number[];
  spans: SsogGpuPageSpan[];
  overflowPages: number;
  splats: number;
};

type SsogGpuPageSpan = {
  page: number;
  pageOffset: number;
  chunkOffset: number;
  count: number;
};

type SsogGpuPagePoolStats = {
  pageCapacitySplats: number;
  totalPages: number;
  usedPages: number;
  freePages: number;
  neededPages: number;
  freeablePages: number;
  largestFreeRun: number;
  fragmentation: number;
  allocatedChunks: number;
  residentSplats: number;
  overflowChunks: number;
  overflowPages: number;
  pressure: number;
  allocationRequests: number;
  overflowAllocationRequests: number;
  freedPages: number;
  reusedKeys: number;
};

class SsogGpuPagePool {
  private readonly pageOwners: Array<string | undefined>;
  private readonly chunkPages = new Map<string, SsogGpuPageAllocation>();
  private residentSplats = 0;
  private neededPages = 0;
  private freeablePages = 0;
  private allocationRequests = 0;
  private overflowAllocationRequests = 0;
  private freedPages = 0;
  private reusedKeys = 0;

  constructor(private readonly pageCapacitySplats: number, pageCount: number) {
    this.pageOwners = new Array(Math.max(1, pageCount));
  }

  allocateChunk(key: string, splats: number): SsogGpuPageAllocation {
    if (this.chunkPages.has(key)) {
      this.reusedKeys++;
      this.freeChunk(key);
    }
    this.allocationRequests++;

    const requiredPages = this.getRequiredPages(splats);
    const pages: number[] = [];
    for (let index = 0; index < this.pageOwners.length && pages.length < requiredPages; index++) {
      if (this.pageOwners[index] === undefined) {
        this.pageOwners[index] = key;
        pages.push(index);
      }
    }

    const allocation: SsogGpuPageAllocation = {
      pages,
      spans: this.createPageSpans(pages, splats),
      overflowPages: requiredPages - pages.length,
      splats,
    };
    if (allocation.overflowPages > 0) {
      this.overflowAllocationRequests++;
    }
    this.chunkPages.set(key, allocation);
    this.residentSplats += splats;
    return allocation;
  }

  canAllocate(splats: number): boolean {
    return this.getFreePageCount() >= this.getRequiredPages(splats);
  }

  getRequiredPages(splats: number): number {
    return Math.max(1, Math.ceil(splats / this.pageCapacitySplats));
  }

  getPageCapacitySplats(): number {
    return this.pageCapacitySplats;
  }

  getFreePageCount(): number {
    let freePages = 0;
    this.pageOwners.forEach((owner) => {
      if (owner === undefined) {
        freePages++;
      }
    });
    return freePages;
  }

  updateNeededChunks(neededKeys: ReadonlySet<string>): void {
    let neededPages = 0;
    let freeablePages = 0;
    this.chunkPages.forEach((allocation, key) => {
      if (neededKeys.has(key)) {
        neededPages += allocation.pages.length + allocation.overflowPages;
      } else {
        freeablePages += allocation.pages.length + allocation.overflowPages;
      }
    });
    this.neededPages = neededPages;
    this.freeablePages = freeablePages;
  }

  freeChunk(key: string): void {
    const allocation = this.chunkPages.get(key);
    if (!allocation) {
      return;
    }

    for (const page of allocation.pages) {
      if (this.pageOwners[page] === key) {
        this.pageOwners[page] = undefined;
        this.freedPages++;
      }
    }
    this.residentSplats -= allocation.splats;
    this.chunkPages.delete(key);
  }

  clear(): void {
    this.pageOwners.fill(undefined);
    this.chunkPages.clear();
    this.residentSplats = 0;
    this.neededPages = 0;
    this.freeablePages = 0;
  }

  getStats(): SsogGpuPagePoolStats {
    let usedPages = 0;
    let freePages = 0;
    let currentFreeRun = 0;
    let largestFreeRun = 0;
    this.pageOwners.forEach((owner) => {
      if (owner !== undefined) {
        usedPages++;
        currentFreeRun = 0;
      } else {
        freePages++;
        currentFreeRun++;
        largestFreeRun = Math.max(largestFreeRun, currentFreeRun);
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
      freePages,
      neededPages: this.neededPages,
      freeablePages: this.freeablePages,
      largestFreeRun,
      fragmentation: freePages <= 0 ? 0 : 1 - largestFreeRun / freePages,
      allocatedChunks: this.chunkPages.size,
      residentSplats: this.residentSplats,
      overflowChunks,
      overflowPages,
      pressure: usedPages / Math.max(1, this.pageOwners.length),
      allocationRequests: this.allocationRequests,
      overflowAllocationRequests: this.overflowAllocationRequests,
      freedPages: this.freedPages,
      reusedKeys: this.reusedKeys,
    };
  }

  private createPageSpans(pages: number[], splats: number): SsogGpuPageSpan[] {
    const spans: SsogGpuPageSpan[] = [];
    for (let index = 0; index < pages.length; index++) {
      const chunkOffset = index * this.pageCapacitySplats;
      const count = Math.max(0, Math.min(this.pageCapacitySplats, splats - chunkOffset));
      if (count <= 0) {
        break;
      }
      spans.push({
        page: pages[index],
        pageOffset: 0,
        chunkOffset,
        count,
      });
    }
    return spans;
  }
}

export { SsogGpuPagePool };
export type { SsogGpuPageAllocation, SsogGpuPagePoolStats, SsogGpuPageSpan };
