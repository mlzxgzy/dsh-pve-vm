/**
 * Burst capture: a detached python recorder on the node, one QMP frame per tick.
 *
 * Three rules, all learned the hard way (playbook §5, re-measured 2026-11-24):
 *  1. the loop is **detached** (`setsid nohup … &`) so it survives the ssh call that started it —
 *     otherwise closing the pipe kills the recording halfway;
 *  2. it always ends by itself: a wall-clock cap (`burstMaxSeconds`) plus a STOP file, so a
 *     cancelled tool call can never leave a permanent loop on the node;
 *  3. frames go to tmpfs and the recorder writes `times.csv` itself, because the real frame
 *     interval (p50 ≈ 250 ms at 4 fps) is what the recording is judged by — not the wall clock
 *     of the caller.
 */
import { VmError } from './errors.js';
import { QMP_PY } from './qmp.js';

/** The recorder itself; every parameter arrives through the environment. */
export const RECORDER_PY = `#!/usr/bin/env python3
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
${QMP_PY}

def main():
    qmp = os.environ['QMP']
    out_dir = os.environ['OUT']
    fps = float(os.environ['FPS'])
    seconds = float(os.environ['SECONDS'])
    timeout = float(os.environ['QT'])
    stop_file = os.environ['STOP']
    os.makedirs(out_dir, exist_ok=True)
    started_ms = int(time.time() * 1000)
    with open(os.path.join(out_dir, 'pid'), 'w') as f:
        f.write(str(os.getpid()))
    with open(os.path.join(out_dir, 'started_ms'), 'w') as f:
        f.write(str(started_ms))
    with open(os.path.join(out_dir, 'fps'), 'w') as f:
        f.write(str(fps))
    times_path = os.path.join(out_dir, 'times.csv')
    times = open(times_path, 'w')
    times.write('i,ms\\n')
    times.flush()
    t0 = time.time()
    deadline = t0 + seconds
    frame = 0
    error = None
    interval = 1.0 / fps if fps > 0 else 0.25
    while time.time() < deadline:
        if os.path.exists(stop_file):
            break
        target = t0 + frame * interval
        now = time.time()
        if target > now:
            time.sleep(target - now)
        path = os.path.join(out_dir, 'f%05d.ppm' % frame)
        attempts = 0
        while True:
            try:
                qmp_dump(qmp, path, timeout)
                break
            except Exception as exc:
                attempts += 1
                if attempts >= 5:
                    error = classify(exc) + ': ' + str(exc)
                    break
                time.sleep(0.05 * attempts)
        if error is not None:
            break
        ms = int((time.time() - t0) * 1000)
        times.write('%d,%d\\n' % (frame, ms))
        times.flush()
        frame += 1
    times.close()
    meta = {'frames': frame, 'started_ms': started_ms, 'fps': fps, 'seconds': seconds,
            'error': error, 'ended_ms': int(time.time() * 1000),
            'elapsed_ms': int((time.time() - t0) * 1000)}
    tmp = os.path.join(out_dir, 'meta.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(meta, f)
    os.replace(tmp, os.path.join(out_dir, 'meta.json'))
    try:
        os.unlink(stop_file)
    except OSError:
        pass
    try:
        os.unlink(os.path.join(out_dir, 'pid'))
    except OSError:
        pass

main()
`;

/**
 * The start script: install the recorder, wipe the previous run, launch it detached, wait until
 * it is provably alive, then report.
 * @param {{root:string, burst:string, logFile:string, scriptFile:string, vmid:number, fps:number, seconds:number, qmpTimeoutMs:number, stopFile:string}} spec paths and parameters.
 * @returns {string} bash script for `ssh … bash -s`.
 */
