/**
 * Cluster tools: what the cluster is, and what lives in it.
 *
 * The plugin connects to a cluster, not to a node: one seed host answers with the membership
 * file and the resource inventory, and both tools below read that one snapshot. `node` is only a
 * hint for *which* seed to ask — the answer always describes the whole cluster, because that is
 * what an operator means by "where is my VM".
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { NODE_PARAM, schema, textRender } from './common.js';
import { Cluster } from '../lib/cluster.js';

/** How many nodes are printed before the list is summarised. */
const MAX_LISTED_NODES = 40;

/** Bytes → a short human string ("772.0 GB"). */
const gb = (bytes) => `${(Number(bytes ?? 0) / 1073741824).toFixed(1)} GB`;

/** A percentage with one decimal. */
const pct = (value) => `${Number(value ?? 0).toFixed(1)}%`;

/** Resource filters for {@link assetTool}. */
const ASSET_TYPES = ['vm', 'qemu', 'lxc', 'storage', 'node', 'all'];

export function clusterTools(deps) {
  return [
    defineTool({
      name: 'pve_cluster_status',
      description:
        'Show the Proxmox VE cluster as a whole: its name, whether it is quorate, how many of its ' +
        'nodes are online, and per node the management address, running/total VM count, CPU and ' +
        'memory use. Reads `/etc/pve/.members`, `pvecm status` and `pvesh get /cluster/resources` ' +
        'from one seed host (`node`, else settings `hosts`, else `PVE_HOSTS`), so a 7-node cluster ' +
        'costs one ssh round trip. Use this before touching a VM when you do not already know ' +
        'which node it is on.',
      parameters: {
        node: NODE_PARAM,
        fresh: { type: 'boolean', description: 'Ignore the cached inventory and read the cluster again.' },
      },
      output: {
        schema: schema({
          cluster: { type: 'string', description: 'Cluster name from `/etc/pve/.members`.' },
          quorate: { type: 'boolean', description: 'The cluster has quorum right now.' },
          standalone: { type: 'boolean', description: 'The seed host is not in a cluster.' },
          expected_votes: { type: 'number', description: 'Votes the cluster needs or expects, from `pvecm status`.' },
          votes: { type: 'number', description: 'Votes currently present.' },
          config_version: { type: 'number', description: 'Cluster configuration version.' },
          transport: { type: 'string', description: 'Corosync transport (knet, udpu).' },
          source: { type: 'string', description: 'How the view was obtained: cluster or hosts (fallback).' },
          seed: { type: 'string', description: 'ssh host that answered (alias or address).' },
          seed_node: { type: 'string', description: 'Node name of that host.' },
          hosts: { type: 'array', items: { type: 'string' }, description: 'Candidate seed hosts from settings.' },
          node_count: { type: 'number', description: 'Nodes in the cluster.' },
          online_count: { type: 'number', description: 'Nodes the membership file marks online.' },
          vms_total: { type: 'number', description: 'VMs and containers in the cluster.' },
          vms_running: { type: 'number', description: 'How many of them are running.' },
          storage_total: { type: 'number', description: 'Storage entries in the cluster.' },
          listed_nodes: { type: 'number', description: 'Nodes listed in this reply (bounded).' },
          nodes: {
            type: 'array',
            items: { type: 'object', properties: {}, additionalProperties: true },
            description:
              'Per node: name, id, ip, online, votes, vms_total, vms_running, cpus, cpu_pct, ' +
              'mem_used_bytes, mem_total_bytes, disk_used_bytes, disk_total_bytes, uptime_s.',
          },
          wall_ms: { type: 'number', description: 'Wall time of the call, milliseconds.' },
        }),
        render: textRender('PVE cluster', (value) => {
          const lines = [];
          if (value.cluster) {
            const quorum =
              value.quorate === true ? 'quorate' : value.quorate === false ? 'NO QUORUM' : 'quorum unknown';
            lines.push(
              `cluster ${value.cluster}: ${quorum}` +
                (value.expected_votes === undefined ? '' : `, ${value.votes ?? 0}/${value.expected_votes} votes`) +
                (value.config_version === undefined ? '' : `, config v${value.config_version}`),
            );
          } else if (value.standalone === true) {
            lines.push(`no cluster: ${value.seed_node ?? value.seed} is a standalone node`);
          }
          lines.push(
            `${value.online_count ?? 0}/${value.node_count ?? 0} nodes online; ` +
              `${value.vms_running ?? 0} of ${value.vms_total ?? 0} VMs running; ` +
              `${value.storage_total ?? 0} storage entries`,
          );
          for (const node of value.nodes ?? []) {
            lines.push(
              `  ${node.name} ${node.ip ?? '?'} ${node.online === false ? 'offline' : 'online'}` +
                `  VMs ${node.vms_running ?? 0}/${node.vms_total ?? 0}` +
                (node.cpu_pct === undefined ? '' : `  cpu ${pct(node.cpu_pct)}`) +
                (node.mem_total_bytes ? `  mem ${gb(node.mem_used_bytes)}/${gb(node.mem_total_bytes)}` : '') +
                (node.uptime_s ? `  up ${Math.floor(node.uptime_s / 86400)}d` : ''),
            );
          }
          if ((value.listed_nodes ?? 0) < (value.node_count ?? 0)) {
            lines.push(`  … ${(value.node_count ?? 0) - (value.listed_nodes ?? 0)} more nodes`);
          }
          if (value.source === 'hosts') {
            lines.push('read per host with `qm list` — the cluster files were not available');
          }
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const settings = deps.settings();
        const probe = await deps.registry.clusterView({
          host: args.node,
          signal: exec.signal,
          fresh: args.fresh === true,
        });
        if (probe === null) {
          // No cluster view (clusterMode "off", or the seed has no /etc/pve): report what the
          // per-host listing knows, which is exactly the old behaviour and still useful.
          const listing = await deps.registry.listVms({
            host: args.node,
            signal: exec.signal,
            fresh: args.fresh === true,
          });
          const byNode = new Map();
          for (const vm of listing.vms) {
            const key = vm.node ?? vm.host ?? '?';
            const entry = byNode.get(key) ?? { vms_total: 0, vms_running: 0 };
            entry.vms_total += 1;
            if (vm.status === 'running') entry.vms_running += 1;
            byNode.set(key, entry);
          }
          const nodes = listing.hosts.map((host) => ({
            name: host.node ?? host.host,
            ip: host.host,
            online: host.ok === true,
            ...(byNode.get(host.node ?? host.host) ?? { vms_total: 0, vms_running: 0 }),
          }));
          return {
            ok: true,
            source: 'hosts',
            standalone: true,
            seed: settings.ssh.hosts[0] ?? args.node ?? null,
            seed_node: nodes[0]?.name ?? null,
            hosts: settings.ssh.hosts,
            node_count: nodes.length,
            online_count: nodes.filter((node) => node.online).length,
            vms_total: listing.vms.length,
            vms_running: listing.vms.filter((vm) => vm.status === 'running').length,
            storage_total: 0,
            listed_nodes: nodes.length,
            nodes,
            wall_ms: Date.now() - started,
          };
        }
        const vms = Cluster.vms(probe);
        const perNode = new Map();
        for (const vm of vms) {
          const entry = perNode.get(vm.node) ?? { vms_total: 0, vms_running: 0 };
          entry.vms_total += 1;
          if (vm.status === 'running') entry.vms_running += 1;
          perNode.set(vm.node, entry);
        }
        const nodeResources = new Map(
          probe.resources.filter((entry) => entry.type === 'node').map((entry) => [entry.node, entry]),
        );
        const nodes = probe.nodes.slice(0, MAX_LISTED_NODES).map((node) => {
          const live = nodeResources.get(node.name) ?? {};
          const counts = perNode.get(node.name) ?? { vms_total: 0, vms_running: 0 };
          return {
            name: node.name,
            id: node.id,
            ip: node.ip,
            online: node.online,
            votes: node.votes,
            vms_total: counts.vms_total,
            vms_running: counts.vms_running,
            cpus: live.cpus,
            cpu_pct: live.cpu_pct,
            mem_used_bytes: live.mem_used_bytes,
            mem_total_bytes: live.mem_total_bytes,
            disk_used_bytes: live.disk_used_bytes,
            disk_total_bytes: live.disk_total_bytes,
            uptime_s: live.uptime_s,
          };
        });
        return {
          ok: true,
          cluster: probe.cluster.name,
          quorate: probe.cluster.quorate,
          standalone: probe.standalone === true,
          expected_votes: probe.cluster.expected_votes,
          votes: probe.cluster.votes,
          config_version: probe.cluster.config_version,
          transport: probe.cluster.transport,
          source: 'cluster',
          seed: probe.seed.host,
          seed_node: probe.seed.node,
          hosts: deps.settings().ssh.hosts,
          node_count: probe.nodes.length,
          online_count: probe.nodes.filter((node) => node.online).length,
          vms_total: vms.length,
          vms_running: vms.filter((vm) => vm.status === 'running').length,
          storage_total: probe.resources.filter((entry) => entry.type === 'storage').length,
          listed_nodes: nodes.length,
          nodes,
          wall_ms: Date.now() - started,
        };
      },
    }),

    defineTool({
      name: 'pve_cluster_assets',
      description:
        'Inventory the cluster: VMs/containers, storage pools or nodes, with counts by node, type and status. ' +
        'Filter with `type` (vm, qemu, lxc, storage, node, all), `node`, `status` and a `name` substring. ' +
        'The reply is bounded (`limit`, default 40) and says how many were hidden, so a 300-VM cluster ' +
        'does not flood the context. Use it to answer "what is on pve05", "which VMs are stopped", ' +
        '"how much room is left".',
      parameters: {
        node: NODE_PARAM,
        on: {
          type: 'string',
          description: 'Only entries on this node (a cluster node name such as "pve05", not an address).',
        },
        type: {
          type: 'string',
          enum: ASSET_TYPES,
          description: 'What to list: vm (qemu + lxc), qemu, lxc, storage, node, or all (default vm).',
        },
        status: {
          type: 'string',
          description:
            'Only entries in this state: running, stopped, paused (VMs) or online, offline, ' +
            'available (nodes, storage). Omit for everything.',
        },
        name: {
          type: 'string',
          description: 'Substring of the VM name, storage name or node name, case-insensitive.',
        },
        limit: {
          type: 'number',
          description: 'How many entries to return, 1…200 (default 40). The counts cover everything.',
        },
        fresh: { type: 'boolean', description: 'Ignore the cached inventory and read the cluster again.' },
      },
      output: {
        schema: schema({
          cluster: { type: 'string', description: 'Cluster name.' },
          source: { type: 'string', description: 'cluster, or hosts when the cluster files were not readable.' },
          total: { type: 'number', description: 'Entries matching the filters, before `limit`.' },
          shown: { type: 'number', description: 'Entries in `items`.' },
          truncated: { type: 'boolean', description: '`limit` hid entries; raise it or narrow the filters.' },
          counts: {
            type: 'object',
            properties: {},
            additionalProperties: true,
            description: 'by_type, by_status and by_node maps over every matching entry (not just the shown ones).',
          },
          items: {
            type: 'array',
            items: { type: 'object', properties: {}, additionalProperties: true },
            description:
              'VMs: vmid, name, node, status, type, cpus, mem_used_bytes, mem_total_bytes, ' +
              'disk_total_bytes, uptime_s, template. Storage: storage, node, content, shared, ' +
              'used_bytes, total_bytes. Nodes: node, status, cpus, cpu_pct, mem_used_bytes, ' +
              'mem_total_bytes, uptime_s.',
          },
          wall_ms: { type: 'number', description: 'Wall time of the call, milliseconds.' },
        }),
        render: textRender('Cluster assets', (value) => {
          const lines = [];
          const counts = value.counts ?? {};
          const byStatus = Object.entries(counts.by_status ?? {})
            .map(([key, count]) => `${count} ${key}`)
            .join(', ');
          lines.push(
            `${value.shown ?? 0} of ${value.total ?? 0} entries` +
              (byStatus ? ` (${byStatus})` : '') +
              (value.cluster ? ` in ${value.cluster}` : ''),
          );
          for (const item of value.items ?? []) {
            if (item.type === 'storage') {
              lines.push(
                `  storage ${item.storage} on ${item.node}: ${item.status}` +
                  `  ${gb(item.used_bytes)}/${gb(item.total_bytes)}` +
                  (item.shared === true ? '  shared' : ''),
              );
              continue;
            }
            if (item.type === 'node') {
              lines.push(
                `  node ${item.node}: ${item.status ?? 'unknown'}  ${item.cpus ?? '?'} cpus` +
                  (item.cpu_pct === undefined ? '' : `  cpu ${pct(item.cpu_pct)}`) +
                  (item.mem_total_bytes ? `  mem ${gb(item.mem_used_bytes)}/${gb(item.mem_total_bytes)}` : ''),
              );
              continue;
            }
            lines.push(
              `  ${item.vmid} ${item.name} (${item.type}, ${item.node}, ${item.status})` +
                (item.cpus ? `  ${item.cpus} cpus` : '') +
                (item.mem_total_bytes ? `  mem ${gb(item.mem_total_bytes)}` : '') +
                (item.disk_total_bytes ? `  disk ${gb(item.disk_total_bytes)}` : ''),
            );
          }
          if (value.truncated === true) {
            lines.push(`  … ${(value.total ?? 0) - (value.shown ?? 0)} more; raise limit or narrow the filters`);
          }
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const wanted = ASSET_TYPES.includes(args.type) ? args.type : 'vm';
        const limit = Math.max(1, Math.min(200, Number(args.limit ?? 40)));
        const probe = await deps.registry.clusterView({
          host: args.node,
          signal: exec.signal,
          fresh: args.fresh === true,
        });
        let pool;
        let clusterName;
        let source;
        if (probe !== null) {
          clusterName = probe.cluster.name;
          source = 'cluster';
          pool = probe.resources;
        } else {
          const listing = await deps.registry.listVms({
            host: args.node,
            signal: exec.signal,
            fresh: args.fresh === true,
          });
          source = 'hosts';
          pool = listing.vms.map((vm) => ({
            type: 'qemu',
            vmid: vm.vmid,
            name: vm.name,
            node: vm.node,
            status: vm.status,
            mem_total_bytes: (vm.mem_mb ?? 0) * 1048576,
            disk_total_bytes: (vm.disk_gb ?? 0) * 1073741824,
          }));
        }
        const typeMatch = (entry) =>
          wanted === 'all' ||
          (wanted === 'vm' ? entry.type === 'qemu' || entry.type === 'lxc' : entry.type === wanted);
        const nameNeedle = String(args.name ?? '').trim().toLowerCase();
        const statusNeedle = String(args.status ?? '').trim().toLowerCase();
        const matching = pool.filter(
          (entry) =>
            typeMatch(entry) &&
            (nameNeedle.length === 0 || String(entry.name ?? '').toLowerCase().includes(nameNeedle)) &&
            (statusNeedle.length === 0 || String(entry.status ?? '').toLowerCase() === statusNeedle) &&
            (args.on === undefined || String(entry.node ?? '') === String(args.on).trim()),
        );
        const byType = {};
        const byStatus = {};
        const byNode = {};
        for (const entry of matching) {
          byType[entry.type] = (byType[entry.type] ?? 0) + 1;
          const status = entry.status ?? 'unknown';
          byStatus[status] = (byStatus[status] ?? 0) + 1;
          if (entry.node) byNode[entry.node] = (byNode[entry.node] ?? 0) + 1;
        }
        const items = matching
          .slice()
          .sort((a, b) => String(a.node ?? '').localeCompare(String(b.node ?? '')) || (a.vmid ?? 0) - (b.vmid ?? 0))
          .slice(0, limit);
        return {
          ok: true,
          ...(clusterName ? { cluster: clusterName } : {}),
          source,
          total: matching.length,
          shown: items.length,
          ...(matching.length > items.length ? { truncated: true } : {}),
          counts: { by_type: byType, by_status: byStatus, by_node: byNode },
          items,
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
