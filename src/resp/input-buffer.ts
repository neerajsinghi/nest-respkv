const INITIAL = 16 * 1024;
const MAX_IDLE = 1024 * 1024;

/**
 * Holds bytes a connection has received but not yet parsed.
 *
 * The common case, a chunk that contains only complete commands, is parsed
 * straight from the socket's own Buffer without a copy. Only a partial command
 * left over at the end of a chunk is copied into an owned, growable buffer.
 */
export class InputBuffer {
  buf: Buffer = Buffer.alloc(0);
  start = 0;
  end = 0;
  private owned = false;

  get length(): number {
    return this.end - this.start;
  }

  append(chunk: Buffer): void {
    if (this.length === 0) {
      this.buf = chunk;
      this.start = 0;
      this.end = chunk.length;
      this.owned = false;
      return;
    }
    const needed = this.length + chunk.length;
    if (!this.owned || this.end + chunk.length > this.buf.length) {
      const size =
        this.owned && needed <= this.buf.length
          ? this.buf.length
          : Math.max(INITIAL, needed * 2);
      const next =
        size === this.buf.length ? this.buf : Buffer.allocUnsafe(size);
      this.buf.copy(next, 0, this.start, this.end);
      this.buf = next;
      this.end = this.length;
      this.start = 0;
      this.owned = true;
    }
    chunk.copy(this.buf, this.end);
    this.end += chunk.length;
  }

  consume(n: number): void {
    this.start += n;
    if (this.start === this.end) {
      this.start = this.end = 0;
      if (!this.owned || this.buf.length > MAX_IDLE) {
        this.buf = Buffer.alloc(0);
        this.owned = false;
      }
    }
  }
}