export function startScript(spec) {
  return [
    'set -u',
    `ROOT='${spec.root}'`,
    `OUT='${spec.burst}'`,
    `LOG='${spec.logFile}'`,
    `SCRIPT='${spec.scriptFile}'`,
    `STOP='${spec.stopFile}'`,
    'mkdir -p "$ROOT"',
    'cat > "$SCRIPT" <<\'PYEOF\'',
    RECORDER_PY,
    'PYEOF',
    'rm -rf "$OUT"',
    'mkdir -p "$OUT"',
    'rm -f "$STOP"',
    `PYTHON=$(command -v python3 || echo /usr/bin/python3)`,
    'env QMP="/var/run/qemu-server/' + Number(spec.vmid) + '.qmp" OUT="$OUT" FPS=' + spec.fps + ' SECONDS=' + spec.seconds + ' QT=' + spec.qmpTimeoutMs / 1000 + ' STOP="$STOP" \\',
    '  nohup setsid "$PYTHON" "$SCRIPT" > "$LOG" 2>&1 < /dev/null &',
    'for i in $(seq 1 40); do',
    '  if [ -f "$OUT/pid" ]; then break; fi',
    '  sleep 0.1',
    'done',
    'PID=$(cat "$OUT/pid" 2>/dev/null || echo 0)',
    'if [ "$PID" = "0" ]; then',
    '  echo "START_FAILED"',
    '  tail -c 1200 "$LOG" 2>/dev/null',
    '  exit 3',
    'fi',
    'echo "PID=$PID"',
    'echo "STARTED_MS=$(cat "$OUT/started_ms" 2>/dev/null || echo 0)"',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Start a burst.
 * @param {object} transport ssh transport.
 * @param {string} node node address.
 * @param {{vmid:number, root:string, burst:string, fps:number, seconds:number, qmpTimeoutMs:number, signal?:AbortSignal}} options parameters.
 * @returns {Promise<{pid:number, dir:string, started_ms:number}>} the running recorder.
 */
export async function startBurst(transport, node, options) {
  const logFile = `${options.root}/burst.log`;
  const scriptFile = `${options.root}/recorder.py`;
  const stopFile = `${options.root}/STOP`;
  const result = await transport.run(
    node,
    startScript({
      root: options.root,
      burst: options.burst,
      logFile,
      scriptFile,
      vmid: options.vmid,
      fps: options.fps,
      seconds: options.seconds,
      qmpTimeoutMs: options.qmpTimeoutMs,
      stopFile,
    }),
    { timeoutMs: 30000, allowNonZero: true, signal: options.signal, maxBytes: 16384 },
  );
  if (result.code !== 0) {
    throw new VmError('BURST_START_FAILED', `recorder did not start: ${(result.stdout + result.stderr).trim().slice(0, 800)}`, {
      log: logFile,
    });
  }
  const pid = Number(/PID=(\d+)/.exec(result.stdout)?.[1] ?? 0);
  const started = Number(/STARTED_MS=(\d+)/.exec(result.stdout)?.[1] ?? 0);
  return { pid, dir: options.burst, started_ms: started || Date.now() };
}

/**
 * The state of a burst.
 * @param {object} transport ssh transport.
 * @param {string} node node address.
 * @param {{vmid:number, root:string, burst:string}} options paths.
 * @returns {Promise<{running:boolean, pid:number, frames:number, started_ms:number, fps:number, last_ms:number|null, meta:object|null, log:string}>} state.
 */
export async function burstStatus(transport, node, options) {
  const script = [
    'set -u',
    `ROOT='${options.root}'`,
    `OUT='${options.burst}'`,
    'PID=$(cat "$OUT/pid" 2>/dev/null || echo 0)',
    'if [ "$PID" != "0" ] && kill -0 "$PID" 2>/dev/null; then echo "RUN=1"; else echo "RUN=0"; fi',
    'echo "PID=$PID"',
    'echo "FRAMES=$(ls -1 "$OUT"/f*.ppm 2>/dev/null | wc -l | tr -d \' \')"',
    'echo "STARTED_MS=$(cat "$OUT/started_ms" 2>/dev/null || echo 0)"',
    'echo "FPS=$(cat "$OUT/fps" 2>/dev/null || echo 0)"',
    'LAST=$(tail -n 1 "$OUT/times.csv" 2>/dev/null | cut -d, -f2)',
    'echo "LAST_MS=${LAST:-0}"',
    'echo "META=$(head -c 600 "$OUT/meta.json" 2>/dev/null | tr -d \'\\n\')"',
    'echo "LOG=$(tail -c 600 "$ROOT/burst.log" 2>/dev/null | tr -d \'\\r\\n\')"',
    'exit 0',
    '',
  ].join('\n');
  const result = await transport.run(node, script, { timeoutMs: 20000, allowNonZero: true, maxBytes: 16384 });
  const fields = readFields(result.stdout);
  let meta = null;
  if (fields.META) {
    try {
      meta = JSON.parse(fields.META);
    } catch {
      meta = null;
    }
  }
  return {
    running: fields.RUN === '1',
    pid: Number(fields.PID ?? 0),
    frames: Number(fields.FRAMES ?? 0),
    started_ms: Number(fields.STARTED_MS ?? 0),
    fps: Number(fields.FPS ?? 0),
    last_ms: Number(fields.LAST_MS ?? 0) || null,
    meta,
    log: fields.LOG ?? '',
  };
}

/**
 * Stop a burst: STOP file first (the loop exits at its next frame), then signals if it lingers.
 * @param {object} transport ssh transport.
 * @param {string} node node address.
 * @param {{vmid:number, root:string, burst:string, signal?:AbortSignal}} options paths.
 * @returns {Promise<{was_running:boolean, frames:number, waited_ms:number, pid:number, killed:boolean}>} outcome.
 */
export async function stopBurst(transport, node, options) {
  const stopFile = `${options.root}/STOP`;
  const script = [
    'set -u',
    `OUT='${options.burst}'`,
    `STOP='${stopFile}'`,
    'PID=$(cat "$OUT/pid" 2>/dev/null || echo 0)',
    'touch "$STOP"',
    'if [ "$PID" != "0" ] && kill -0 "$PID" 2>/dev/null; then RUNNING=1; else RUNNING=0; fi',
    'WAITED=0',
    'if [ "$RUNNING" = "1" ]; then',
    '  for i in $(seq 1 60); do',
    '    if ! kill -0 "$PID" 2>/dev/null; then break; fi',
    '    sleep 0.1',
    '    WAITED=$((WAITED + 100))',
    '  done',
    'fi',
    'KILLED=0',
    'if [ "$RUNNING" = "1" ] && kill -0 "$PID" 2>/dev/null; then',
    '  kill -TERM "$PID" 2>/dev/null || true',
    '  sleep 0.5',
    '  if kill -0 "$PID" 2>/dev/null; then kill -KILL "$PID" 2>/dev/null || true; fi',
    '  KILLED=1',
    'fi',
    'rm -f "$STOP"',
    'if [ "$PID" != "0" ] && kill -0 "$PID" 2>/dev/null; then echo "STILL_RUNNING=1"; else echo "STILL_RUNNING=0"; fi',
    'echo "WAS_RUNNING=$RUNNING"',
    'echo "WAITED=$WAITED"',
    'echo "KILLED=$KILLED"',
    'echo "PID=$PID"',
    'echo "FRAMES=$(ls -1 "$OUT"/f*.ppm 2>/dev/null | wc -l | tr -d \' \')"',
    'exit 0',
    '',
  ].join('\n');
  const result = await transport.run(node, script, {
    timeoutMs: 30000,
    allowNonZero: true,
    signal: options.signal,
    maxBytes: 16384,
  });
  const fields = readFields(result.stdout);
  if (fields.STILL_RUNNING === '1') {
    throw new VmError(
      'BURST_START_FAILED',
      `recorder ${fields.PID} survived STOP, SIGTERM and SIGKILL — check the node by hand`,
      { pid: Number(fields.PID ?? 0) },
    );
  }
  return {
    was_running: fields.WAS_RUNNING === '1',
    frames: Number(fields.FRAMES ?? 0),
    waited_ms: Number(fields.WAITED ?? 0),
    pid: Number(fields.PID ?? 0),
    killed: fields.KILLED === '1',
  };
}

/**
 * Parse `KEY=value` lines.
 * @param {string} text script output.
 * @returns {Record<string,string>} the fields.
 */
export function readFields(text) {
  const fields = {};
  for (const line of String(text ?? '').split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return fields;
}
