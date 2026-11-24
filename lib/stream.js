/**
 * Byte-exact reading from a child process stdout stream.
 *
 * Frames travel as a length-prefixed binary stream inside one ssh pipe (a PPM file is ~3 MB,
 * so a textual protocol or base64 would waste most of the bandwidth and all of the memory).
 * This reader turns a Readable into `readLine()` / `readExactly(n)` calls, keeping the
 * remainder buffered — the state machine of the frame protocol lives in the caller.
 */

export class ByteStream {
  /**
   * @param {import('node:stream').Readable} readable the child stdout.
   */
  constructor(readable) {
    this.readable = readable;
    this.iterator = readable[Symbol.asyncIterator]();
    this.parts = [];
    this.length = 0;
    this.ended = false;
    this.total = 0;
  }

  /**
   * Pull chunks until at least `bytes` are buffered (or the stream ends).
   * @param {number} bytes wanted amount.
   * @returns {Promise<void>} resolves when enough data arrived or the stream ended.
   */
  async #fill(bytes) {
    while (this.length < bytes && !this.ended) {
      const next = await this.iterator.next();
      if (next.done === true) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.total += chunk.length;
      this.parts.push(chunk);
      this.length += chunk.length;
    }
  }

  /**
   * Everything buffered so far, as one buffer.
   * @returns {Buffer} the buffered bytes (a view, not a copy, when there is one part).
   */
  #joined() {
    if (this.parts.length === 1) return this.parts[0];
    const joined = Buffer.concat(this.parts, this.length);
    this.parts = [joined];
    return joined;
  }

  /**
   * Read exactly `bytes` bytes.
   * @param {number} bytes amount.
   * @returns {Promise<Buffer>} the bytes; shorter than asked only when the stream ended.
   */
  async readExactly(bytes) {
    await this.#fill(bytes);
    if (this.length === 0) return Buffer.alloc(0);
    const take = Math.min(bytes, this.length);
    const joined = this.#joined();
    const result = joined.subarray(0, take);
    const rest = joined.subarray(take);
    this.parts = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return result;
  }

  /**
   * Read one line terminated by `\n` (the newline is not returned).
   * @param {number} [maxBytes] guard against a runaway header.
   * @returns {Promise<string|null>} the line, or null at end of stream.
   */
  async readLine(maxBytes = 4096) {
    for (;;) {
      if (this.length > 0) {
        const joined = this.#joined();
        const index = joined.indexOf(0x0a);
        if (index !== -1) {
          const line = joined.subarray(0, index).toString('utf8');
          const rest = joined.subarray(index + 1);
          this.parts = rest.length > 0 ? [rest] : [];
          this.length = rest.length;
          return line;
        }
        if (joined.length > maxBytes) {
          throw new Error(`protocol error: line longer than ${maxBytes} bytes`);
        }
      }
      if (this.ended) {
        if (this.length === 0) return null;
        const tail = this.#joined().toString('utf8');
        this.parts = [];
        this.length = 0;
        return tail;
      }
      await this.#fill(this.length + 1);
    }
  }

  /**
   * Read the rest of the stream.
   * @returns {Promise<Buffer>} all remaining bytes.
   */
  async readAll() {
    await this.#fill(Number.MAX_SAFE_INTEGER);
    const joined = this.#joined();
    this.parts = [];
    this.length = 0;
    return joined;
  }
}
