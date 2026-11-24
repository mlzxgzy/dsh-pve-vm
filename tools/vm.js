/**
 * Lifecycle tools: where the VM is, is the agent up, and the reset button.
 *
 * The node is discovered, never assumed: the same VM id exists on other nodes of the cluster, and a
 * hard-coded host is how the built-in Proxmox console tools fail (`Configuration file
 * 'nodes/pve01/qemu-server/15047.conf' does not exist`).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { VmError, guard } from '../lib/errors.js';
import { remotePaths } from '../lib/config.js';
import { agentPing, queryVmStatus, waitFor } from '../lib/ssh.js';
import { schema, textRender, seconds, VMID_PARAM } from './common.js';

/** A valid snapshot name on PVE. */
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Parse `qm listsnapshot` output into names (newest last) without the pseudo-snapshot `current`.
 * @param {string} stdout command output.
 * @returns {string[]} snapshot names.
 */
export function parseSnapshots(stdout) {
  const names = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(?:`->|\*)?\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.exec(line);
    if (match === null) continue;
    if (match[1] === 'current') continue;
    names.push(match[1]);
  }
  return names;
}

/**
 * Build the lifecycle tools.
 * @param {{settings:()=>object, transport:object, registry:object, bridge:object}} deps plugin dependencies.
 * @returns {object[]} tool definitions.
 */
export function lifecycleTools(deps) {
  return [
    defineTool({
      name: 'pve_vm_status',
      description:
        'Report one VM: the node that actually hosts it, its power state, whether the guest agent answers, ' +
        'and whether a frame recorder is running. Call this first — every other tool tolerates an unknown node, ' +
        'but knowing the state saves a failed call. Costs one ssh round trip (agent ping another).',
      parameters: {
        vmid: VMID_PARAM,
        fresh: {
          type: 'boolean',
          description: 'Re-probe the whole node list instead of trusting the 60 s node cache (default false).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'Node address that hosts the VM (an ssh target, not a cluster name).' },
          status: { type: 'string', description: 'Power state from qm status: running, stopped, paused…' },
          agent: { type: 'string', enum: ['ok', 'down', 'unknown'], description: 'Guest agent ping: ok, down, or unknown (VM not running).' },
          agent_ms: { type: 'number', description: 'Time the agent ping took, milliseconds.' },
          burst: { type: 'boolean', description: 'A frame recorder is running for this VM.' },
          frames: { type: 'number', description: 'Frames recorded so far by the running recorder.' },
          allowed_vmids: { type: 'array', items: { type: 'number' }, description: 'VM ids this plugin may touch.' },
          nodes: { type: 'array', items: { type: 'string' }, description: 'Node addresses this plugin may ssh to.' },
          configured: { type: 'boolean', description: 'False when no node or VM id is configured yet: the plugin is inert until allowlists are set.' },
          wall_ms: { type: 'number', description: 'Total wall time.' },
        }),
        render: textRender('VM status', (value) =>
          [
            `VM ${value.vmid} on ${value.node}: ${value.status}; guest agent ${value.agent}` +
              (value.agent_ms !== undefined ? ` (${seconds(value.agent_ms)})` : ''),
            value.burst ? `recorder running, ${value.frames ?? 0} frames so far` : 'no recorder running',
            `allowed VMs: ${(value.allowed_vmids ?? []).join(', ') || '(none)'}; nodes: ${(value.nodes ?? []).join(', ') || '(none)'}`,
            value.configured === false ? 'The plugin is inert: set nodes and allowedVmids in its settings.' : '',
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
        ),
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        return guard(async () => {
          const started = Date.now();
          const settings = deps.settings();
          const vmid = deps.registry.assertVmid(args.vmid);
          const resolved = await deps.registry.resolve(vmid, { signal: exec?.signal, fresh: args.fresh === true });
          const status = await queryVmStatus(deps.transport, resolved.node, vmid);
          let agent = 'unknown';
          let agentMs;
          if (status.status === 'running') {
            const pingStart = Date.now();
            const ok = await agentPing(deps.transport, resolved.node, vmid);
            agentMs = Date.now() - pingStart;
            agent = ok ? 'ok' : 'down';
          }
          let burst = false;
          let frames;
          const paths = remotePaths(settings, vmid);
          const state = await deps.burstStatus?.(resolved.node, vmid, paths);
          if (state !== undefined && state !== null) {
            burst = state.running === true;
            frames = state.frames;
          }
          return {
            ok: true,
            vmid,
            node: resolved.node,
            status: status.status ?? 'unknown',
            agent,
            ...(agentMs !== undefined ? { agent_ms: agentMs } : {}),
            burst,
            ...(frames !== undefined ? { frames } : {}),
            allowed_vmids: settings.allowedVmids,
            nodes: settings.ssh.nodes,
            configured: settings.ssh.nodes.length > 0 && settings.allowedVmids.length > 0,
            wall_ms: Date.now() - started,
          };
        });
      },
    }),

    defineTool({
      name: 'pve_snapshot',
      description:
        'Roll the VM back to a snapshot and boot it. THIS DESTROYS THE CURRENT DISK STATE: it stops the VM, ' +
        'rolls back, starts it again and waits for the guest agent, so the guest session, the bridge task and any ' +
        'recorder are gone afterwards. Requires confirm:true and names the snapshot it restored in the result. ' +
        'Takes tens of seconds (stop + rollback + boot + agent); the agent wait dominates.',
      parameters: {
        vmid: VMID_PARAM,
        snapshot: {
          type: 'string',
          description: 'Snapshot name to restore (letters, digits, dot, dash, underscore). Defaults to "init".',
          default: 'init',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true. Present so a model cannot roll back a VM as a side effect of a broader task; the ' +
            'result always states which snapshot was restored.',
        },
        timeoutMs: {
          type: 'number',
          description: 'How long to wait for the guest agent after boot, ms (default 180000, i.e. 3 min).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'Node the rollback ran on.' },
          snapshot: { type: 'string', description: 'Snapshot that was restored.' },
          rollback_ms: { type: 'number', description: 'Time of qm rollback.' },
          stop_ms: { type: 'number', description: 'Time to reach the stopped state (0 when already stopped).' },
          start_ms: { type: 'number', description: 'Time of qm start.' },
          agent_up_ms: { type: 'number', description: 'Time from qm start until the guest agent answered.' },
          previous_status: { type: 'string', description: 'Power state before the rollback.' },
          snapshots: { type: 'array', items: { type: 'string' }, description: 'Snapshots that exist on the VM.' },
          wall_ms: { type: 'number', description: 'Total wall time.' },
        }),
        render: textRender('Snapshot restored', (value) =>
          [
            `VM ${value.vmid} on ${value.node} rolled back to "${value.snapshot}" and booted.`,
            `rollback ${seconds(value.rollback_ms)}; guest agent up ${seconds(value.agent_up_ms)} after start`,
            `other snapshots: ${(value.snapshots ?? []).filter((name) => name !== value.snapshot).join(', ') || '(none)'}`,
            `total ${seconds(value.wall_ms)}`,
          ].join('\n'),
        ),
      },
      timeoutMs: 420000,
      async execute(args, exec) {
        return guard(async () => {
          if (args.confirm !== true) {
            throw new VmError(
              'SNAPSHOT_CONFIRM_REQUIRED',
              'rollback discards the current disk state, so this call needs confirm:true',
            );
          }
          const started = Date.now();
          const settings = deps.settings();
          const vmid = deps.registry.assertVmid(args.vmid);
          const name = String(args.snapshot ?? 'init').trim();
          if (!SNAPSHOT_NAME.test(name)) throw new VmError('BAD_ARGS', `invalid snapshot name "${name}"`);
          const waitMs = Math.max(30000, Math.min(900000, Number(args.timeoutMs ?? 180000)));
          const resolved = await deps.registry.resolve(vmid, { signal: exec?.signal });
          const node = resolved.node;
          const list = await deps.transport.run(node, `qm listsnapshot ${vmid}`, {
            timeoutMs: 30000,
            allowNonZero: true,
            signal: exec?.signal,
          });
          const snapshots = parseSnapshots(list.stdout);
          if (snapshots.length > 0 && !snapshots.includes(name)) {
            throw new VmError(
              'SNAPSHOT_NOT_FOUND',
              `VM ${vmid} has no snapshot "${name}"; it has: ${snapshots.join(', ')}`,
            );
          }
          // A recorder holds the QMP socket and would fail mid-rollback: stop it first.
          const paths = remotePaths(settings, vmid);
          await deps.stopBurst?.(node, vmid, paths);
          const previous = (await queryVmStatus(deps.transport, node, vmid)).status ?? 'unknown';
          let stopMs = 0;
          if (previous === 'running' || previous === 'paused') {
            const stopStart = Date.now();
            const stop = await deps.transport.run(node, `qm stop ${vmid}`, {
              timeoutMs: 120000,
              allowNonZero: true,
              signal: exec?.signal,
            });
            if (stop.code !== 0) {
              throw new VmError('VM_RUNNING', `qm stop failed: ${stop.stderr.trim().slice(0, 300) || stop.stdout.trim().slice(0, 300)}`);
            }
            const quiet = await waitFor(
              async () => (await queryVmStatus(deps.transport, node, vmid)).status === 'stopped',
              { timeoutMs: 120000, intervalMs: 500, signal: exec?.signal },
            );
            if (!quiet.ok) throw new VmError('VM_RUNNING', `VM ${vmid} did not reach the stopped state`);
            stopMs = Date.now() - stopStart;
          }
          const rollbackStart = Date.now();
          const rollback = await deps.transport.run(node, `qm rollback ${vmid} ${name}`, {
            timeoutMs: 300000,
            allowNonZero: true,
            signal: exec?.signal,
          });
          const rollbackMs = Date.now() - rollbackStart;
          if (rollback.code !== 0) {
            const text = `${rollback.stderr}\n${rollback.stdout}`;
            const code = /does not exist|no such|not found/i.test(text) ? 'SNAPSHOT_NOT_FOUND' : 'SSH_FAILED';
            throw new VmError(code, `qm rollback failed: ${text.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
          }
          const startStart = Date.now();
          const start = await deps.transport.run(node, `qm start ${vmid}`, {
            timeoutMs: 60000,
            allowNonZero: true,
            signal: exec?.signal,
          });
          const startMs = Date.now() - startStart;
          if (start.code !== 0) {
            throw new VmError('SSH_FAILED', `qm start failed: ${start.stderr.trim().slice(0, 300) || start.stdout.trim().slice(0, 300)}`);
          }
          // The guest-side session-1 bridge lives on disk: the rollback removed it.
          deps.bridge?.reset(vmid);
          const ready = await deps.registry.waitAgent(node, vmid, { timeoutMs: waitMs, signal: exec?.signal });
          if (!ready.ok) {
            throw new VmError('AGENT_TIMEOUT', `guest agent did not answer within ${Math.round(waitMs / 1000)} s of boot`, {
              vmid,
              node,
              snapshot: name,
              rollback_ms: rollbackMs,
              start_ms: startMs,
              previous_status: previous,
            });
          }
          return {
            ok: true,
            vmid,
            node,
            snapshot: name,
            rollback_ms: rollbackMs,
            stop_ms: stopMs,
            start_ms: startMs,
            agent_up_ms: ready.ms,
            previous_status: previous,
            snapshots,
            wall_ms: Date.now() - started,
          };
        });
      },
    }),
  ];
}
