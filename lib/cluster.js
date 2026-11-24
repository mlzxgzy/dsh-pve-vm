/**
 * The cluster is the unit of connection, not a single node.
 *
 * An operator connects to a Proxmox VE **cluster**: one seed host answers, and the cluster tells
 * us which nodes exist, which is online, where every VM lives and how much storage is left. Two
 * files make that possible without any configuration:
 *
 * - `/etc/pve/.members` — `nodename`, the cluster block (`name`, `nodes`, `quorate`) and the
 *   `nodelist` with each node's **management IP**. This is the mapping from "VM 15047 lives on
 *   pve04" to "ssh to 192.168.90.104", obtained without DNS: `pvecm nodes` only prints names,
 *   and node names do not resolve (`getent hosts pve05` is empty on pve04).
 * - `pvesh get /cluster/resources` — every VM, container, node and storage in the cluster with
 *   status, memory/disk totals and uptime, in one call (~87 KB for 7 nodes / 311 entries).
 *
 * `pvecm status` adds the quorum view (expected votes, config version, whether it is quorate),
 * which is what makes an answer like "6 of 7 nodes online, quorate" possible.
 *
 * Everything here is a *cache with a short TTL*: a VM migrates, a node goes offline, and an
 * inventory that is a minute stale is worse than a slightly slower call.
 */
import { VmError } from './errors.js';

/**
 * One ssh round trip that collects the whole cluster view. Sections are addressed by their
 * `###NAME` marker so that a missing tool (a standalone node has no `pvecm`) degrades to an
 * empty section instead of failing the call.
 */
export const CLUSTER_SCRIPT = `set -u
echo '###HOST'
hostname 2>&1 || true
echo '###MEMBERS'
cat /etc/pve/.members 2>/dev/null || true
echo '###PVECM'
pvecm status 2>&1 || true
echo '###PVECMNODES'
pvecm nodes 2>&1 || true
echo '###RESOURCES'
pvesh get /cluster/resources --output-format json 2>/dev/null || echo '[]'
`;

/**
 * Split a marker-delimited payload into its sections.
 * @param {string} text stdout of {@link CLUSTER_SCRIPT}.
 * @returns {Record<string, string>} section name → body (trimmed).
 */
export function sections(text) {
  /** @type {Record<string, string[]>} */
  const found = {};
  let current = null;
  for (const line of text.split('\n')) {
    const marker = /^###([A-Z]+)\s*$/.exec(line);
    if (marker !== null) {
      current = marker[1];
      found[current] = [];
      continue;
    }
    if (current === null) continue;
    found[current].push(line);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, lines] of Object.entries(found)) out[name] = lines.join('\n').trim();
  return out;
}

/**
 * `/etc/pve/.members` → cluster identity and the node→address map.
 * @param {string} text file content.
 * @returns {{cluster: {name: string, quorate: boolean, nodes: number|null, version: number|null}|null,
 *   nodename: string|null, nodes: Array<{name: string, id: number|null, online: boolean, ip: string|null}>}}
 */
export function parseMembers(text) {
  const empty = { cluster: null, nodename: null, nodes: [] };
  if (typeof text !== 'string' || text.trim().length === 0) return empty;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return empty;
  }
  if (data === null || typeof data !== 'object') return empty;
  const block = data.cluster ?? null;
  const nodes = [];
  for (const [name, info] of Object.entries(data.nodelist ?? {})) {
    if (info === null || typeof info !== 'object') continue;
    nodes.push({
      name,
      id: typeof info.id === 'number' ? info.id : null,
      online: info.online === 1 || info.online === true,
      ip: typeof info.ip === 'string' && info.ip.length > 0 ? info.ip : null,
    });
  }
  nodes.sort((a, b) => (a.id ?? 99) - (b.id ?? 99));
  return {
    cluster:
      block === null || typeof block !== 'object'
        ? null
        : {
            name: String(block.name ?? ''),
            quorate: block.quorate === 1 || block.quorate === true,
            nodes: typeof block.nodes === 'number' ? block.nodes : null,
            version: typeof block.version === 'number' ? block.version : null,
          },
    nodename: typeof data.nodename === 'string' ? data.nodename : null,
    nodes,
  };
}

/**
 * `pvecm status` → quorum facts.
 * @param {string} text command output.
 * @returns {{name: string|null, quorate: boolean|null, expected_votes: number|null,
 *   votes: number|null, config_version: number|null, transport: string|null}}
 */
