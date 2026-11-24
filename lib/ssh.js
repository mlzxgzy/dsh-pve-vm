/**
 * Transport to the Proxmox node: one ssh process per call, the script goes in through stdin.
 *
 * Two rules come from the reference tooling (prototype/pve/qcap.py) and are not style choices:
 *   • `ssh … bash -s` with the script on **stdin** — no user value is ever spliced into a shell
 *     command line, so quoting bugs cannot happen;
 *   • `-F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` — the host
 *     ssh_config on this machine cannot be read, and the node host keys are not in known_hosts;
 *     without these options every call dies before it starts.
 *
 * `-T` (no pty) is mandatory: a pty would translate line endings and corrupt the binary PPM
 * frames that `pve_fetch_frames` streams through this same pipe.
 */
import { VmError } from './errors.js';

/**
 * Assemble the argv of the ssh client for a node.
 * @param {object} settings resolved plugin settings.
 * @param {string} node node address (already checked against `nodes`).
 * @returns {string[]} argv for spawn; the command is `bash -s` (script on stdin).
 */
export function sshArgv(settings, node) {
  const argv = ['ssh', '-T'];
  if (settings.ssh.sshConfig) argv.push('-F', settings.ssh.sshConfig);
  argv.push(
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(settings.ssh.connectTimeoutMs / 1000))}`,
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
  );
  if (settings.ssh.port && settings.ssh.port !== 22) argv.push('-p', String(settings.ssh.port));
  if (settings.ssh.keyPath) argv.push('-i', settings.ssh.keyPath);
  for (const option of settings.ssh.extraOptions) argv.push('-o', option);
  argv.push(settings.ssh.user ? `${settings.ssh.user}@${node}` : node, 'bash', '-s');
  return argv;
}

/** Connection-level ssh failures (as opposed to the remote command's own exit code). */
const SSH_CONNECTION_PATTERNS = [
  /Connection (timed out|refused|closed)/i,
  /No route to host/i,
  /Host is down/i,
  /Network is unreachable/i,
  /Could not resolve hostname/i,
  /Permission denied/i,
  /Connection reset by peer/i,
  /Operation timed out/i,
  /broken pipe/i,
];

/**
 * One ssh transport bound to the plugin's spawner and working directory.
 */
export class Transport {
  /**
   * @param {{settings: () => object, spawn: (spec: object) => object, cwd: string}} options wiring.
   */
  constructor(options) {
    this.settings = options.settings;
    this.spawn = options.spawn;
    this.cwd = options.cwd ?? process.cwd();
  }

  /**
   * Run a bash script on the node and collect its output.
   * @param {string} node node address.
   * @param {string} script bash script (stdin of `bash -s`).
   * @param {{timeoutMs?: number, maxBytes?: number, signal?: AbortSignal, allowNonZero?: boolean}} [options] call options.
   * @returns {Promise<{code:number, stdout:string, stderr:string, ms:number, bytes:number}>} the result.
   */
  async run(node, script, options = {}) {
    const settings = this.settings();
    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 30000;
    const started = Date.now();
    const { handle, timedOut, cleanup } = this.#start(settings, node, script, timeoutMs, maxBytes, options.signal);
    let outcome;
    let failure = null;
    try {
      outcome = await handle.done;
    } catch (error) {
      failure = error;
    }
    const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? '';
    const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? '';
    cleanup();
    if (timedOut.value) {
      throw new VmError('SSH_TIMEOUT', `ssh ${node} timed out after ${timeoutMs} ms`, {
        ms: Date.now() - started,
        stderr: stderr.slice(0, 2000),
      });
    }
    if (failure !== null && outcome === undefined) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (/abort/i.test(message) && options.signal?.aborted) throw new VmError('SSH_TIMEOUT', 'call cancelled');
      throw new VmError('NODE_UNREACHABLE', `ssh ${node}: ${message}`, { node, ms: Date.now() - started });
    }
    const code = outcome?.exitCode ?? outcome?.code ?? -1;
    const result = { code, stdout, stderr, ms: Date.now() - started, bytes: Buffer.byteLength(stdout) };
    if (code !== 0) {
      const connection = SSH_CONNECTION_PATTERNS.find((pattern) => pattern.test(stderr));
      if (code === 255 || connection !== undefined) {
        throw new VmError('NODE_UNREACHABLE', `ssh ${node} failed (exit ${code}): ${stderr.trim().slice(0, 800)}`, {
          node,
          ms: result.ms,
          exit: code,
        });
      }
      if (options.allowNonZero !== true) {
        throw new VmError(
          'SSH_FAILED',
          `remote command on ${node} exited ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 800)}`,
          { node, ms: result.ms, exit: code, stderr: stderr.slice(0, 2000) },
        );
      }
    }
    return result;
  }

  /**
   * Start a node script whose **stdout is a byte stream** (frames): the caller parses it.
   * @param {string} node node address.
   * @param {string} script bash script.
   * @param {{maxBytes?: number, signal?: AbortSignal, timeoutMs?: number}} [options] call options.
   * @returns {{handle: object, stdout: import('node:stream').Readable, timedOut: {value: boolean}, finish: (timeoutMs?: number) => Promise<{code:number, stderr:string, ms:number}>, cancel: () => void}} the stream.
   */
  stream(node, script, options = {}) {
    const settings = this.settings();
    const started = Date.now();
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 120000;
    const argv = sshArgv(settings, node);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      controller.abort();
    }, timeoutMs);
    const handle = this.spawn({
      argv,
      cwd: this.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 8192 },
      },
      graceMs: 3000,
      signal: controller.signal,
    });
    handle.stdin.end(script);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = async (waitMs = 15000) => {
      const wait = new Promise((resolve) => {
        const timer2 = setTimeout(() => resolve({ exitCode: -1 }), waitMs);
        handle.done.then(
          (value) => {
            clearTimeout(timer2);
            resolve(value ?? { exitCode: -1 });
          },
          () => {
            clearTimeout(timer2);
            resolve({ exitCode: -1 });
          },
        );
      });
      const outcome = await wait;
      cleanup();
      return {
        code: outcome?.exitCode ?? -1,
        stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
        ms: Date.now() - started,
      };
    };
    return {
      handle,
      stdout: handle.stdout ?? handle.collected?.stdout,
      timedOut,
      finish,
      cancel: () => {
        cleanup();
        handle.terminate?.();
      },
      maxBytes,
    };
  }

  /**
   * Spawn one ssh process with the script on stdin.
   * @private
   */
  #start(settings, node, script, timeoutMs, maxBytes, signal) {
    const argv = sshArgv(settings, node);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      controller.abort();
    }, timeoutMs);
    let handle;
    try {
      handle = this.spawn({
        argv,
        cwd: this.cwd,
        stdio: {
          stdin: 'pipe',
          stdout: { maxBytes },
          stderr: { maxBytes: 8192 },
        },
        graceMs: 3000,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new VmError(
        'NODE_UNREACHABLE',
        `could not start ssh: ${error instanceof Error ? error.message : String(error)}`,
        { node },
      );
    }
    handle.stdin.end(script);
    return {
      handle,
      timedOut,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      },
    };
  }
}

/**
 * Read the node's numeric VM status: `running`, `stopped`, `paused`.
 * @param {string} node node address.
 * @param {Transport} transport transport.
 * @param {number} vmid VM id.
 * @returns {Promise<{status:string|null, stdout:string, code:number}>} status or null when this node does not own the VM.
 */
export async function queryVmStatus(transport, node, vmid) {
  const script = `/usr/sbin/qm status ${Number(vmid)} 2>&1 || /usr/bin/qm status ${Number(vmid)} 2>&1\n`;
  const result = await transport.run(node, script, { timeoutMs: 15000, allowNonZero: true, maxBytes: 65536 });
  const match = result.stdout.match(/status:\s*([a-z]+)/i);
  return { status: match ? match[1].toLowerCase() : null, stdout: result.stdout, code: result.code };
}

/**
 * The guest agent's readiness for a VM, judged by the **exit code** of `qm agent ping`.
 *
 * The playbook says a successful ping prints `AGENT_OK`; on this PVE build it prints nothing at
 * all and exits 0 (measured 2026-11-24 on pve04). Grepping the text would therefore report every
 * healthy VM as down, so only the exit code is trusted.
 * @param {Transport} transport transport.
 * @param {string} node node address.
 * @param {number} vmid VM id.
 * @returns {Promise<boolean>} true when the agent answered.
 */
export async function agentPing(transport, node, vmid) {
  const script = `/usr/sbin/qm agent ${Number(vmid)} ping 2>&1 || /usr/bin/qm agent ${Number(vmid)} ping 2>&1\n`;
  try {
    const result = await transport.run(node, script, { timeoutMs: 10000, allowNonZero: true, maxBytes: 4096 });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Wait until a condition holds, polling with a fixed pace.
 * @param {() => Promise<boolean>} predicate the condition.
 * @param {{timeoutMs: number, intervalMs?: number, signal?: AbortSignal}} options wait options.
 * @returns {Promise<{ok:boolean, ms:number}>} whether it became true and how long it took.
 */
export async function waitFor(predicate, options) {
  const started = Date.now();
  const interval = options.intervalMs ?? 1000;
  for (;;) {
    if (options.signal?.aborted) return { ok: false, ms: Date.now() - started };
    if (await predicate()) return { ok: true, ms: Date.now() - started };
    if (Date.now() - started >= options.timeoutMs) return { ok: false, ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
