/**
 * Fetch recorded frames from the node in **one** ssh pipe, length-prefixed, and convert them here.
 *
 * The first implementation of this in the prototype pulled a tar stream, xz-compressed it and
 * unpacked it locally; that works but costs a full archive pass and rewrites the whole set every
 * time. The protocol below is per-frame and range-limited, so a 3000-frame recording can be read in
 * slices (`from`/`to`/`max`) instead of one 3000-frame stall (every frame is ~1.3 s of wall time to
 * convert and write, which is what the "progress" warning in the brief was about).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VmError } from './errors.js';
import { parsePpm, writeFrame } from './img.js';
import { ByteStream } from './stream.js';

/**
 * The node-side half: emit `F <idx> <size>\n` + frame bytes per selected frame, then
 * `T <size>\n` + times.csv, then `M <json>\n`.
 * @param {{dir:string, from:number, to:number}} spec selection.
 * @returns {string} bash script.
 */
export function fetchScript(spec) {
  return [
    'set -u',
    `export D='${spec.dir}'`,
    `export FROM=${spec.from}`,
    `export TO=${spec.to}`,
    `python3 - <<'PY'`,
    'import glob, json, os, sys',
    'd = os.environ["D"]',
    'low = int(os.environ["FROM"])',
    'high = int(os.environ["TO"])',
    'out = sys.stdout.buffer',
    'files = []',
    'for path in sorted(glob.glob(os.path.join(d, "f*.ppm"))):',
    '    name = os.path.basename(path)',
    '    try:',
    '        index = int(name[1:6])',
    '    except ValueError:',
    '        continue',
    '    if index < low or index > high:',
    '        continue',
    '    files.append((index, path))',
    'sent = 0',
    'skipped = []',
    'for index, path in files:',
    '    try:',
    '        size = os.path.getsize(path)',
    '        data = open(path, "rb").read()',
    '    except OSError:',
    '        skipped.append(index)',
    '        continue',
    '    if len(data) != size or len(data) < 64:',
    '        skipped.append(index)',
    '        continue',
    '    out.write(("F %05d %d\\n" % (index, len(data))).encode())',
    '    out.write(data)',
    '    sent += 1',
    'times = os.path.join(d, "times.csv")',
    'try:',
    '    tb = open(times, "rb").read()',
    'except OSError:',
    '    tb = b""',
    'out.write(("T %d\\n" % len(tb)).encode())',
    'out.write(tb)',
    'meta = {"count": sent, "total": len(files), "skipped": skipped[:20],',
    '        "first": files[0][0] if files else None, "last": files[-1][0] if files else None}',
    'out.write(("M %s\\n" % json.dumps(meta)).encode())',
    'out.flush()',
    'PY',
    '',
  ].join('\n');
}

/**
 * Percentile of a numeric list.
 * @param {number[]} values samples.
 * @param {number} p 0…1.
 * @returns {number|null} the percentile, or null for an empty list.
 */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

/**
 * Parse `times.csv` (`i,ms` per line).
 * @param {Buffer} buffer file bytes.
 * @returns {{intervals:number[], first_ms:number|null, last_ms:number|null, count:number}} timing.
 */
export function parseTimes(buffer) {
  const text = buffer.toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const [rawIndex, rawMs] = line.trim().split(',');
    const index = Number(rawIndex);
    const ms = Number(rawMs);
    if (!Number.isInteger(index) || !Number.isFinite(ms)) continue;
    rows.push({ index, ms });
  }
  rows.sort((a, b) => a.index - b.index);
  const intervals = [];
  for (let i = 1; i < rows.length; i += 1) intervals.push(rows[i].ms - rows[i - 1].ms);
  return {
    intervals,
    first_ms: rows.length > 0 ? rows[0].ms : null,
    last_ms: rows.length > 0 ? rows[rows.length - 1].ms : null,
    count: rows.length,
  };
}

/**
 * Fetch a range of frames, write them locally as images, and report the timing.
 * @param {{transport:object, node:string, vmid:number, burstDir:string, localDir:string, from:number, to:number, max:number, format:'jpeg'|'png', quality:number, spawn:(spec:object)=>object, cwd:string, signal?:AbortSignal, timeoutMs?:number}} options fetch options.
 * @returns {Promise<object>} the tool value.
 */
