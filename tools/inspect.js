/**
 * "What is this VM?" — one call that answers the question the screenshot cannot.
 *
 * Reading `qm config` is cheap and tells an agent what it is looking at (cores, memory, disks,
 * networks, boot order, whether the agent is enabled) before it starts clicking. The guest's own
 * view — IP addresses, OS version — comes from the QGA and is optional, because a VM whose agent is
 * down is exactly the case where the config still matters.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  bodyOf,
  configScript,
  guestCmdScript,
  parseConfig,
  parseInterfaces,
  parseOsInfo,
  parseStatusLine,
} from '../lib/vmops.js';
import { NODE_PARAM, VMID_PARAM, schema, seconds, textRender, target } from './common.js';

/** How much of the raw `qm config` is worth keeping in the reply. */
const RAW_LIMIT = 6000;

/**
 * @param {object} deps plugin wiring.
 * @returns {object[]} the tool definitions.
 */
export function inspectTools(deps) {
  return [
    defineTool({
      name: 'pve_vm_config',
      description:
        'Read a VM\'s configuration the way `qm config` shows it — cores, sockets, memory, OS type, ' +
        'disks, network interfaces, boot order, whether the guest agent is enabled — plus its ' +
        'snapshots, its current state, and (when the agent answers) the OS name and the IP addresses ' +
        'the guest actually has. Use this before clicking: coordinates mean nothing until you know ' +
        'which VM and which desktop you are looking at.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        current: {
          type: 'boolean',
          description: 'Read the running config instead of the stored one (`qm config --current 1`).',
        },
        network: {
          type: 'boolean',
          description: 'Ask the guest agent for its interfaces and IP addresses (default true; skipped when the VM is not running).',
        },
        osinfo: {
          type: 'boolean',
          description: 'Ask the guest agent for the OS name and version (default true; costs one extra agent round trip).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'The VM that was read.' },
          host: { type: 'string', description: 'Node address the config was read from.' },
          node: { type: 'string', description: 'PVE node name.' },
          status: { type: 'string', description: 'Current VM state (running, stopped, paused).' },
          name: { type: 'string', description: 'VM name from the config.' },
          cores: { type: 'number', description: 'Cores per socket.' },
          sockets: { type: 'number', description: 'Number of sockets.' },
          memory_mb: { type: 'number', description: 'Configured memory in MiB.' },
          ostype: { type: 'string', description: 'PVE guest OS type key (win10, l26, other…).' },
          boot: { type: 'string', description: 'Boot order / boot devices.' },
          agent: { type: 'boolean', description: 'Whether the QEMU guest agent is enabled in the config.' },
          scsihw: { type: 'string', description: 'SCSI controller model.' },
          bios: { type: 'string', description: 'BIOS/firmware (seabios or ovmf).' },
          machine: { type: 'string', description: 'Machine type passed to qemu.' },
          onboot: { type: 'boolean', description: 'Whether the VM starts with the node.' },
          disks: {
            type: 'array',
            description: 'Disk entries as PVE states them (key is the bus slot, value is the volume).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', description: 'Bus slot, e.g. scsi0.' },
                value: { type: 'string', description: 'Volume and options, as in qm config.' },
              },
            },
          },
          nets: {
            type: 'array',
            description: 'Network entries (net0, net1…) as PVE states them.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', description: 'NIC slot, e.g. net0.' },
                value: { type: 'string', description: 'Model, bridge and MAC, as in qm config.' },
              },
            },
          },
          interfaces: {
            type: 'array',
            description: 'IP addresses reported by the guest agent (loopback and link-local removed).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                interface: { type: 'string', description: 'Guest interface name.' },
                mac: { type: 'string', description: 'MAC address of the interface.' },
                ip: { type: 'string', description: 'The address.' },
                type: { type: 'string', description: 'ipv4 or ipv6.' },
                prefix: { type: 'number', description: 'Prefix length.' },
              },
            },
          },
          os: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'OS name reported by the agent.' },
              pretty_name: { type: 'string', description: 'Pretty OS name, when the agent has one.' },
              version: { type: 'string', description: 'OS version.' },
              version_id: { type: 'string', description: 'OS version id.' },
              kernel: { type: 'string', description: 'Kernel release.' },
              machine: { type: 'string', description: 'Machine/arch string.' },
              hostname: { type: 'string', description: 'Guest hostname.' },
            },
            description: 'Guest OS identity from the QGA, when it answers.',
          },
          snapshots: {
            type: 'array',
            description: 'Snapshots on this VM, oldest first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: 'Snapshot name.' },
                at: { type: 'string', description: 'When it was taken (node local time).' },
                description: { type: 'string', description: 'Snapshot description, when set.' },
              },
            },
          },
          config: {
            type: 'object',
            properties: {},
            additionalProperties: true,
            description: 'Every key from qm config, verbatim.',
          },
          raw: { type: 'string', description: 'The first part of the raw qm config text.' },
          agent_error: { type: 'string', description: 'Why the guest agent did not answer, when it did not.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE VM config', (value) => {
          const where = value.node ? `${value.node} (${value.host})` : value.host;
          const lines = [];
          const cpu = value.cores && value.sockets ? `${value.sockets}×${value.cores} vCPU` : null;
          lines.push(
            `VM ${value.vmid} ${value.name ?? ''} on ${where}: ${value.status ?? 'unknown'}` +
              (cpu ? `, ${cpu}` : '') +
              (value.memory_mb ? `, ${value.memory_mb} MiB` : '') +
              (value.ostype ? `, ${value.ostype}` : ''),
          );
          for (const disk of value.disks ?? []) lines.push(`  disk ${disk.key}: ${disk.value}`);
          for (const net of value.nets ?? []) lines.push(`  net  ${net.key}: ${net.value}`);
          if (value.interfaces?.length) {
            lines.push(`  guest IPs: ${value.interfaces.map((entry) => `${entry.ip} (${entry.interface})`).join(', ')}`);
          }
          if (value.os?.name || value.os?.pretty_name) {
            const label = value.os.pretty_name ?? value.os.name ?? 'unknown';
            const version = /^[\d]/.test(String(value.os.version ?? '')) ? ` ${value.os.version}` : '';
            lines.push(`  guest OS: ${label}${version}`);
          }
          if (value.snapshots?.length) {
            lines.push(`  snapshots: ${value.snapshots.map((entry) => entry.name).join(', ')}`);
          } else {
            lines.push('  snapshots: none');
          }
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const resolved = await target(deps, args, exec);
        const run = await deps.transport.run(resolved.host, configScript(resolved.vmid, { current: args.current === true }), {
          timeoutMs: 45000,
          signal: exec.signal,
          allowNonZero: true,
        });
        const text = run.stdout;
        const configPart = /###CONFIG\n([\s\S]*?)\n###SNAPSHOTS/.exec(text)?.[1] ?? '';
        const snapshotPart = /###SNAPSHOTS\n([\s\S]*?)\n###STATUS/.exec(text)?.[1] ?? '';
        const statusPart = /###STATUS\n([\s\S]*?)\n###END/.exec(text)?.[1] ?? '';
        if (!configPart.trim()) {
          throw new Error(`qm config returned nothing: ${bodyOf(text).slice(0, 300)}`);
        }
        const config = parseConfig(configPart, snapshotPart);
        const status = parseStatusLine(statusPart) ?? resolved.status;
        let interfaces;
        let os;
        let agentError;
        if (status === 'running' && args.network !== false) {
          try {
            const probe = await deps.transport.run(resolved.host, guestCmdScript(resolved.vmid, 'network-get-interfaces'), {
              timeoutMs: 30000,
              signal: exec.signal,
              allowNonZero: true,
            });
            interfaces = parseInterfaces(bodyOf(probe.stdout));
            if (interfaces === null) interfaces = [];
          } catch (error) {
            agentError = error instanceof Error ? error.message : String(error);
          }
        }
        if (status === 'running' && args.osinfo !== false) {
          try {
            const probe = await deps.transport.run(resolved.host, guestCmdScript(resolved.vmid, 'get-osinfo'), {
              timeoutMs: 30000,
              signal: exec.signal,
              allowNonZero: true,
            });
            os = parseOsInfo(bodyOf(probe.stdout)) ?? undefined;
          } catch (error) {
            agentError = agentError ?? (error instanceof Error ? error.message : String(error));
          }
        }
        return {
          ok: true,
          vmid: resolved.vmid,
          host: resolved.host,
          ...(resolved.node === null ? {} : { node: resolved.node }),
          status,
          ...(config.name ? { name: config.name } : {}),
          ...(config.cores === null ? {} : { cores: config.cores }),
          ...(config.sockets === null ? {} : { sockets: config.sockets }),
          ...(config.memory_mb === null ? {} : { memory_mb: config.memory_mb }),
          ...(config.ostype ? { ostype: config.ostype } : {}),
          ...(config.boot ? { boot: config.boot } : {}),
          ...(config.agent === null ? {} : { agent: config.agent }),
          ...(config.scsihw ? { scsihw: config.scsihw } : {}),
          ...(config.bios ? { bios: config.bios } : {}),
          ...(config.machine ? { machine: config.machine } : {}),
          ...(config.onboot === null ? {} : { onboot: config.onboot }),
          disks: config.disks,
          nets: config.nets,
          ...(interfaces ? { interfaces } : {}),
          ...(os ? { os } : {}),
          snapshots: config.snapshots,
          config: config.config,
          raw: configPart.slice(0, RAW_LIMIT),
          ...(agentError ? { agent_error: agentError.slice(0, 300) } : {}),
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
