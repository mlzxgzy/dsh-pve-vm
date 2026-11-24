/**
 * Power and host-level keys.
 *
 * These are the two operations every PVE workflow needs and the pixel tools cannot provide:
 * `qm start/stop/shutdown/reboot/reset` on the owning node, and `qm sendkey` — a QMP key injection
 * that still works when the guest agent is dead, which is exactly the situation where SendKeys
 * (the session-1 bridge used by `pve_key`) is unavailable too.
 *
 * Every action runs on the node that owns the VM, resolved at call time, and reports the state the
 * VM is actually in afterwards rather than the state the command hoped for.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { VmError } from '../lib/errors.js';
import { queryVmStatus } from '../lib/ssh.js';
import {
  bodyOf,
  parseRc,
  rebootScript,
  resetScript,
  sendkeyScript,
  shutdownScript,
  startScript,
  stopScript,
} from '../lib/vmops.js';
import { NODE_PARAM, VMID_PARAM, schema, seconds, textRender, target } from './common.js';

const ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'reset', 'status'];

/** How long a graceful action may take before the tool gives up waiting (not before it aborts it). */
const DEFAULT_TIMEOUT_S = 60;

/**
 * Wait until the VM reports one of the wanted states.
 * @param {object} transport ssh transport.
 * @param {string} host node address.
 * @param {number} vmid VM id.
 * @param {string[]} wanted acceptable states.
 * @param {number} timeoutMs deadline.
 * @param {AbortSignal|undefined} signal cancellation.
 * @returns {Promise<{ok:boolean, status:string|null, ms:number}>} the settled state.
 */
