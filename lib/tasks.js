/**
 * PVE tasks: the asynchronous half of the API.
 *
 * `qm clone`, `qm migrate`, `vzdump` and friends return a UPID immediately and do the work in a
 * worker; the only way to know whether it succeeded is to poll `/nodes/{node}/tasks/{upid}/status`
 * until `status` turns `stopped` and read `exitstatus`. A tool that reported "started" and walked
 * away would leave the caller unable to tell success from a half-copied disk, so every async tool
 * here waits by default and reports the task's own exit status.
 */

import { VmError } from './errors.js';
import { taskStatusScript, parseJson } from './vmops.js';

/** Find the first UPID in a command's output (qm prints one line per async command). */
export function findUpid(text) {
  const match = /UPID:[^\s"']+/.exec(String(text ?? ''));
  return match ? match[0].trim() : null;
}

/** One status read. Returns the raw pvesh fields plus a normalised state. */
export async function taskStatus({ transport, node, upid, signal }) {
  const result = await transport.run(node, taskStatusScript(upid), {
    timeoutMs: 30000,
    signal,
    allowNonZero: true,
  });
  const parsed = parseJson(result.stdout, 'SSH_FAILED');
  if (!parsed || typeof parsed !== 'object') {
    throw new VmError('SSH_FAILED', 'the node returned no task status', { upid, output: result.stdout.slice(0, 300) });
  }
  const running = parsed.status === 'running';
  const exitstatus = parsed.exitstatus ?? null;
  return {
    upid,
    node: parsed.node ?? node,
    type: parsed.type ?? null,
    vmid: parsed.id ?? null,
    running,
    exitstatus,
    state: running ? 'running' : exitstatus === 'OK' ? 'ok' : 'failed',
  };
}

/**
 * Poll until the task stops or the deadline passes. Never sleeps past the caller's signal: a
 * cancelled tool must not keep a worker alive, so the abort shows up as `state: "cancelled"`.
 */
export async function waitTask({ transport, node, upid, timeoutMs = 300000, intervalMs = 1000, signal }) {
  const started = Date.now();
  let last = null;
  for (;;) {
    if (signal?.aborted) {
      return {
        upid,
        state: 'cancelled',
        running: false,
        exitstatus: last?.exitstatus ?? null,
        ms: Date.now() - started,
      };
    }
    last = await taskStatus({ transport, node, upid, signal });
    if (!last.running) {
      return { ...last, ms: Date.now() - started };
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      return {
        upid,
        state: 'timeout',
        running: true,
        exitstatus: null,
        node,
        type: last.type,
        vmid: last.vmid,
        ms: Date.now() - started,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}
