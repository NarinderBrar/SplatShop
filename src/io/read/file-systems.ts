/**
 * File system implementations for reading splat data from various sources.
 *
 * Ported from SuperSplat's `src/io/read/file-systems.ts`. Keep this close to
 * upstream so loader behavior stays compatible while BabySplat replaces the
 * PlayCanvas runtime with Babylon.js.
 */

import {
  BufferedReadStream,
  type ReadFileSystem,
  type ReadSource,
  ReadStream,
  UrlReadFileSystem,
} from "@playcanvas/splat-transform";

const BLOB_CHUNK_SIZE = 4 * 1024 * 1024;

class BlobReadStream extends ReadStream {
  private readonly blob: Blob;
  private offset: number;
  private readonly end: number;

  constructor(blob: Blob, start: number, end: number) {
    super(end - start);
    this.blob = blob;
    this.offset = start;
    this.end = end;
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
    return bytesToRead;
  }
}

class BlobReadSource implements ReadSource {
  readonly size: number;
  readonly seekable = true;

  private readonly blob: Blob;
  private closed = false;

  constructor(blob: Blob) {
    this.blob = blob;
    this.size = blob.size;
  }

  read(start = 0, end = this.size): ReadStream {
    if (this.closed) {
      throw new Error("Source has been closed");
    }

    const clampedStart = Math.max(0, Math.min(start, this.size));
    const clampedEnd = Math.max(clampedStart, Math.min(end, this.size));
    const raw = new BlobReadStream(this.blob, clampedStart, clampedEnd);
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

  createSource(filename: string): Promise<ReadSource> {
    const blob = this.files.get(filename.toLowerCase());
    if (!blob) {
      return Promise.reject(new Error(`File not found: ${filename}`));
    }
    return Promise.resolve(new BlobReadSource(blob));
  }
}

class MappedReadFileSystem implements ReadFileSystem {
  private readonly blobFs: BlobReadFileSystem;
  private readonly urlFs: UrlReadFileSystem;

  constructor(baseUrl?: string) {
    this.blobFs = new BlobReadFileSystem();
    this.urlFs = new UrlReadFileSystem(baseUrl);
  }

  addFile(name: string, blob: Blob): void {
    this.blobFs.set(name, blob);
  }

  async createSource(filename: string): Promise<ReadSource> {
    const localBlob = this.blobFs.get(filename);
    if (localBlob) {
      return new BlobReadSource(localBlob);
    }

    return await this.urlFs.createSource(filename);
  }
}

export { BlobReadSource, MappedReadFileSystem };