async function waitForState(transport, host, vmid, wanted, timeoutMs, signal) {
  const started = Date.now();
  let status = null;
  for (;;) {
    const probe = await queryVmStatus(transport, host, vmid).catch(() => null);
    status = probe?.status ?? null;
    if (status !== null && wanted.includes(status)) return { ok: true, status, ms: Date.now() - started };
    if (Date.now() - started >= timeoutMs || signal?.aborted) return { ok: false, status, ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * @param {object} deps plugin wiring.
 * @returns {object[]} the tool definitions.
 */
export function powerTools(deps) {
  return [
    defineTool({
      name: 'pve_vm_power',
      description:
        'Start, stop, shut down, reboot or reset a VM on the node that owns it, then report the state it ' +
        'actually reached. `shutdown`/`reboot` ask the guest over ACPI and are graceful; `stop`/`reset` ' +
        'cut the power, which is what a hung Windows guest needs. Every action waits (by default) until ' +
        'the VM is in the expected state, so "ok" means it is up — not that a command was queued. ' +
        'Use action:"status" to only ask.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        action: {
          type: 'string',
          enum: ACTIONS,
          required: true,
          description:
            'start / stop (hard power off) / shutdown (ACPI, graceful) / reboot (ACPI) / reset (hard) / status (ask only).',
        },
        timeout: {
          type: 'number',
          description:
            `Seconds a graceful action may take inside PVE (\`qm shutdown --timeout\`). Default ${DEFAULT_TIMEOUT_S}; ` +
            'after it PVE itself forces the stop when forceStop is set.',
        },
        forceStop: {
          type: 'boolean',
          description: 'For shutdown: let PVE force a hard stop once `timeout` expires (`--forceStop 1`).',
        },
        wait: {
          type: 'boolean',
          description: 'Wait until the VM reaches the state the action implies (default true). false returns immediately.',
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'How long to wait for the state change, milliseconds (default 180000).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'The VM the action ran on.' },
          host: { type: 'string', description: 'Node address the command was run on.' },
          node: { type: 'string', description: 'PVE node name.' },
          action: { type: 'string', enum: ACTIONS, description: 'The action that was requested.' },
          previous_status: { type: 'string', description: 'State before the action (running, stopped, paused).' },
          status: { type: 'string', description: 'State after the action and the wait.' },
          changed: { type: 'boolean', description: 'True when the state differs from the state before the call.' },
          waited_ms: { type: 'number', description: 'Time spent waiting for the state change.' },
          output: { type: 'string', description: 'Whatever qm printed (usually nothing).' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE VM power', (value) => {
          const where = value.node ? `${value.node} (${value.host})` : value.host;
          const lines = [
            `VM ${value.vmid} on ${where}: ${value.previous_status ?? 'unknown'} → ${value.action} → ` +
              `${value.status ?? 'unknown'}${value.waited_ms === undefined ? '' : ` in ${seconds(value.waited_ms)}`}`,
          ];
          if (value.output) lines.push(`  ${String(value.output).split('\n')[0]}`);
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const action = String(args.action ?? '').trim();
        if (!ACTIONS.includes(action)) throw new VmError('BAD_ARGS', `"${action}" is not a power action`, { allowed: ACTIONS });
        const resolved = await target(deps, args, exec);
        const timeout = Number.isFinite(Number(args.timeout)) ? Math.max(0, Math.trunc(Number(args.timeout))) : DEFAULT_TIMEOUT_S;
        if (action === 'status') {
          return {
            ok: true,
            vmid: resolved.vmid,
            host: resolved.host,
            node: resolved.node,
            action,
            previous_status: resolved.status,
            status: resolved.status,
            changed: false,
            wall_ms: Date.now() - started,
          };
        }
        const script =
          action === 'start'
            ? startScript(resolved.vmid)
            : action === 'stop'
              ? stopScript(resolved.vmid, { timeout })
              : action === 'shutdown'
                ? shutdownScript(resolved.vmid, { timeout, forceStop: args.forceStop === true })
                : action === 'reboot'
                  ? rebootScript(resolved.vmid, { timeout })
                  : resetScript(resolved.vmid);
        const run = await deps.transport.run(resolved.host, script, {
          timeoutMs: Math.max(30000, (timeout + 30) * 1000),
          signal: exec.signal,
          allowNonZero: true,
        });
        const rc = parseRc(run.stdout);
        if (rc !== null && rc !== 0) {
          throw new VmError('VM_POWER_FAILED', `\`qm ${action}\` failed with exit code ${rc}`, {
            action,
            vmid: resolved.vmid,
            output: bodyOf(run.stdout).slice(0, 400),
          });
        }
        const output = bodyOf(run.stdout);
        const wait = args.wait !== false;
        const wanted =
          action === 'start' || action === 'reboot' || action === 'reset'
            ? ['running']
            : ['stopped'];
        const deadline = Number.isFinite(Number(args.waitTimeoutMs)) ? Math.max(1000, Number(args.waitTimeoutMs)) : 180000;
        let status = null;
        let waited = 0;
        if (wait) {
          const settled = await waitForState(deps.transport, resolved.host, resolved.vmid, wanted, deadline, exec.signal);
          status = settled.status;
          waited = settled.ms;
          if (!settled.ok && !exec.signal?.aborted) {
            throw new VmError('VM_POWER_TIMEOUT', `VM ${resolved.vmid} did not reach "${wanted.join('|')}" in ${seconds(deadline)}`, {
              action,
              vmid: resolved.vmid,
              status,
              waited_ms: waited,
              output: output.slice(0, 300),
            });
          }
        } else {
          const probe = await queryVmStatus(deps.transport, resolved.host, resolved.vmid).catch(() => null);
          status = probe?.status ?? null;
        }
        return {
          ok: true,
          vmid: resolved.vmid,
          host: resolved.host,
          ...(resolved.node === null ? {} : { node: resolved.node }),
          action,
          previous_status: resolved.status,
          ...(status === null ? {} : { status }),
          changed: status !== null && status !== resolved.status,
          waited_ms: waited,
          ...(output ? { output: output.slice(0, 400) } : {}),
          wall_ms: Date.now() - started,
        };
      },
    }),

    defineTool({
      name: 'pve_sendkey',
      description:
        'Send one key (or chord) to a VM through QMP (`qm sendkey`), which does not need the guest agent ' +
        'or a console session — unlike pve_key, which uses SendKeys inside the interactive session. Use ' +
        'it to dismiss a "press any key" prompt, hit Ctrl-Alt-Delete, or drive a guest whose agent is ' +
        'down. Keys are QEMU names: ret, esc, tab, up, ctrl, alt-f2, ctrl-alt-delete, shift-f10.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        key: {
          type: 'string',
          required: true,
          description: 'QEMU key name, e.g. "ret", "esc", "tab", "ctrl-alt-delete", "alt-f4", "f12".',
        },
        repeat: {
          type: 'number',
          description: 'How many times to press it, 1…20 (default 1). Each press is a separate sendkey call.',
        },
        delayMs: { type: 'number', description: 'Pause between presses, milliseconds (default 150).' },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'The VM the keys went to.' },
          host: { type: 'string', description: 'Node address the command was run on.' },
          node: { type: 'string', description: 'PVE node name.' },
          key: { type: 'string', description: 'The key name that was sent.' },
          repeat: { type: 'number', description: 'How many presses were sent.' },
          output: { type: 'string', description: 'Whatever qm printed.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE sendkey', (value) => {
          const where = value.node ? `${value.node} (${value.host})` : value.host;
          return (
            `sent {${value.key}} × ${value.repeat ?? 1} to VM ${value.vmid} on ${where} in ${seconds(value.wall_ms)}\n` +
            'host-level sendkey: it works without the guest agent and without a console session.'
          );
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const resolved = await target(deps, args, exec);
        if (resolved.status !== 'running') {
          throw new VmError('VM_STOPPED', `VM ${resolved.vmid} is ${resolved.status}; a key has no console to go to`, {
            vmid: resolved.vmid,
            status: resolved.status,
          });
        }
        const key = String(args.key ?? '').trim();
        const repeat = Number.isFinite(Number(args.repeat)) ? Math.max(1, Math.min(20, Math.trunc(Number(args.repeat)))) : 1;
        const delay = Number.isFinite(Number(args.delayMs)) ? Math.max(0, Math.min(5000, Math.trunc(Number(args.delayMs)))) : 150;
        let output = '';
        for (let index = 0; index < repeat; index += 1) {
          const run = await deps.transport.run(resolved.host, sendkeyScript(resolved.vmid, key), {
            timeoutMs: 30000,
            signal: exec.signal,
            allowNonZero: true,
          });
          const rc = parseRc(run.stdout);
          const body = bodyOf(run.stdout);
          if (body) output = body;
          if (rc !== null && rc !== 0) {
            throw new VmError('BAD_ARGS', `\`qm sendkey\` rejected "${key}"`, { key, rc, output: body.slice(0, 300) });
          }
          if (index < repeat - 1 && delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return {
          ok: true,
          vmid: resolved.vmid,
          host: resolved.host,
          ...(resolved.node === null ? {} : { node: resolved.node }),
          key,
          repeat,
          ...(output ? { output: output.slice(0, 200) } : {}),
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
