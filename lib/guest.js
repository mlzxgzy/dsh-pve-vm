/**
 * Guest commands through the QEMU guest agent (`qm guest exec`).
 *
 * Two traps are handled here, both measured on this PVE build (2026-11-24):
 *  1. `out-data` is decoded with the **guest code page**, so UTF-8 text comes back as mojibake
 *     (`hello 世界` → `hello ÊÀ½ç`). Fix: the guest script base64s its own output, and base64 is
 *     pure ASCII, so it survives any code page.
 *  2. `err-data` carries CLIXML progress noise. Fix: `$ProgressPreference='SilentlyContinue'`.
 *
 * A UTF-16LE BOM must **not** be prepended to `-EncodedCommand`: PowerShell then reads the BOM as
 * part of the first token and fails with
 * `无法将"?$ErrorActionPreference=Continue"项识别为 cmdlet` (reproduced, then removed).
 */
import { VmError } from './errors.js';

/** The envelope marker; whatever the guest script prints is base64-wrapped after it. */
const MARKER = 'JEV1:';

/**
 * Wrap a user script so its output survives the JSON/code-page round trip.
 * @param {string} script PowerShell to run.
 * @returns {string} the wrapper script.
 */
export function envelope(script) {
  return [
    "$ProgressPreference='SilentlyContinue'",
    "$ErrorActionPreference='Continue'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$o = & {',
    String(script ?? ''),
    '} 2>&1 | Out-String',
    '$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($o))',
    '$c = if($LASTEXITCODE -ne $null){$LASTEXITCODE}else{0}',
    `Write-Output ("${MARKER}" + $b + ":" + $c)`,
    '',
  ].join('\r\n');
}

/** The hard limit of one argv on Windows is 32767 characters; base64 of UTF-16 is 2.67 bytes/char. */
export const MAX_ENCODED = 24000;

/**
 * Encode a PowerShell script for `-EncodedCommand`.
 * @param {string} script the wrapper script.
 * @returns {string} base64 of UTF-16LE (no BOM).
 */
export function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Parse the guest agent's JSON reply.
 * @param {string} stdout ssh stdout.
 * @returns {{exitcode:number, out:string, err:string, exited:boolean, pid:number|null}} the reply.
 */
export function parseGuestReply(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  if (start === -1) {
    throw new VmError('GUEST_EXEC_FAILED', `the node did not return JSON: ${text.trim().slice(0, 400) || '(empty)'}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch (error) {
    throw new VmError('GUEST_EXEC_FAILED', `unparsable agent reply: ${text.slice(start, start + 400)}`);
  }
  return {
    exitcode: typeof parsed.exitcode === 'number' ? parsed.exitcode : -1,
    out: typeof parsed['out-data'] === 'string' ? parsed['out-data'] : '',
    err: typeof parsed['err-data'] === 'string' ? parsed['err-data'] : '',
    exited: parsed.exited === 1 || parsed.exited === true,
    pid: typeof parsed.pid === 'number' ? parsed.pid : null,
  };
}

/**
 * Unwrap the envelope: base64 → UTF-8 text (plus the exit code the guest reported).
 * @param {{exitcode:number, out:string, err:string, exited:boolean}} reply the agent reply.
 * @returns {{stdout:string, exitcode:number, wrapped:boolean}} decoded output.
 */
export function unwrapReply(reply) {
  const match = /JEV1:([A-Za-z0-9+/=]*):(-?\d+)/.exec(reply.out ?? '');
  if (match === null) {
    // The wrapper did not run (the script called `exit`, or an encoding failure).
    return { stdout: String(reply.out ?? ''), exitcode: reply.exitcode, wrapped: false };
  }
  const bytes = Buffer.from(match[1], 'base64');
  return { stdout: bytes.toString('utf8'), exitcode: Number(match[2]), wrapped: true };
}

/**
 * Run a PowerShell script as SYSTEM through the guest agent.
 *
 * `qm guest exec --timeout` is PVE's own wait, in **seconds**: with it the call returns the
 * finished command; without it PVE returns `{pid}` and the result has to be polled.
 * @param {{transport:object, node:string, vmid:number, script:string, timeoutMs:number, signal?:AbortSignal}} options call options.
 * @returns {Promise<{stdout:string, stderr:string, exitcode:number, ms:number, wrapped:boolean}>} the result.
 */
export async function guestExec(options) {
  const wrapped = envelope(options.script);
  const encoded = encodeCommand(wrapped);
  if (encoded.length > MAX_ENCODED) {
    throw new VmError(
      'BAD_ARGS',
      `the script is too long for one command line (${encoded.length} base64 chars, the limit is ~${MAX_ENCODED}); ` +
        'write it to a file in the guest first and run the file',
    );
  }
  const seconds = Math.max(5, Math.ceil(options.timeoutMs / 1000));
  // Everything is ASCII here (base64), so the values can go into the remote command line
  // without a quoting hazard; the vmid is an integer checked by the caller.
  const command = [
    `/usr/sbin/qm guest exec ${Number(options.vmid)} --timeout ${seconds} --`,
    'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand',
    encoded,
  ].join(' ');
  const started = Date.now();
  const result = await options.transport.run(options.node, `${command}\n`, {
    timeoutMs: options.timeoutMs + 20000,
    signal: options.signal,
    allowNonZero: true,
    maxBytes: 1024 * 1024,
  });
  const reply = parseGuestReply(result.stdout);
  if (!reply.exited && reply.pid !== null) {
    throw new VmError(
      'GUEST_EXEC_FAILED',
      `the command is still running in the guest after ${seconds} s (agent pid ${reply.pid}); raise guestTimeoutMs`,
      { pid: reply.pid },
    );
  }
  const unwrapped = unwrapReply(reply);
  return {
    stdout: unwrapped.stdout,
    stderr: reply.err,
    exitcode: unwrapped.exitcode,
    ms: Date.now() - started,
    wrapped: unwrapped.wrapped,
  };
}

/**
 * Whether the guest agent answers right now.
 * @param {{transport:object, node:string, vmid:number}} options where.
 * @returns {Promise<boolean>} readiness.
 */
export async function agentReady(options) {
  const result = await options.transport.run(
    options.node,
    `/usr/sbin/qm agent ${Number(options.vmid)} ping 2>&1\n`,
    { timeoutMs: 10000, allowNonZero: true, maxBytes: 4096 },
  );
  return result.code === 0;
}
