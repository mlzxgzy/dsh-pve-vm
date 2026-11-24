/**
 * Moving VMs around the cluster: migrate, clone, delete.
 *
 * These three change the cluster rather than observe it, so each one states what it did and where
 * the VM ended up: a migration that reports "ok" without saying which node the VM is on now is
 * useless, and a clone that reports "ok" without the new id is worse.
 *
 * All three run on the node that owns the source VM (`qm` reads the local config), which is why they
 * resolve the owner first instead of trusting whatever host the caller named.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { VmError } from '../lib/errors.js';
import { findUpid, waitTask } from '../lib/tasks.js';
import { bodyOf, cloneCommand, destroyScript, migrateScript, nodeArg, parseRc, vmidArg } from '../lib/vmops.js';
import { NODE_PARAM, VMID_PARAM, schema, seconds, textRender, target } from './common.js';

/**
 * The node names the cluster knows, for validating a migration target.
 * @param {object} deps plugin wiring.
 * @param {object} args tool arguments.
 * @param {object} exec tool execution context.
 * @returns {Promise<string[]>} node names.
 */
async function clusterNodeNames(deps, args, exec) {
  const snapshot = await deps.registry.clusterView({ host: args.node, signal: exec.signal });
  return (snapshot?.nodes ?? []).map((node) => String(node.name));
}

/**
 * @param {object} deps plugin wiring.
 * @returns {object[]} the tool definitions.
 */