export function parsePvecmStatus(text) {
  const pick = (pattern) => pattern.exec(text ?? '')?.[1]?.trim() ?? null;
  const expected = pick(/Expected votes:\s*(\d+)/);
  const votes = pick(/Total votes:\s*(\d+)/);
  const quorate = pick(/Quorate:\s*(Yes|No)/i);
  const version = pick(/Config Version:\s*(\d+)/);
  return {
    name: pick(/^Name:\s*(\S+)/m),
    quorate: quorate === null ? null : /^yes$/i.test(quorate),
    expected_votes: expected === null ? null : Number(expected),
    votes: votes === null ? null : Number(votes),
    config_version: version === null ? null : Number(version),
    transport: pick(/^Transport:\s*(\S+)/m),
  };
}

/**
 * `pvecm nodes` → per-node vote table (`1  1  pve01`, `5  1  pve04 (local)`).
 * @param {string} text command output.
 * @returns {Array<{id: number, votes: number, name: string, local: boolean}>} rows.
 */
export function parsePvecmNodes(text) {
  const rows = [];
  for (const line of (text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(\s+\(local\))?\s*$/.exec(line);
    if (match === null) continue;
    rows.push({ id: Number(match[1]), votes: Number(match[2]), name: match[3], local: match[4] !== undefined });
  }
  return rows;
}

/**
 * One entry of `pvesh get /cluster/resources`, reduced to what a reply should carry: an agent
 * needs "which VM, where, running or not, how big" — not netin/netout counters.
 * @param {object} entry raw API object.
 * @returns {object|null} compact entry, or null for a type this plugin does not use.
 */
export function compactResource(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  const type = String(entry.type ?? '');
  const node = typeof entry.node === 'string' ? entry.node : null;
  const status = typeof entry.status === 'string' ? entry.status : null;
  if (type === 'qemu' || type === 'lxc') {
    return {
      type,
      vmid: typeof entry.vmid === 'number' ? entry.vmid : Number(entry.vmid ?? 0) || null,
      name: String(entry.name ?? ''),
      node,
      status,
      cpus: typeof entry.maxcpu === 'number' ? entry.maxcpu : null,
      mem_used_bytes: typeof entry.mem === 'number' ? entry.mem : null,
      mem_total_bytes: typeof entry.maxmem === 'number' ? entry.maxmem : null,
      disk_used_bytes: typeof entry.disk === 'number' ? entry.disk : null,
      disk_total_bytes: typeof entry.maxdisk === 'number' ? entry.maxdisk : null,
      uptime_s: typeof entry.uptime === 'number' ? entry.uptime : null,
      template: entry.template === 1,
    };
  }
  if (type === 'storage') {
    return {
      type,
      name: String(entry.storage ?? ''),
      storage: String(entry.storage ?? ''),
      node,
      status,
      content: typeof entry.content === 'string' ? entry.content : null,
      shared: entry.shared === 1,
      used_bytes: typeof entry.disk === 'number' ? entry.disk : null,
      total_bytes: typeof entry.maxdisk === 'number' ? entry.maxdisk : null,
    };
  }
  if (type === 'node') {
    return {
      type,
      name: String(entry.node ?? ''),
      node,
      status,
      cpus: typeof entry.maxcpu === 'number' ? entry.maxcpu : null,
      cpu_pct: typeof entry.cpu === 'number' ? Math.round(entry.cpu * 1000) / 10 : null,
      mem_used_bytes: typeof entry.mem === 'number' ? entry.mem : null,
      mem_total_bytes: typeof entry.maxmem === 'number' ? entry.maxmem : null,
      disk_used_bytes: typeof entry.disk === 'number' ? entry.disk : null,
      disk_total_bytes: typeof entry.maxdisk === 'number' ? entry.maxdisk : null,
      uptime_s: typeof entry.uptime === 'number' ? entry.uptime : null,
    };
  }
  return null;
}

/**
 * The cluster view: one ssh round trip, cached for `clusterCacheMs`.
 */
export class Cluster {
  /**
   * @param {{settings: () => object, transport: object}} deps wiring.
   */
  constructor(deps) {
    this.settings = deps.settings;
    this.transport = deps.transport;
    /** @type {{at: number, value: object}|null} */
    this.cache = null;
  }

  /** Whether cluster discovery is allowed at all (`clusterMode: "off"` skips it). */
  get enabled() {
    return this.settings().clusterMode !== 'off';
  }

  /** Whether a missing cluster is a hard failure (`clusterMode: "on"`). */
  get required() {
    return this.settings().clusterMode === 'on';
  }

  /**
   * Ask one seed host for the whole cluster view.
   * @param {{host?: string, signal?: AbortSignal, fresh?: boolean}} [options] seed override.
   * @returns {Promise<object>} the snapshot.
   */
  async ensure(options = {}) {
    const settings = this.settings();
    const ttl = settings.clusterCacheMs;
    if (
      options.fresh !== true &&
      options.host === undefined &&
      this.cache !== null &&
      Date.now() - this.cache.at < ttl
    ) {
      return this.cache.value;
    }
    const hosts = [];
    const push = (value) => {
      const host = String(value ?? '').trim();
      if (host.length > 0 && /^[A-Za-z0-9.:-]+$/.test(host) && !hosts.includes(host)) hosts.push(host);
    };
    push(options.host);
    for (const host of settings.ssh.hosts) push(host);
    if (hosts.length === 0) {
      throw new VmError('NODE_NOT_CONFIGURED', 'no PVE host is configured and none was passed on the call');
    }
    const failures = [];
    for (const host of hosts) {
      const started = Date.now();
      try {
        const result = await this.transport.run(host, CLUSTER_SCRIPT, {
          timeoutMs: 25000,
          maxBytes: 4 * 1024 * 1024,
          signal: options.signal,
          allowNonZero: true,
        });
        const parts = sections(result.stdout);
        const members = parseMembers(parts.MEMBERS ?? '');
        const seedNode = (parts.HOST ?? '').split('\n')[0]?.trim() || members.nodename;
        if (seedNode === null && members.nodes.length === 0) {
          failures.push({ host, error: 'no hostname in the answer' });
          continue;
        }
        const pvecm = parsePvecmStatus(parts.PVECM ?? '');
        const votes = new Map(parsePvecmNodes(parts.PVECMNODES ?? '').map((row) => [row.name, row.votes]));
        const resources = [];
        const raw = (parts.RESOURCES ?? '[]').trim();
        let parsed = [];
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = [];
        }
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const compact = compactResource(entry);
            if (compact !== null) resources.push(compact);
          }
        }
        const nodes = members.nodes.length > 0
          ? members.nodes.map((node) => ({
              name: node.name,
              id: node.id,
              ip: node.ip,
              online: node.online,
              votes: votes.get(node.name) ?? null,
            }))
          : [{ name: seedNode, id: 1, ip: null, online: true, votes: null }];
        const value = {
          at: Date.now(),
          ms: Date.now() - started,
          seed: { host, node: seedNode },
          standalone: members.cluster === null,
          cluster: {
            name: members.cluster?.name || pvecm.name || '',
            quorate: members.cluster?.quorate ?? pvecm.quorate ?? null,
            nodes: members.cluster?.nodes ?? pvecm.expected_votes ?? nodes.length,
            config_version: members.cluster?.version ?? pvecm.config_version ?? null,
            expected_votes: pvecm.expected_votes ?? null,
            votes: pvecm.votes ?? null,
            transport: pvecm.transport ?? null,
          },
          nodes,
          resources,
        };
        if (options.host === undefined) this.cache = { at: Date.now(), value };
        return value;
      } catch (error) {
        failures.push({ host, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const allSsh = failures.every((entry) => /ssh|timed out|unreachable|refused|No route|resolve/i.test(entry.error));
    throw new VmError(
      allSsh ? 'NODE_UNREACHABLE' : 'SSH_FAILED',
      `no host answered (${failures.map((entry) => `${entry.host}: ${entry.error}`).join('; ')})`,
      { hosts: failures },
    );
  }

  /**
   * Address of a node by its cluster name (`pve04` → `192.168.90.104`), from `/etc/pve/.members`.
   * @param {string} name node name.
   * @param {object} snapshot a snapshot from {@link ensure}.
   * @returns {string|null} the address, when the members file named it.
   */
  static addressOf(snapshot, name) {
    const node = snapshot?.nodes?.find((entry) => entry.name === name);
    return node?.ip ?? null;
  }

  /**
   * Every VM and container in the cluster.
   * @param {object} snapshot a snapshot from {@link ensure}.
   * @returns {object[]} resources of type qemu or lxc.
   */
  static vms(snapshot) {
    return (snapshot?.resources ?? []).filter((entry) => entry.type === 'qemu' || entry.type === 'lxc');
  }

  /**
   * One VM by id, cluster-wide.
   * @param {object} snapshot a snapshot from {@link ensure}.
   * @param {number} vmid VM id.
   * @returns {object|null} the resource entry.
   */
  static findVmid(snapshot, vmid) {
    return Cluster.vms(snapshot).find((entry) => entry.vmid === vmid) ?? null;
  }

  /** Drop the cached snapshot (after a rollback, start or migration). */
  clear() {
    this.cache = null;
  }
}
