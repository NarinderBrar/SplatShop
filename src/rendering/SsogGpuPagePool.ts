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
  private freePages: number;
  private overflowChunks = 0;
  private overflowPages = 0;
  private residentSplats = 0;
  private neededPages = 0;
  private freeablePages = 0;
  private allocationRequests = 0;
  private overflowAllocationRequests = 0;
  private freedPages = 0;
  private reusedKeys = 0;
  private statsDirty = true;
  private cachedStats?: SsogGpuPagePoolStats;

  constructor(private readonly pageCapacitySplats: number, pageCount: number) {
    this.pageOwners = new Array(Math.max(1, pageCount));
    this.freePages = this.pageOwners.length;
  }

  allocateChunk(key: string, splats: number): SsogGpuPageAllocation {
    if (this.chunkPages.has(key)) {
      this.reusedKeys++;
      this.freeChunk(key);
    }
    this.allocationRequests++;
    this.statsDirty = true;

    const requiredPages = this.getRequiredPages(splats);
    const pages: number[] = [];
    for (let index = 0; index < this.pageOwners.length && pages.length < requiredPages; index++) {
      if (this.pageOwners[index] === undefined) {
        this.pageOwners[index] = key;
        pages.push(index);
        this.freePages--;
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
      this.overflowChunks++;
      this.overflowPages += allocation.overflowPages;
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
    return this.freePages;
  }

  getOverflowPageCount(): number {
    return this.overflowPages;
  }

  getPressure(): number {
    return (this.pageOwners.length - this.freePages) / Math.max(1, this.pageOwners.length);
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
    this.statsDirty = true;
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
        this.freePages++;
      }
    }
    if (allocation.overflowPages > 0) {
      this.overflowChunks--;
      this.overflowPages -= allocation.overflowPages;
    }
    this.residentSplats -= allocation.splats;
    this.chunkPages.delete(key);
    this.statsDirty = true;
  }

  clear(): void {
    this.pageOwners.fill(undefined);
    this.chunkPages.clear();
    this.freePages = this.pageOwners.length;
    this.overflowChunks = 0;
    this.overflowPages = 0;
    this.residentSplats = 0;
    this.neededPages = 0;
    this.freeablePages = 0;
    this.statsDirty = true;
  }

  getStats(): SsogGpuPagePoolStats {
    if (!this.statsDirty && this.cachedStats) {
      return this.cachedStats;
    }

    let currentFreeRun = 0;
    let largestFreeRun = 0;
    for (let index = 0; index < this.pageOwners.length; index++) {
      const owner = this.pageOwners[index];
      if (owner !== undefined) {
        currentFreeRun = 0;
      } else {
        currentFreeRun++;
        largestFreeRun = Math.max(largestFreeRun, currentFreeRun);
      }
    }
    const usedPages = this.pageOwners.length - this.freePages;
    this.cachedStats = {
      pageCapacitySplats: this.pageCapacitySplats,
      totalPages: this.pageOwners.length,
      usedPages,
      freePages: this.freePages,
      neededPages: this.neededPages,
      freeablePages: this.freeablePages,
      largestFreeRun,
      fragmentation: this.freePages <= 0 ? 0 : 1 - largestFreeRun / this.freePages,
      allocatedChunks: this.chunkPages.size,
      residentSplats: this.residentSplats,
      overflowChunks: this.overflowChunks,
      overflowPages: this.overflowPages,
      pressure: usedPages / Math.max(1, this.pageOwners.length),
      allocationRequests: this.allocationRequests,
      overflowAllocationRequests: this.overflowAllocationRequests,
      freedPages: this.freedPages,
      reusedKeys: this.reusedKeys,
    };
    this.statsDirty = false;
    return this.cachedStats;
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
export type { SsogGpuPageAllocation, SsogGpuPageSpan, SsogGpuPagePoolStats };
