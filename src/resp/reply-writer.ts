const INITIAL = 4096;
const CRLF = '\r\n';

/**
 * Accumulates RESP2 replies for one batch of commands. Strings are written as
 * latin1, the same encoding the parser uses, so bytes round-trip unchanged.
 */
export class ReplyWriter {
  private buf = Buffer.allocUnsafe(INITIAL);
  private len = 0;

  get length(): number {
    return this.len;
  }

  simple(s: string): void {
    this.latin1('+' + s + CRLF);
  }

  /**
   * The message starts with its class, for example `ERR syntax error`. Line
   * breaks are replaced, because a message can echo client input and a CRLF
   * in it would end the reply early.
   */
  error(s: string): void {
    this.latin1('-' + s.replace(/[\r\n]/g, ' ') + CRLF);
  }

  int(n: number | bigint): void {
    this.latin1(':' + n.toString() + CRLF);
  }

  bulk(s: string): void {
    this.latin1('$' + s.length + CRLF);
    this.latin1(s);
    this.latin1(CRLF);
  }

  null(): void {
    this.latin1('$-1\r\n');
  }

  nullArray(): void {
    this.latin1('*-1\r\n');
  }

  array(n: number): void {
    this.latin1('*' + n + CRLF);
  }

  /** Writes args in command form, which is also the AOF's record format. */
  command(args: readonly string[]): void {
    this.array(args.length);
    for (const a of args) this.bulk(a);
  }

  /**
   * Returns everything written so far and empties the writer. The result is
   * never written to again, so it can be handed to a socket.
   */
  take(): Buffer | null {
    if (this.len === 0) return null;
    let out: Buffer;
    if (this.len <= INITIAL) {
      // Small replies are copied into Node's pooled memory and the buffer kept.
      out = Buffer.from(this.buf.subarray(0, this.len));
    } else {
      out = this.buf.subarray(0, this.len);
      this.buf = Buffer.allocUnsafe(INITIAL);
    }
    this.len = 0;
    return out;
  }

  /** Empties the writer without returning anything. */
  reset(): void {
    this.len = 0;
  }

  private latin1(s: string): void {
    if (s.length === 0) return;
    this.reserve(s.length);
    this.len += this.buf.write(s, this.len, 'latin1');
  }

  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(
      Math.max(this.buf.length * 2, this.len + n),
    );
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
}

/** Encodes one command, for the AOF and for pub/sub messages. */
export function encodeCommand(args: readonly string[]): Buffer {
  const w = new ReplyWriter();
  w.command(args);
  return w.take() as Buffer;
}
