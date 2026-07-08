/**
 * File system implementations for reading splat data from various sources.
 *
 * Ported from SuperSplat's `src/io/read/file-systems.ts`. Keep this close to
 * upstream so loader behavior stays compatible while SplatShop replaces the
 * PlayCanvas runtime with Babylon.js.
 */

import {
  BufferedReadStream,
  type ProgressCallback,
  type ReadFileSystem,
  type ReadSource,
  ReadStream,
  UrlReadFileSystem,
} from "@playcanvas/splat-transform";

const BLOB_CHUNK_SIZE = 4 * 1024 * 1024;

type ReadProgressEvent = {
  filename: string;
  bytesLoaded: number;
  totalBytes: number | undefined;
  source: "blob" | "url";
};

type ReadProgressCallback = (event: ReadProgressEvent) => void;

class BlobReadStream extends ReadStream {
  private readonly blob: Blob;
  private offset: number;
  private readonly end: number;
  private readonly progress?: ProgressCallback;

  constructor(blob: Blob, start: number, end: number, progress?: ProgressCallback) {
    super(end - start);
    this.blob = blob;
    this.offset = start;
    this.end = end;
    this.progress = progress;
  }

  async pull(target: Uint8Array): Promise<number> {
    const remaining = this.end - this.offset;
    if (remaining <= 0) {
      return 0;
    }

    const bytesToRead = Math.min(target.length, remaining);
    const slice = this.blob.slice(this.offset, this.offset + bytesToRead);
    const arrayBuffer = await slice.arrayBuffer();
    target.set(new Uint8Array(arrayBuffer));
    this.offset += bytesToRead;
    this.bytesRead += bytesToRead;
    this.progress?.(this.bytesRead, this.expectedSize);
    return bytesToRead;
  }
}

class BlobReadSource implements ReadSource {
  readonly size: number;
  readonly seekable = true;

  private readonly blob: Blob;
  private readonly progress?: ProgressCallback;
  private closed = false;

  constructor(blob: Blob, progress?: ProgressCallback) {
    this.blob = blob;
    this.progress = progress;
    this.size = blob.size;
  }

  read(start = 0, end = this.size): ReadStream {
    if (this.closed) {
      throw new Error("Source has been closed");
    }

    const clampedStart = Math.max(0, Math.min(start, this.size));
    const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));
    const raw = new BlobReadStream(this.blob, clampedStart, clampedEnd, this.progress);
    return new BufferedReadStream(raw, BLOB_CHUNK_SIZE);
  }

  close(): void {
    this.closed = true;
  }
}

class BlobReadFileSystem implements ReadFileSystem {
  private readonly files: Map<string, Blob> = new Map();

  set(name: string, blob: Blob): void {
    this.files.set(name.toLowerCase(), blob);
  }

  get(name: string): Blob | undefined {
    return this.files.get(name.toLowerCase());
  }

  createSource(filename: string, progress?: ProgressCallback): Promise<ReadSource> {
    const blob = this.files.get(filename.toLowerCase());
    if (!blob) {
      return Promise.reject(new Error(`File not found: ${filename}`));
    }
    return Promise.resolve(new BlobReadSource(blob, progress));
  }
}

class MappedReadFileSystem implements ReadFileSystem {
  private readonly blobFs: BlobReadFileSystem;
  private readonly urlFs: UrlReadFileSystem;

  constructor(baseUrl?: string, private readonly onProgress?: ReadProgressCallback) {
    this.blobFs = new BlobReadFileSystem();
    this.urlFs = new UrlReadFileSystem(baseUrl);
  }

  addFile(name: string, blob: Blob): void {
    this.blobFs.set(name, blob);
  }

  async createSource(filename: string, progress?: ProgressCallback): Promise<ReadSource> {
    const report = (source: ReadProgressEvent["source"]): ProgressCallback => (bytesLoaded, totalBytes) => {
      progress?.(bytesLoaded, totalBytes);
      this.onProgress?.({
        filename,
        bytesLoaded,
        totalBytes,
        source,
      });
    };

    const localBlob = this.blobFs.get(filename);
    if (localBlob) {
      return new BlobReadSource(localBlob, report("blob"));
    }

    return await this.urlFs.createSource(filename, report("url"));
  }
}

export { BlobReadSource, MappedReadFileSystem };
export type { ReadProgressCallback, ReadProgressEvent };