export async function fetchFrames(options) {
  const started = Date.now();
  const script = fetchScript({ dir: options.burstDir, from: options.from, to: options.to });
  await mkdir(options.localDir, { recursive: true });
  const stream = options.transport.stream(options.node, script, {
    maxBytes: 512 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 300000,
    signal: options.signal,
  });
  const reader = new ByteStream(stream.stdout);
  const written = [];
  let times = { intervals: [], first_ms: null, last_ms: null, count: 0 };
  let timesRaw = null;
  let meta = null;
  try {
    for (;;) {
      const line = await reader.readLine(512);
      if (line === null) break;
      if (line.startsWith('F ')) {
        const [, rawIndex, rawSize] = line.split(/\s+/);
        const index = Number(rawIndex);
        const size = Number(rawSize);
        if (!Number.isInteger(index) || !Number.isFinite(size) || size <= 0) {
          throw new VmError('FRAMES_MISSING', `protocol error: bad frame header "${line}"`);
        }
        if (written.length >= options.max) {
          // Skip the payload but keep the protocol in sync.
          await reader.readExactly(size);
          continue;
        }
        const data = await reader.readExactly(size);
        if (data.length !== size) {
          throw new VmError('FRAMES_MISSING', `short frame ${index}: ${data.length} of ${size} bytes`);
        }
        const image = parsePpm(data);
        const outPath = join(options.localDir, `f${String(index).padStart(5, '0')}.${options.format === 'jpeg' ? 'jpg' : 'png'}`);
        const result = await writeFrame(image, {
          outPath,
          format: options.format,
          quality: options.quality,
          spawn: options.spawn,
          cwd: options.cwd,
        });
        written.push({ index, path: result.path, bytes: result.bytes, format: result.format });
        continue;
      }
      if (line.startsWith('T ')) {
        const size = Number(line.slice(2));
        const data = await reader.readExactly(size);
        times = parseTimes(data);
        timesRaw = data;
        continue;
      }
      if (line.startsWith('M ')) {
        try {
          meta = JSON.parse(line.slice(2));
        } catch {
          meta = null;
        }
        continue;
      }
    }
    const outcome = await stream.finish(20000);
    if (outcome.code !== 0) {
      throw new VmError(
        'SSH_FAILED',
        `fetch ended with exit ${outcome.code}: ${outcome.stderr.trim().slice(0, 400)}`,
      );
    }
  } finally {
    if (stream.timedOut.value) stream.cancel();
  }
  if (written.length === 0) {
    throw new VmError(
      'FRAMES_MISSING',
      `no frames in ${options.burstDir} for the range ${options.from}…${options.to}` +
        (meta !== null ? ` (the directory holds ${meta.total} frames)` : ''),
    );
  }
  const skipped = meta?.skipped ?? [];
  const missing = [];
  for (let i = 1; i < written.length; i += 1) {
    if (written[i].index !== written[i - 1].index + 1) missing.push(written[i - 1].index + 1);
  }
  // The frames are useless without their timing: write the raw times.csv and a small manifest beside them,
  // so the folder can be re-cut into a video or inspected later without going back to the node.
  if (timesRaw !== null) await writeFile(join(options.localDir, 'times.csv'), timesRaw).catch(() => {});
  await writeFile(
    join(options.localDir, 'frames.json'),
    `${JSON.stringify(
      {
        vmid: options.vmid,
        node: options.node,
        burst: options.burstDir,
        fetched_at: new Date().toISOString(),
        range: { from: options.from, to: options.to, max: options.max },
        count: written.length,
        indices: { first: written[0].index, last: written[written.length - 1].index, missing },
        timing: { first_ms: times.first_ms, last_ms: times.last_ms, count: times.count },
        frames: written,
      },
      null,
      2,
    )}\n`,
  ).catch(() => {});
  return {
    ok: true,
    vmid: options.vmid,
    dir: options.localDir,
    count: written.length,
    format: written[0].format,
    first_index: written[0].index,
    last_index: written[written.length - 1].index,
    first_ms: times.first_ms,
    last_ms: times.last_ms,
    interval_p50_ms: percentile(times.intervals, 0.5),
    interval_p95_ms: percentile(times.intervals, 0.95),
    contiguous: missing.length === 0,
    missing: missing.slice(0, 10),
    skipped: skipped.slice(0, 10),
    total_on_node: meta?.total ?? null,
    truncated_by_max: meta !== null && meta.count > written.length,
    pattern: `${options.localDir}/f<NNNNN>.${written[0].format === 'jpeg' ? 'jpg' : 'png'}`,
    sample: written.slice(0, 3).map((frame) => frame.path),
    ms: Date.now() - started,
  };
}

/**
 * Read a local image back as base64 (for the `inline` option of `pve_screenshot`).
 * @param {string} path file path.
 * @returns {Promise<{data:string, bytes:number}>} base64 payload.
 */
export async function inlineImage(path) {
  const buffer = await readFile(path);
  return { data: buffer.toString('base64'), bytes: buffer.length };
}

/**
 * Write a small text file next to the frames (used for `times.csv`).
 * @param {string} path destination.
 * @param {Buffer} data bytes.
 * @returns {Promise<void>} completion.
 */
export async function writeSidecar(path, data) {
  await writeFile(path, data);
}
