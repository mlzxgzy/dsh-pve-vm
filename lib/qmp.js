/**
 * Host-side QMP frames: one `screendump` per connection, exactly like the reference `qcap.py`.
 *
 * Why the host and not the guest: with no console attached to the Windows guest, DWM stops
 * compositing and `CopyFromScreen` inside the guest returns the same stale frame forever
 * (playbook A-9, reproduced on 2026-11-23). QEMU's own screendump does not care about the guest
 * desktop composition state.
 *
 * Why one connection per frame: the QMP unix socket accepts a **single** client. A burst keeps
 * its own connection only while dumping; anyone else who connects meanwhile must be told
 * QMP_BUSY at once instead of queueing (measured: a naive wait hung for 399 s).
 */
import { VmError } from './errors.js';
import { ByteStream } from './stream.js';

/**
 * The python half. Placeholders: `QMP` (socket path), `QMP_TIMEOUT` (seconds), and — for the
 * single-frame mode — `OUT` (file to write) and `KEEP` (1 = leave the file on the node).
 *
 * Python 3.9 on the node: no third-party modules, only `socket`/`json`/`os`/`sys`/`time`.
 */
export const QMP_PY = `
import json, os, socket, sys, time

def qmp_dump(sock_path, out_path, timeout):
    started = time.time()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(sock_path)
    f = s.makefile('rwb', buffering=0)
    f.readline()  # QMP greeting
    f.write(b'{"execute":"qmp_capabilities"}\\n')
    while True:
        line = f.readline()
        if not line:
            raise IOError('qmp closed before capabilities')
        if b'"error"' in line:
            raise IOError(line.decode('utf-8', 'replace').strip())
        if b'"return"' in line:
            break
    f.write(json.dumps({"execute": "screendump", "arguments": {"filename": out_path}}).encode() + b'\\n')
    while True:
        line = f.readline()
        if not line:
            raise IOError('qmp closed during screendump')
        text = line.decode('utf-8', 'replace').strip()
        if b'"error"' in line:
            raise IOError(text)
        if b'"return"' in line:
            break
    s.close()
    return int((time.time() - started) * 1000)

def classify(exc):
    text = str(exc)
    if 'timed out' in text or 'Resource temporarily unavailable' in text or 'Connection refused' in text:
        return 'QMP_BUSY'
    if 'No such file' in text or 'ENOENT' in text:
        return 'QMP_MISSING'
    if 'screendump' in text or '"error"' in text:
        return 'QMP_ERROR'
    return 'QMP_ERROR'
`;

/**
 * A single-frame script: dump to `outFile`, print a JSON meta line on stdout, then the file bytes.
 * @param {{qmpPath: string, outFile: string, timeoutSec: number, keep: boolean}} spec frame spec.
 * @returns {string} bash script for `ssh … bash -s`.
 */
export function screendumpScript(spec) {
  return [
    'set -u',
    'mkdir -p "$(dirname ' + spec.outFile + ')" 2>/dev/null || true',
    `export QMP='${spec.qmpPath}'`,
    `export OUT='${spec.outFile}'`,
    `export QT=${spec.timeoutSec}`,
    `export KEEP=${spec.keep ? 1 : 0}`,
    `python3 - <<'PY'`,
    QMP_PY,
    'sock = os.environ["QMP"]',
    'out = os.environ["OUT"]',
    'timeout = float(os.environ["QT"])',
    'keep = os.environ.get("KEEP", "0") == "1"',
    'try:',
    '    ms = qmp_dump(sock, out, timeout)',
    '    size = os.path.getsize(out)',
    '    head = open(out, "rb").read(64)',
    '    parts = head.split()',
    '    width = int(parts[1]) if len(parts) > 2 else 0',
    '    height = int(parts[2]) if len(parts) > 2 else 0',
    '    sys.stdout.write(json.dumps({"ok": True, "ms": ms, "size": size, "width": width, "height": height}) + "\\n")',
    '    sys.stdout.flush()',
    '    data = open(out, "rb").read()',
    '    sys.stdout.buffer.write(data)',
    '    sys.stdout.buffer.flush()',
    '    if not keep:',
    '        os.unlink(out)',
    'except Exception as exc:',
    '    sys.stdout.write(json.dumps({"ok": False, "code": classify(exc), "message": str(exc)}) + "\\n")',
    '    sys.stdout.flush()',
    'PY',
    '',
  ].join('\n');
}

/**
 * Take one frame from the VM's QMP socket.
 *
 * The whole exchange is one ssh pipe: the meta line, then the raw PPM bytes. A busy socket is
 * reported immediately (`QMP_BUSY`), never waited out: the caller decides whether to retry.
 * @param {object} transport the ssh transport.
 * @param {string} node node address.
 * @param {{vmid:number, outFile:string, qmpTimeoutMs:number, signal?:AbortSignal, timeoutMs?:number}} options frame options.
 * @returns {Promise<{ppm:Buffer, ms:number, bytes:number, width:number, height:number}>} the frame.
 */
export async function screendump(transport, node, options) {
  const qmpPath = `/var/run/qemu-server/${Number(options.vmid)}.qmp`;
  const script = screendumpScript({
    qmpPath,
    outFile: options.outFile,
    timeoutSec: Math.max(1, Math.round(options.qmpTimeoutMs / 1000)),
    keep: false,
  });
  const stream = transport.stream(node, script, {
    maxBytes: 64 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 60000,
    signal: options.signal,
  });
  const reader = new ByteStream(stream.stdout);
  try {
    const line = await reader.readLine();
    if (line === null) {
      const outcome = await stream.finish(5000);
      throw new VmError('QMP_ERROR', `no answer from the node (ssh exit ${outcome.code}): ${outcome.stderr.trim().slice(0, 400)}`);
    }
    let meta;
    try {
      meta = JSON.parse(line);
    } catch {
      throw new VmError('QMP_ERROR', `unexpected node answer: ${line.slice(0, 300)}`);
    }
    if (meta.ok !== true) {
      throw new VmError(meta.code ?? 'QMP_ERROR', String(meta.message ?? 'screendump failed'));
    }
    const ppm = await reader.readExactly(meta.size);
    if (ppm.length !== meta.size) {
      throw new VmError('QMP_ERROR', `short frame: got ${ppm.length} of ${meta.size} bytes`);
    }
    await stream.finish(10000);
    return { ppm, ms: meta.ms, bytes: meta.size, width: meta.width, height: meta.height };
  } finally {
    if (stream.timedOut.value) stream.cancel();
  }
}

/**
 * The QMP socket path of a VM on its node.
 * @param {number} vmid VM id.
 * @returns {string} absolute path.
 */
export function qmpPath(vmid) {
  return `/var/run/qemu-server/${Number(vmid)}.qmp`;
}