export function placementTools(deps) {
  return [
    defineTool({
      name: 'pve_vm_migrate',
      description:
        'Move a VM to another node of the cluster (`qm migrate`), optionally live and with its local ' +
        'disks. The target must be a node the cluster knows — the reply lists them when the name is ' +
        'wrong. Afterwards the tool re-reads the cluster so the reply says where the VM actually is, ' +
        'not where it was told to go.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        target: {
          type: 'string',
          required: true,
          description: 'Destination node name (e.g. "pve05") — a cluster node, not an address.',
        },
        online: { type: 'boolean', description: 'Live migration, without stopping the guest (default true).' },
        withLocalDisks: {
          type: 'boolean',
          description: 'Also move disks that live on the source node\'s local storage (`--with-local-disks 1`).',
        },
        targetstorage: { type: 'string', description: 'Storage id on the target for those disks.' },
        bwlimit: { type: 'number', description: 'Bandwidth limit in KiB/s (0 = unlimited).' },
        wait: { type: 'boolean', description: 'Wait for the migration task to finish (default true).' },
        timeoutMs: { type: 'number', description: 'Give up waiting after this long (default 600000).' },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'The VM that was moved.' },
          host: { type: 'string', description: 'Node address the command ran on (the old owner).' },
          node: { type: 'string', description: 'Node the VM was on before the migration.' },
          target: { type: 'string', description: 'Node asked for.' },
          new_node: { type: 'string', description: 'Node the VM is on after the migration, as the cluster sees it.' },
          new_host: { type: 'string', description: 'Address of that node.' },
          status: { type: 'string', description: 'VM state after the migration.' },
          task: { type: 'string', description: 'Task id, when qm printed one.' },
          task_state: { type: 'string', description: 'ok, failed, running, timeout or cancelled.' },
          exitstatus: { type: 'string', description: 'The task\'s own exit status.' },
          output: { type: 'string', description: 'Whatever qm printed.' },
          waited_ms: { type: 'number', description: 'Time spent waiting for the migration.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE VM migrate', (value) => {
          const from = value.node ?? value.host;
          const to = value.new_node ? `${value.new_node}${value.new_host ? ` (${value.new_host})` : ''}` : value.target;
          const lines = [
            `VM ${value.vmid}: moved from ${from} to ${to}${value.status ? `, ${value.status}` : ''}` +
              (value.waited_ms === undefined ? '' : ` in ${seconds(value.waited_ms)}`),
          ];
          if (value.task_state === 'running') lines.push(`  task ${value.task} is still running; poll it with pve_task action:"status"`);
          if (value.output) lines.push(`  ${String(value.output).split('\n').slice(-1)[0]}`);
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const wanted = nodeArg(args.target);
        const names = await clusterNodeNames(deps, args, exec);
        if (names.length > 0 && !names.includes(wanted)) {
          throw new VmError('BAD_ARGS', `"${wanted}" is not a node of this cluster`, { target: wanted, nodes: names });
        }
        const resolved = await target(deps, args, exec);
        if (resolved.node === wanted) {
          return {
            ok: true,
            vmid: resolved.vmid,
            host: resolved.host,
            ...(resolved.node === null ? {} : { node: resolved.node }),
            target: wanted,
            new_node: resolved.node,
            new_host: resolved.host,
            status: resolved.status,
            wall_ms: Date.now() - started,
          };
        }
        const run = await deps.transport.run(
          resolved.host,
          migrateScript(resolved.vmid, wanted, {
            online: args.online !== false,
            withLocalDisks: args.withLocalDisks === true,
            targetstorage: args.targetstorage,
            bwlimit: args.bwlimit,
          }),
          { timeoutMs: 900000, signal: exec.signal, allowNonZero: true },
        );
        const rc = parseRc(run.stdout);
        const output = bodyOf(run.stdout);
        const upid = findUpid(run.stdout);
        let taskState;
        let exitstatus;
        let waited = run.ms;
        if (upid && args.wait !== false) {
          const settled = await waitTask({
            transport: deps.transport,
            node: resolved.host,
            upid,
            timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 600000,
            signal: exec.signal,
          });
          taskState = settled.state;
          exitstatus = settled.exitstatus ?? undefined;
          waited = settled.ms;
          if (taskState === 'failed') {
            throw new VmError('TASK_FAILED', `migration task ended with ${exitstatus}`, { upid, exitstatus, output: output.slice(0, 300) });
          }
        }
        if (rc !== null && rc !== 0) {
          throw new VmError('SSH_FAILED', `qm migrate failed with exit code ${rc}`, { output: output.slice(0, 500) });
        }
        const after = await deps.registry.resolve(resolved.vmid, { host: args.node, signal: exec.signal, fresh: true });
        return {
          ok: true,
          vmid: resolved.vmid,
          host: resolved.host,
          ...(resolved.node === null ? {} : { node: resolved.node }),
          target: wanted,
          ...(after.node ? { new_node: after.node } : {}),
          ...(after.host ? { new_host: after.host } : {}),
          status: after.status,
          ...(upid ? { task: upid } : {}),
          ...(taskState ? { task_state: taskState } : {}),
          ...(exitstatus ? { exitstatus } : {}),
          ...(output ? { output: output.slice(0, 400) } : {}),
          waited_ms: waited,
          wall_ms: Date.now() - started,
        };
      },
    }),

    defineTool({
      name: 'pve_vm_clone',
      description:
        'Clone a VM or template into a new VM id (`qm clone`), optionally onto another node, another ' +
        'storage, and optionally a full copy instead of a linked one. This is how a lab creates a ' +
        'fresh machine from a template; the reply names the new id and where it landed.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'Source VM or template id.' },
        node: NODE_PARAM,
        newid: {
          type: 'number',
          required: true,
          description: 'Id for the new VM. Must be unused — the cluster list shows what is taken.',
        },
        name: { type: 'string', description: 'Name for the new VM.' },
        target: { type: 'string', description: 'Node to create it on (default: the source node).' },
        storage: { type: 'string', description: 'Target storage for the copied disks.' },
        full: { type: 'boolean', description: 'Full copy instead of a linked clone (default false).' },
        snapname: { type: 'string', description: 'Clone only up to this snapshot.' },
        pool: { type: 'string', description: 'Put the new VM into this resource pool.' },
        bwlimit: { type: 'number', description: 'Bandwidth limit in KiB/s (0 = unlimited).' },
        wait: { type: 'boolean', description: 'Wait for the clone task to finish (default true).' },
        timeoutMs: { type: 'number', description: 'Give up waiting after this long (default 900000).' },
      },
      output: {
        schema: schema({
          source_vmid: { type: 'number', description: 'The VM that was cloned.' },
          newid: { type: 'number', description: 'Id of the new VM.' },
          name: { type: 'string', description: 'Name given to the new VM.' },
          host: { type: 'string', description: 'Node address the command ran on.' },
          node: { type: 'string', description: 'Node the source VM was on.' },
          new_node: { type: 'string', description: 'Node the clone ended up on, as the cluster sees it.' },
          new_host: { type: 'string', description: 'Address of that node.' },
          status: { type: 'string', description: 'State of the new VM.' },
          task: { type: 'string', description: 'Task id, when qm printed one.' },
          task_state: { type: 'string', description: 'ok, failed, running, timeout or cancelled.' },
          exitstatus: { type: 'string', description: 'The task\'s own exit status.' },
          output: { type: 'string', description: 'Whatever qm printed.' },
          waited_ms: { type: 'number', description: 'Time spent waiting for the copy.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE VM clone', (value) => {
          const where = value.new_node ? `${value.new_node}${value.new_host ? ` (${value.new_host})` : ''}` : value.host;
          return (
            `cloned VM ${value.source_vmid} → VM ${value.newid}${value.name ? ` "${value.name}"` : ''} on ${where}` +
            `${value.status ? `, ${value.status}` : ''}${value.waited_ms === undefined ? '' : ` in ${seconds(value.waited_ms)}`}` +
            (value.output ? `\n  ${String(value.output).split('\n').slice(-1)[0]}` : '')
          );
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        vmidArg(args.vmid);
        vmidArg(args.newid);
        const resolved = await target(deps, { ...args, vmid: args.vmid }, exec);
        const { command } = cloneCommand(args.vmid, args.newid, {
          name: args.name,
          target: args.target,
          storage: args.storage,
          snapname: args.snapname,
          pool: args.pool,
          full: args.full === true,
          bwlimit: args.bwlimit,
        });
        const run = await deps.transport.run(resolved.host, `${command} 2>&1; echo "rc=$?"`, {
          timeoutMs: 1200000,
          signal: exec.signal,
          allowNonZero: true,
        });
        const rc = parseRc(run.stdout);
        const output = bodyOf(run.stdout);
        const upid = findUpid(run.stdout);
        let taskState;
        let exitstatus;
        let waited = run.ms;
        if (upid && args.wait !== false) {
          const settled = await waitTask({
            transport: deps.transport,
            node: resolved.host,
            upid,
            timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 900000,
            signal: exec.signal,
          });
          taskState = settled.state;
          exitstatus = settled.exitstatus ?? undefined;
          waited = settled.ms;
          if (taskState === 'failed') {
            throw new VmError('TASK_FAILED', `clone task ended with ${exitstatus}`, { upid, exitstatus, output: output.slice(0, 300) });
          }
        }
        if (rc !== null && rc !== 0) {
          const code = /already exists|in use/i.test(output) ? 'BAD_ARGS' : 'SSH_FAILED';
          throw new VmError(code, `qm clone failed with exit code ${rc}`, { output: output.slice(0, 500), newid: args.newid });
        }
        const after = await deps.registry.resolve(Number(args.newid), { host: args.node, signal: exec.signal, fresh: true });
        return {
          ok: true,
          source_vmid: Number(args.vmid),
          newid: Number(args.newid),
          ...(args.name ? { name: String(args.name) } : {}),
          host: resolved.host,
          ...(resolved.node === null ? {} : { node: resolved.node }),
          ...(after.node ? { new_node: after.node } : {}),
          ...(after.host ? { new_host: after.host } : {}),
          status: after.status,
          ...(upid ? { task: upid } : {}),
          ...(taskState ? { task_state: taskState } : {}),
          ...(exitstatus ? { exitstatus } : {}),
          ...(output ? { output: output.slice(0, 400) } : {}),
          waited_ms: waited,
          wall_ms: Date.now() - started,
        };
      },
    }),

    defineTool({
      name: 'pve_vm_delete',
      description:
        'Destroy a VM: its config, its disks, and its place in the cluster (`qm destroy --purge`). This ' +
        'is irreversible, so it requires `confirm:true` and refuses a running VM unless `stop:true` — ' +
        'and when it does run, the reply says what was destroyed. Use pve_vm_power to stop a VM you ' +
        'want to keep.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'The VM to destroy. Be sure: there is no undo.' },
        node: NODE_PARAM,
        confirm: { type: 'boolean', required: true, description: 'Must be true: destroying a VM cannot be undone.' },
        purge: { type: 'boolean', description: 'Remove the VM from backup jobs, HA and resource pools too (default true).' },
        destroyUnreferencedDisks: { type: 'boolean', description: 'Also delete disks no other VM references.' },
        stop: { type: 'boolean', description: 'Stop the VM first if it is running (default false: refuse instead).' },
        wait: { type: 'boolean', description: 'Wait for the destroy task to finish (default true).' },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'The VM that was destroyed.' },
          host: { type: 'string', description: 'Node address the command ran on.' },
          node: { type: 'string', description: 'Node the VM was on.' },
          name: { type: 'string', description: 'Name of the VM, when the cluster still knew it.' },
          previous_status: { type: 'string', description: 'State before the destroy.' },
          task: { type: 'string', description: 'Task id, when qm printed one.' },
          task_state: { type: 'string', description: 'ok, failed, running, timeout or cancelled.' },
          exitstatus: { type: 'string', description: 'The task\'s own exit status.' },
          output: { type: 'string', description: 'Whatever qm printed.' },
          waited_ms: { type: 'number', description: 'Time spent waiting for the destroy.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE VM delete', (value) => {
          const where = value.node ? `${value.node} (${value.host})` : value.host;
          return (
            `destroyed VM ${value.vmid}${value.name ? ` "${value.name}"` : ''} on ${where}` +
            (value.previous_status ? ` (was ${value.previous_status})` : '') +
            (value.waited_ms === undefined ? '' : ` in ${seconds(value.waited_ms)}`)
          );
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        if (args.confirm !== true) {
          throw new VmError('SNAPSHOT_CONFIRM_REQUIRED', 'destroying a VM cannot be undone', {
            vmid: args.vmid,
            hint: 'Pass confirm:true to destroy it, or use pve_vm_power to stop it instead.',
          });
        }
        const resolved = await target(deps, args, exec);
        const name =
          (await deps.registry.listVms({ host: args.node, signal: exec.signal }).catch(() => null))?.vms?.find(
            (vm) => vm.vmid === resolved.vmid,
          )?.name ?? undefined;
        if (resolved.status === 'running' && args.stop !== true) {
          throw new VmError('VM_RUNNING', `VM ${resolved.vmid} is running`, {
            vmid: resolved.vmid,
            hint: 'Stop it with pve_vm_power action:"stop", or pass stop:true to let this call do it.',
          });
        }
        if (resolved.status === 'running') {
          await deps.transport.run(resolved.host, `qm stop ${resolved.vmid} 2>&1; echo "rc=$?"`, {
            timeoutMs: 120000,
            signal: exec.signal,
            allowNonZero: true,
          });
        }
        const run = await deps.transport.run(
          resolved.host,
          destroyScript(resolved.vmid, { purge: args.purge !== false, destroyUnreferencedDisks: args.destroyUnreferencedDisks === true }),
          { timeoutMs: 300000, signal: exec.signal, allowNonZero: true },
        );
        const rc = parseRc(run.stdout);
        const output = bodyOf(run.stdout);
        const upid = findUpid(run.stdout);
        let taskState;
        let exitstatus;
        let waited = run.ms;
        if (upid && args.wait !== false) {
          const settled = await waitTask({
            transport: deps.transport,
            node: resolved.host,
            upid,
            timeoutMs: 300000,
            signal: exec.signal,
          });
          taskState = settled.state;
          exitstatus = settled.exitstatus ?? undefined;
          waited = settled.ms;
          if (taskState === 'failed') {
            throw new VmError('TASK_FAILED', `destroy task ended with ${exitstatus}`, { upid, exitstatus });
          }
        }
        if (rc !== null && rc !== 0) {
          throw new VmError('SSH_FAILED', `qm destroy failed with exit code ${rc}`, { output: output.slice(0, 500) });
        }
        deps.registry.clear();
        return {
          ok: true,
          vmid: resolved.vmid,
          host: resolved.host,
          ...(resolved.node === null ? {} : { node: resolved.node }),
          ...(name ? { name } : {}),
          previous_status: resolved.status,
          ...(upid ? { task: upid } : {}),
          ...(taskState ? { task_state: taskState } : {}),
          ...(exitstatus ? { exitstatus } : {}),
          ...(output ? { output: output.slice(0, 300) } : {}),
          waited_ms: waited,
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
