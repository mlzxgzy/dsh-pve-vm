/**
 * Lifecycle tools: what the cluster looks like, and rolling a VM back to a snapshot.
 *
 * Nothing here knows a host or a VM id in advance — `pve_vm_status` answers "what is running where"
 * with `qm list` on every known host, and every other tool resolves the owner of a VM with
 * `qm status` at call time.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { VmError } from '../lib/errors.js';
import { remotePaths } from '../lib/config.js';
import { agentPing, queryVmStatus, waitFor } from '../lib/ssh.js';
import { NODE_PARAM, VMID_PARAM, schema, seconds, textRender, target } from './common.js';

/** How many stopped VMs the cluster view lists before it summarises the rest. */
const MAX_LISTED_STOPPED = 12;

/** Snapshot names accepted by `qm rollback`. */
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Snapshot names in a `qm listsnapshot` table.
 * @param {string} stdout table text.
 * @returns {string[]} names, oldest first.
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
 * The lifecycle tools.
 * @param {object} deps plugin wiring.
 * @returns {object[]} tool definitions.
 */
export function lifecycleTools(deps) {
  return [
    defineTool({
      name: 'pve_vm_status',
      description:
        'Show the PVE cluster as it is right now: every known host (`qm list`), every VM with its ' +
        'status and owner node, and — for one VM — the guest agent answer and whether a frame ' +
        'recorder is running. Use it first: every other tool discovers the host the same way, so ' +
        'this call is also the cheapest way to prove that ssh and the VPN work.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        fresh: {
          type: 'boolean',
          description: 'Ignore the cached cluster listing and ask the hosts again (default false).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'The VM the detail block is about, when one was chosen.' },
          host: { type: 'string', description: 'ssh host (alias or address) that owns the VM.' },
          node: { type: 'string', description: 'PVE node name as the host reported it (`hostname`).' },
          status: { type: 'string', description: 'VM status: running, stopped, paused or suspended.' },
          agent: {
            type: 'string',
            enum: ['ok', 'down', 'unknown'],
            description: 'Guest agent: ok when `qm agent ping` exits 0, unknown when the VM is not running.',
          },
          agent_ms: { type: 'number', description: 'How long the agent ping took, milliseconds.' },
          source: {
            type: 'string',
            description: 'Where the vmid came from: call, default (settings) or discovered (the only running VM).',
          },
          burst: { type: 'boolean', description: 'A frame recorder is running for this VM.' },
          frames: { type: 'number', description: 'Frames recorded so far by that recorder.' },
          hosts: {
            type: 'array',
            items: { type: 'object', properties: {}, additionalProperties: true },
            description: 'Per host: host, node name, whether `qm list` answered, and the error when it did not.',
          },
          vms: {
            type: 'array',
            items: { type: 'object', properties: {}, additionalProperties: true },
            description: 'Every VM seen: vmid, name, status, node, host, mem_mb, disk_gb.',
          },
          picked: {
            type: 'number',
            description: 'The VM a call without `vmid` would work on, when exactly one is running.',
          },
          vm_total: { type: 'number', description: 'VMs seen on the reachable hosts in total.' },
          vms_truncated: {
            type: 'boolean',
            description: 'Only running VMs and the first dozen stopped ones are listed; the rest is counted.',
          },
          running_count: { type: 'number', description: 'How many of those VMs were running.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE cluster', (value) => {
          const lines = [];
          for (const host of value.hosts ?? []) {
            lines.push(host.ok ? `  ${host.host} → ${host.node}` : `  ${host.host} → unreachable (${host.error})`);
          }
          const where = (vm) => (vm.node === null || vm.node === undefined ? vm.host : `${vm.node} (${vm.host})`);
          if (value.vmid !== undefined) {
            // One VM was asked for: the rest of the cluster is noise in this reply.
            const match = (value.vms ?? []).find((vm) => vm.vmid === value.vmid);
            const on = value.node === null || value.node === undefined ? value.host : `${value.node} (${value.host})`;
            lines.push(
              `VM ${value.vmid}${match ? ` ${match.name}` : ''} on ${on}: ${value.status}; guest agent ${value.agent}` +
                (value.agent_ms === undefined ? '' : ` (${seconds(value.agent_ms)})`) +
                (value.burst === true ? `; recording, ${value.frames ?? 0} frames so far` : ''),
            );
            return lines.join('\n');
          }
          let listed = 0;
          for (const vm of value.vms ?? []) {
            lines.push(`  VM ${vm.vmid} ${vm.name}: ${vm.status} on ${where(vm)}`);
            listed += 1;
          }
          if (value.vms_truncated === true) {
            const hidden = (value.vm_total ?? listed) - listed;
            lines.push(`  … and ${hidden} more (stopped) VMs; pass vmid or node to look at one`);
          }
          if (value.picked !== undefined) {
            lines.push('');
            lines.push(`A call without vmid would use VM ${value.picked} (the only one running).`);
          }
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const signal = exec.signal;
        const settings = deps.settings();
        const started = Date.now();
        const wanted =
          args.vmid !== undefined && args.vmid !== null
            ? args.vmid
            : settings.defaultVmid > 0
              ? settings.defaultVmid
              : null;
        let view = null;
        try {
          view = await deps.registry.listVms({ host: args.node, signal, fresh: args.fresh === true });
        } catch (error) {
          // An explicit vmid still works when the listing failed for one of several hosts.
          if (wanted === null) throw error;
        }
        // The listing stays bounded: a lab host easily carries 80 stopped templates, and a reply
        // that long costs more context than the answer is worth.
        const all = view?.vms ?? [];
        const runningVms = all.filter((vm) => vm.status === 'running');
        const stopped = all.filter((vm) => vm.status !== 'running');
        const listed = [...runningVms, ...stopped.slice(0, MAX_LISTED_STOPPED)];
        const base = {
          hosts: view?.hosts ?? [],
          vms: listed,
          vm_total: all.length,
          running_count: runningVms.length,
          ...(listed.length < all.length ? { vms_truncated: true } : {}),
        };
        if (wanted === null) {
          return {
            ok: true,
            ...base,
            ...(runningVms.length === 1 ? { picked: runningVms[0].vmid } : {}),
            wall_ms: Date.now() - started,
          };
        }
        const resolved = await target(deps, args, exec);
        const paths = remotePaths(settings, resolved.vmid);
        let agent = 'unknown';
        let agentMs;
        if (resolved.status === 'running') {
          const pingStarted = Date.now();
          agent = (await agentPing(deps.transport, resolved.host, resolved.vmid)) ? 'ok' : 'down';
          agentMs = Date.now() - pingStarted;
        }
        const burst = await deps.burstStatus(resolved.host, resolved.vmid, paths).catch(() => null);
        return {
          ok: true,
          vmid: resolved.vmid,
          host: resolved.host,
          node: resolved.node,
          status: resolved.status,
          agent,
          ...(agentMs === undefined ? {} : { agent_ms: agentMs }),
          source: resolved.source,
          burst: burst?.running === true,
          ...(burst?.running === true ? { frames: burst.frames } : {}),
          ...base,
          wall_ms: Date.now() - started,
        };
      },
    }),

    defineTool({
      name: 'pve_snapshot',
      description:
        'Roll a VM back to a snapshot and boot it: stop it, `qm rollback`, `qm start`, then wait until ' +
        'the guest agent answers again (typically 30–90 s). This destroys the current disk state, so ' +
        'the call is refused unless `confirm:true` is passed, and the result names the snapshot that ' +
        'was restored. Frames already recorded on the node tmpfs are left alone.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        snapshot: {
          type: 'string',
          description: 'Snapshot name to restore (as `qm listsnapshot` shows it). Default "init".',
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true. Rolling back destroys the current VM state; without it the call is refused ' +
            'with SNAPSHOT_CONFIRM_REQUIRED.',
        },
        timeoutMs: {
          type: 'number',
          description: 'How long to wait for the guest agent after boot, milliseconds (default 180000).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM that was rolled back.' },
          host: { type: 'string', description: 'ssh host that owns the VM.' },
          node: { type: 'string', description: 'PVE node name.' },
          snapshot: { type: 'string', description: 'The snapshot that was restored (state is destroyed to it).' },
          previous_status: { type: 'string', description: 'The VM status before the rollback.' },
          rollback_ms: { type: 'number', description: 'Duration of `qm rollback`, milliseconds.' },
          stop_ms: { type: 'number', description: 'Duration of the stop phase, milliseconds (0 when already stopped).' },
          start_ms: { type: 'number', description: 'Duration of `qm start`, milliseconds.' },
          agent_up_ms: { type: 'number', description: 'Milliseconds from `qm start` until the agent answered.' },
          snapshots: {
            type: 'array',
            items: { type: 'string' },
            description: 'Snapshot names the VM had before the rollback.',
          },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('Snapshot restored', (value) =>
          [
            `rolled back VM ${value.vmid} on ${value.node ?? value.host} to snapshot "${value.snapshot}" and booted it.`,
            `rollback ${seconds(value.rollback_ms)}` +
              (value.stop_ms ? `; stop ${seconds(value.stop_ms)}` : '') +
              `; guest agent up ${seconds(value.agent_up_ms)} after start` +
              `; total ${seconds(value.wall_ms)}`,
            value.snapshots?.length ? `other snapshots: ${value.snapshots.join(', ')}` : 'other snapshots: none',
          ].join('\n'),
        ),
      },
      async execute(args, exec) {
        if (args.confirm !== true) {
          throw new VmError(
            'SNAPSHOT_CONFIRM_REQUIRED',
            'a rollback destroys the current VM state and was not confirmed',
          );
        }
        const name = String(args.snapshot ?? 'init').trim();
        if (!SNAPSHOT_NAME.test(name)) {
          throw new VmError('BAD_ARGS', `snapshot name ${JSON.stringify(name)} is not a valid snapshot name`);
        }
        const signal = exec.signal;
        const started = Date.now();
        const timeoutMs = Math.max(60000, Number(args.timeoutMs ?? 180000));
        const resolved = await target(deps, args, exec);
        const { vmid, host, node } = resolved;

        const listing = await deps.transport.run(host, `qm listsnapshot ${vmid} 2>&1`, {
          timeoutMs: 20000,
          signal,
          allowNonZero: true,
        });
        const snapshots = parseSnapshots(listing.stdout);
        if (!snapshots.includes(name)) {
          throw new VmError('SNAPSHOT_NOT_FOUND', `VM ${vmid} has no snapshot "${name}"`, {
            snapshot: name,
            snapshots,
          });
        }

        // A recorder would keep opening QMP sockets across the stop/rollback and fail frame after
        // frame; it is stopped first and reported in the result.
        const paths = remotePaths(deps.settings(), vmid);
        await deps.stopBurst(host, vmid, paths).catch(() => null);

        const previous = await queryVmStatus(deps.transport, host, vmid);
        const previousStatus = previous.status ?? resolved.status;
        let stopMs = 0;
        if (previousStatus === 'running' || previousStatus === 'paused') {
          const stopStarted = Date.now();
          await deps.transport.run(host, `qm stop ${vmid} 2>&1`, { timeoutMs: 60000, signal });
          const stopped = await waitFor(
            async () => (await queryVmStatus(deps.transport, host, vmid)).status === 'stopped',
            { timeoutMs: 90000, intervalMs: 1000, signal },
          );
          stopMs = Date.now() - stopStarted;
          if (!stopped.ok) {
            throw new VmError('VM_RUNNING', `VM ${vmid} did not stop within 90 s`, { vmid, stop_ms: stopMs });
          }
        }

        const rollbackStarted = Date.now();
        const rollback = await deps.transport.run(host, `qm rollback ${vmid} ${name} 2>&1`, {
          timeoutMs: 300000,
          signal,
          allowNonZero: true,
        });
        const rollbackMs = Date.now() - rollbackStarted;
        if (rollback.code !== 0) {
          throw new VmError('SNAPSHOT_NOT_FOUND', `qm rollback ${vmid} ${name} failed: ${rollback.stdout.trim()}`, {
            vmid,
            snapshot: name,
            rollback_ms: rollbackMs,
          });
        }

        const startStarted = Date.now();
        const start = await deps.transport.run(host, `qm start ${vmid} 2>&1`, {
          timeoutMs: 120000,
          signal,
          allowNonZero: true,
        });
        const startMs = Date.now() - startStarted;
        if (start.code !== 0 && !/already running/i.test(start.stdout)) {
          throw new VmError('SSH_FAILED', `qm start ${vmid} failed: ${start.stdout.trim()}`, { vmid, start_ms: startMs });
        }
        // The VM was rebuilt from the snapshot: the session-1 bridge and the cached host mapping
        // both describe a machine that no longer exists.
        deps.bridge.reset(vmid);
        deps.registry.clear();

        const ready = await deps.registry.waitAgent(host, vmid, { timeoutMs, signal });
        if (!ready.ok) {
          throw new VmError('AGENT_TIMEOUT', `guest agent of VM ${vmid} did not answer within ${seconds(timeoutMs)}`, {
            vmid,
            snapshot: name,
            rollback_ms: rollbackMs,
            start_ms: startMs,
            previous_status: previousStatus,
          });
        }
        return {
          ok: true,
          vmid,
          host,
          node,
          snapshot: name,
          previous_status: previousStatus,
          rollback_ms: rollbackMs,
          stop_ms: stopMs,
          start_ms: startMs,
          agent_up_ms: ready.ms,
          snapshots: snapshots.filter((entry) => entry !== name),
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
