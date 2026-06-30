type TypedArrayPoolStats = {
  freeArrays: number;
  checkedOutArrays: number;
  totalBytes: number;
  peakBytes: number;
  allocationCount: number;
  reuseCount: number;
};

type TypedArrayConstructor<T extends ArrayBufferView> = {
  new (length: number): T;
  readonly BYTES_PER_ELEMENT: number;
};

type TypedArrayLease<T extends ArrayBufferView> = {
  array: T;
  release: () => void;
};

class TypedArrayPool<T extends ArrayBufferView> {
  private readonly free: T[] = [];
  private readonly checkedOut = new Set<T>();
  private totalBytes = 0;
  private peakBytes = 0;
  private allocationCount = 0;
  private reuseCount = 0;

  constructor(private readonly ArrayType: TypedArrayConstructor<T>) {}

  acquire(length: number): TypedArrayLease<T> {
    const requestedLength = Math.max(1, Math.floor(length));
    const freeIndex = this.free.findIndex((array) => array.byteLength >= requestedLength * this.ArrayType.BYTES_PER_ELEMENT);
    const array = freeIndex >= 0 ? this.free.splice(freeIndex, 1)[0] : new this.ArrayType(roundUpPowerOfTwo(requestedLength));

    if (freeIndex >= 0) {
      this.reuseCount++;
    } else {
      this.allocationCount++;
      this.totalBytes += array.byteLength;
      this.peakBytes = Math.max(this.peakBytes, this.totalBytes);
    }

    this.checkedOut.add(array);
    let released = false;
    return {
      array,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.checkedOut.delete(array);
        this.free.push(array);
      },
    };
  }

  clear(): void {
    this.free.length = 0;
    this.checkedOut.clear();
    this.totalBytes = 0;
  }

  getStats(): TypedArrayPoolStats {
    return {
      freeArrays: this.free.length,
      checkedOutArrays: this.checkedOut.size,
      totalBytes: this.totalBytes,
      peakBytes: this.peakBytes,
      allocationCount: this.allocationCount,
      reuseCount: this.reuseCount,
    };
  }
}

const roundUpPowerOfTwo = (value: number): number => {
  let result = 1;
  while (result < value) {
    result *= 2;
  }
  return result;
};

export { TypedArrayPool };
export type { TypedArrayLease, TypedArrayPoolStats };
