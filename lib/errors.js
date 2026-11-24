/**
 * The failure vocabulary of the plugin.
 *
 * Every tool answers with a canonical value, success or failure — no tool throws at the model.
 * A failure is `{ok:false, code, message, hint}`, and `code` comes from {@link HINTS}, so the
 * model can branch on it and the operator can look it up in docs/DETAIL.md. `hint` says what to
 * do next; it is part of the contract, not decoration.
 */

/** @type {Record<string, string>} code → what to do about it. */
export const HINTS = {
  NOT_A_CLUSTER:
    '`clusterMode` is "on" but the node has no /etc/pve/.members, so there is no cluster to read. ' +
    'Set clusterMode to "auto" (fall back to per-host qm list) or "off", or point `node` at a node ' +
    'that belongs to the cluster.',
  NODE_NOT_CONFIGURED:
    'No PVE host is known yet. Pass node:"pve04" (an ssh alias or an address), add hosts in the ' +
    'plugin settings, or export PVE_HOSTS=host1,host2 — the node that owns the VM is discovered ' +
    'automatically, so nothing has to be written down in advance.',
  NODE_NOT_ALLOWED: 'Set the host in the plugin settings (`hosts`) or pass `node` on the call.',
  VMID_NOT_ALLOWED:
    'Add the VM id to `allowedVmids`, or empty that list: an empty list allows every VM.',
  BAD_VMID: 'Pass a numeric `vmid`, or leave it out: the only running VM is picked automatically.',
  AMBIGUOUS_VMID:
    'More than one VM is running, so the call has to choose: pass `vmid` (the candidates are in ' +
    '`details.vms`), or set `defaultVmid` in the plugin settings.',
  BAD_ARGS: 'Check the tool arguments: one of them is empty, too long or has the wrong shape.',
  NODE_UNREACHABLE:
    'ssh could not connect. Connect the VPN (192.168.90.0/24 is not routed without it) and retry; ' +
    'this is a network failure, not a plugin bug.',
  SSH_FAILED: 'The command ran but ended with a non-zero exit code — see `message` for the node text.',
  SSH_TIMEOUT: 'Raise the timeout or check the node load; nothing was left running by this call.',
  QMP_BUSY:
    'Another QMP client is connected (a burst, or somebody else at the console). A burst is ' +
    'stopped with `pve_burst action:"stop"`; this call did not wait and did not steal the socket.',
  QMP_MISSING: 'The QMP socket is absent: the VM is stopped, or the node does not own this VM.',
  QMP_ERROR: 'QEMU refused the screendump — usually the VM has no display device.',
  AGENT_DOWN:
    'The guest agent does not answer. A VM restored from a snapshot needs `pve_snapshot`/boot plus ' +
    '30–90 s before the agent answers again.',
  AGENT_TIMEOUT:
    'The agent did not become ready in time. Check the VM console; the VM may still be booting.',
  SNAPSHOT_CONFIRM_REQUIRED:
    'Rolling back destroys the current VM state. Repeat the call with `confirm:true` when that is intended.',
  SNAPSHOT_NOT_FOUND: 'List the snapshots of the VM (`qm listsnapshot`) and use an exact name.',
  VM_RUNNING: 'Stop the VM first, or let the call stop it itself.',
  VM_STOPPED:
    'The VM is not running. Start it and wait for the guest agent; a stopped VM has no display to ' +
    'record and no session to type into.',
  BURST_ACTIVE:
    'A burst already runs for this VM. `pve_burst action:"status"` shows it; stop it before starting ' +
    'another one — two QMP clients would fight over the single-client socket.',
  BURST_NOT_RUNNING: 'Start a burst first (`pve_burst action:"start"`).',
  BURST_START_FAILED: 'The remote recorder exited at once — read `log` for the python traceback.',
  FRAMES_MISSING:
    'No frames in that range. Check `pve_burst action:"status"`; fetch after the burst has stopped.',
  GUEST_EXEC_DISABLED:
    '`pve_guest_exec` runs arbitrary PowerShell as SYSTEM and is off by default. Enable ' +
    '`allowGuestExec` in the plugin settings if that is what you want.',
  GUEST_EXEC_FAILED: 'The guest command itself failed — `stdout`/`stderr` carry its output.',
  BRIDGE_FAILED:
    'The session-1 bridge could not be installed or reached. It needs a logged-in interactive ' +
    'session (Administrator) on the VM console; a driver-install dialog may also cover the desktop.',
  BRIDGE_TIMEOUT: 'The interactive command did not finish in time; the bridge task is limited to 10 min.',
  CONVERT_FAILED:
    'No local encoder produced an image; frames were left as raw PPM where that is possible.',
  DISPLAY_DOWN:
    'The VM has no active display, so the frame is stale or black. Wake the console ' +
    '(`qm monitor`, or open it in the PVE UI) and retry.',
  INTERNAL: 'Unexpected plugin error — see `message`; please report it with the tool arguments.',
};

/**
 * An error with a stable code; the tools turn it into a canonical failure value.
 */
export class VmError extends Error {
  /**
   * @param {string} code one of {@link HINTS}.
   * @param {string} message human-readable detail (may contain node text).
   * @param {object} [extra] extra fields merged into the failure value.
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'VmError';
    this.code = code;
    this.extra = extra;
  }

  /**
   * The canonical failure value.
   * @returns {object} `{ok:false, code, message, hint, …extra}`.
   */
  toValue() {
    const details = detailsOf(this.extra);
    return {
      ok: false,
      code: this.code,
      message: this.message,
      hint: HINTS[this.code] ?? HINTS.INTERNAL,
      ...(details === undefined ? {} : { details }),
    };
  }
}

/**
 * A canonical failure value without throwing (for early returns).
 * @param {string} code one of {@link HINTS}.
 * @param {string} message detail.
 * @param {object} [extra] extra fields.
 * @returns {object}
 */
export function failure(code, message, extra = {}) {
  const details = detailsOf(extra);
  return {
    ok: false,
    code,
    message,
    hint: HINTS[code] ?? HINTS.INTERNAL,
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * Failure diagnostics travel in a declared `details` object: the tool output schema forbids unknown
 * top-level properties, so extra fields cannot be spread into the value itself.
 * @param {object} extra diagnostics.
 * @returns {object|undefined} the details object, or undefined when there is nothing to report.
 */
function detailsOf(extra) {
  if (extra === null || typeof extra !== 'object') return undefined;
  const entries = Object.entries(extra).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * Run a tool body and convert any thrown error into the canonical failure value.
 * @param {() => Promise<object>} body the tool implementation.
 * @returns {Promise<object>} the tool value.
 */
export async function guard(body) {
  try {
    return await body();
  } catch (error) {
    if (error instanceof VmError) return error.toValue();
    const message = error instanceof Error ? error.message : String(error);
    return failure('INTERNAL', message);
  }
}

/**
 * Cut a long text to a byte budget and say so.
 * @param {string} text source text.
 * @param {number} maxBytes byte budget.
 * @returns {{text:string, truncated:boolean, bytes:number}} the cut text.
 */
export function truncate(text, maxBytes) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8');
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString('utf8'), truncated: false, bytes: buffer.length };
  }
  // Cut on a character boundary: the tail bytes are dropped, never split.
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: buffer.subarray(0, end).toString('utf8'),
    truncated: true,
    bytes: buffer.length,
  };
}
