/**
 * Snapshot management: list, create, delete, roll back.
 *
 * `pve_snapshot` already covers the one destructive operation this plugin started with — roll back
 * to `init` and wait for the agent to come back. This tool is the general form: what snapshots
 * exist, take one, throw one away. Rollback here does not wait for the guest agent; use
 * `pve_snapshot` when the next step needs a working guest.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { VmError } from '../lib/errors.js';
import { bodyOf, configScript, parseConfig, parseRc, snapshotScript } from '../lib/vmops.js';
import { NODE_PARAM, VMID_PARAM, schema, seconds, textRender, target } from './common.js';

const ACTIONS = ['list', 'create', 'delete', 'rollback'];

/**
 * @param {object} deps plugin wiring.
 * @returns {object[]} the tool definitions.
 */
export function snapshotTools(deps) {
  return [
    defineTool({
      name: 'pve_vm_snapshot',
      description:
        'List, create, delete or roll back VM snapshots. Rolling back discards everything the guest did ' +
        'since the snapshot — including open files and running services — so a rollback requires ' +
        '`confirm:true`, and the reply names the snapshot that was restored. Creating a snapshot with ' +
        '`vmstate:true` also saves the RAM state (the VM must be stopped for disk-only snapshots on ' +
        'some storages).',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        action: {
          type: 'string',
          enum: ACTIONS,
          required: true,
          description: 'list (default view), create, delete, or rollback (destroys current state; needs confirm).',
        },
        name: {
          type: 'string',
          description: 'Snapshot name for create/delete/rollback: letters, digits, dot, dash, underscore. Required there.',
        },
        description: { type: 'string', description: 'Description stored with a new snapshot.' },
        vmstate: { type: 'boolean', description: 'For create: include the RAM state (`qm snapshot --vmstate 1`).' },
        force: { type: 'boolean', description: 'For delete: remove the config entry even if a disk snapshot cannot be removed.' },
        confirm: {
          type: 'boolean',
          description: 'Required by rollback: it throws away the current VM state.',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'The VM the snapshots belong to.' },
          host: { type: 'string', description: 'Node address the command was run on.' },
          node: { type: 'string', description: 'PVE node name.' },
          action: { type: 'string', enum: ACTIONS, description: 'The action that was requested.' },
          name: { type: 'string', description: 'Snapshot name the action named.' },
          snapshots: {
            type: 'array',
            description: 'Snapshots on the VM after the action, oldest first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: 'Snapshot name.' },
                at: { type: 'string', description: 'When it was taken.' },
                description: { type: 'string', description: 'Description, when set.' },
              },
            },
          },
          count: { type: 'number', description: 'How many snapshots the VM has.' },
          status: { type: 'string', description: 'VM state after the action.' },
          output: { type: 'string', description: 'Whatever qm printed.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE VM snapshot', (value) => {
          const where = value.node ? `${value.node} (${value.host})` : value.host;
          const lines = [`VM ${value.vmid} on ${where}: ${value.count ?? 0} snapshot(s), ${value.status ?? 'unknown'}`];
          for (const entry of value.snapshots ?? []) {
            lines.push(`  ${entry.name}  ${entry.at}${entry.description ? `  ${entry.description}` : ''}`);
          }
          if (value.action !== 'list') {
            lines.push(
              `${value.action} ${value.name ?? ''} done${value.wall_ms === undefined ? '' : ` in ${seconds(value.wall_ms)}`}` +
                (value.action === 'rollback' ? `; the VM is now at snapshot "${value.name}"` : ''),
            );
          }
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const action = String(args.action ?? 'list').trim();
        if (!ACTIONS.includes(action)) throw new VmError('BAD_ARGS', `"${action}" is not a snapshot action`, { allowed: ACTIONS });
        if (action !== 'list' && !String(args.name ?? '').trim()) {
          throw new VmError('BAD_ARGS', `action "${action}" needs a snapshot name`, { action });
        }
        if (action === 'rollback' && args.confirm !== true) {
          throw new VmError('SNAPSHOT_CONFIRM_REQUIRED', 'a rollback throws away the current VM state', {
            snapshot: args.name,
            hint: 'Pass confirm:true to roll back to this snapshot.',
          });
        }
        const resolved = await target(deps, args, exec);
        let lastOutput = '';
        if (action !== 'list') {
          const run = await deps.transport.run(
            resolved.host,
            snapshotScript(resolved.vmid, action, args.name, {
              description: args.description,
              vmstate: args.vmstate === true,
              force: args.force === true,
            }),
            { timeoutMs: 300000, signal: exec.signal, allowNonZero: true },
          );
          const rc = parseRc(run.stdout);
          const output = bodyOf(run.stdout);
          if (rc !== null && rc !== 0) {
            const code = /already exists/i.test(output)
              ? 'SNAPSHOT_EXISTS'
              : /does not exist|no such snapshot|not found/i.test(output)
                ? 'SNAPSHOT_NOT_FOUND'
                : 'SSH_FAILED';
            throw new VmError(code, `\`qm ${action === 'create' ? 'snapshot' : action === 'delete' ? 'delsnapshot' : 'rollback'}\` failed`, {
              action,
              name: args.name,
              rc,
              output: output.slice(0, 400),
            });
          }
          lastOutput = output;
        }
        const listing = await deps.transport.run(resolved.host, configScript(resolved.vmid), {
          timeoutMs: 45000,
          signal: exec.signal,
          allowNonZero: true,
        });
        const snapshotPart = /###SNAPSHOTS\n([\s\S]*?)\n###STATUS/.exec(listing.stdout)?.[1] ?? '';
        const statusPart = /###STATUS\n([\s\S]*?)\n###END/.exec(listing.stdout)?.[1] ?? '';
        const parsed = parseConfig('', snapshotPart);
        const statusMatch = /status:\s*([a-z]+)/i.exec(statusPart);
        return {
          ok: true,
          vmid: resolved.vmid,
          host: resolved.host,
          ...(resolved.node === null ? {} : { node: resolved.node }),
          action,
          ...(args.name ? { name: String(args.name) } : {}),
          snapshots: parsed.snapshots,
          count: parsed.snapshots.length,
          ...(statusMatch ? { status: statusMatch[1] } : {}),
          ...(lastOutput ? { output: lastOutput.slice(0, 300) } : {}),
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
