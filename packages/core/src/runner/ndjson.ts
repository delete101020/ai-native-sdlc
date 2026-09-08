/**
 * Line-delimited stdout plumbing, shared by every CLI runner.
 *
 * Both `claude --output-format stream-json` and `codex exec --json` emit one
 * JSON object per line, and both arrive in arbitrarily-sized chunks that split
 * mid-line. That buffering is the only thing the two runners genuinely have in
 * common, so it lives here: a second CLI runner is then argument shaping plus
 * an event mapper, not a rewrite of the transport.
 *
 * See MULTI_PROVIDER_ALIGNMENT.md §P1.
 */

export interface LineSink {
  /** Feed a stdout chunk. Complete lines are dispatched; the tail is kept. */
  push(chunk: string): void;
  /** Dispatch whatever is left in the buffer (call on `close`). */
  flush(): void;
}

/** Split an incoming byte stream into lines, tolerating chunk boundaries. */
export function createLineSink(onLine: (line: string) => void): LineSink {
  let buf = '';
  return {
    push(chunk: string): void {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    flush(): void {
      if (buf.length) {
        const rest = buf;
        buf = '';
        onLine(rest);
      }
    },
  };
}

/**
 * Line sink that parses each line as JSON.
 *
 * `onRaw` decides what happens to a line that is not JSON. Both runners pass it
 * straight through to the terminal rather than dropping it: a CLI that has
 * changed its output format, or printed a warning to stdout, should be visible
 * to the user instead of silently swallowed.
 */
export function createJsonSink<T>(
  onEvent: (evt: T) => void,
  onRaw: (line: string) => void,
): LineSink {
  return createLineSink((line) => {
    const trimmed = line.trim();
    if (!trimmed) { return; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onRaw(line);
      return;
    }
    onEvent(parsed as T);
  });
}
