/**
 * Hosts and VM ids: both are **discovered**, never baked in.
 *
 * Nothing about a particular cluster lives in this package. A host is taken from the call
 * (`node:"pve04"` — an ssh alias or an address), from the settings list, or from `PVE_HOSTS`;
 * then the node that owns a VM is found with `qm status`, because a VM migrates and the address of
 * the node it sits on is an implementation detail of the moment. VM 15047 was on pve04 on
 * 2026-11-24, and the reference console tools that hard-code pve01 die with
 * `Configuration file 'nodes/pve01/qemu-server/15047.conf' does not exist` (pitfall 2 of the brief).
 *
 * The same discovery answers "which VM?" — when a tool call omits `vmid`, the only running VM is
 * used; with several the call fails and hands back the candidate list instead of guessing.
 */
import { Cluster } from './cluster.js';
import { VmError } from './errors.js';
import { agentPing, waitFor } from './ssh.js';

/** How long a discovered VM→node mapping is trusted, ms. */
const VM_CACHE_TTL_MS = 60000;
/** How long the cluster listing (`qm list` on every host) is reused, ms. */
const LIST_CACHE_TTL_MS = 20000;
/** How long a host's own hostname is reused, ms. */
const NODE_CACHE_TTL_MS = 600000;

/**
 * `qm list` table rows: `    15047 WIN-3V53K6O92L0      running    4096      32.00 571147`.
 * The name may contain spaces in theory; the trailing columns are numbers, so parse from both ends.
 */
const QM_LIST_ROW = /^\s*(\d{2,9})\s+(.+?)\s+(running|stopped|paused|suspended)\s+(\d+)\s+([\d.]+)\s*(\S*)\s*$/;

/**
 * Parse one `qm list` table.
 * @param {string} text stdout of `qm list`.
 * @returns {Array<{vmid:number,name:string,status:string,mem_mb:number,disk_gb:number}>} rows.
 */
export function parseQmList(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*VMID\s/.test(line)) continue;
    const match = QM_LIST_ROW.exec(line);
    if (match === null) continue;
    rows.push({
      vmid: Number(match[1]),
      name: match[2].trim(),
      status: match[3],
      mem_mb: Number(match[4]),
      disk_gb: Number(match[5]),
    });
  }
  return rows;
}

export class NodeRegistry {
  /**
   * @param {{settings: () => object, transport: object, cluster?: Cluster}} deps wiring.
   */
  constructor(deps) {
    this.settings = deps.settings;
    this.transport = deps.transport;
    this.cluster = deps.cluster ?? null;
    /** @type {Map<number, {host: string, node: string|null, status: string, at: number}>} */
    this.vmCache = new Map();
    /** @type {Map<string, {node: string, at: number}>} */
    this.nodeCache = new Map();
    /** @type {{at: number, hosts: object[], vms: object[]}|null} */
    this.listCache = null;
  }

  /**
   * Which hosts to talk to, in order: the call's own `node`, then settings/`PVE_HOSTS`.
   * @param {string} [explicit] per-call host.
   * @returns {string[]} candidate hosts.
   */
  candidates(explicit) {
    const settings = this.settings();
    const list = [];
    const push = (value) => {
      const host = String(value ?? '').trim();
      if (host.length === 0) return;
      if (!/^[A-Za-z0-9.:-]+$/.test(host)) return;
      if (!list.includes(host)) list.push(host);
    };
    push(explicit);
    for (const host of settings.ssh.hosts) push(host);
    if (list.length === 0) {
      throw new VmError(
        'NODE_NOT_CONFIGURED',
        'no PVE host is configured and none was passed on the call',
      );
    }
    return list;
  }

  /**
   * Optional restriction: when `allowedVmids` is filled, only those ids pass.
   * @param {number} vmid VM id.
   * @returns {number} the id.
   */
  assertAllowed(vmid) {
    const settings = this.settings();
    if (settings.allowedVmids.length > 0 && !settings.allowedVmids.includes(vmid)) {
      throw new VmError(
        'VMID_NOT_ALLOWED',
        `VM ${vmid} is not in allowedVmids (${settings.allowedVmids.join(', ')})`,
        { vmid, allowed: settings.allowedVmids },
      );
    }
    return vmid;
  }

  /**
   * Hostname of a host (the PVE node name), cached for ten minutes.
   * @param {string} host address or alias.
   * @param {{signal?: AbortSignal}} [options] cancellation.
   * @returns {Promise<string|null>} node name, or null when the host did not answer.
   */
  async nodeName(host, options = {}) {
    const cached = this.nodeCache.get(host);
    if (cached !== undefined && Date.now() - cached.at < NODE_CACHE_TTL_MS) return cached.node;
    try {
      const result = await this.transport.run(host, 'set -u\nhostname\n', {
        timeoutMs: 15000,
        signal: options.signal,
        allowNonZero: true,
      });
      const name = result.stdout.trim().split('\n')[0]?.trim() ?? '';
      if (name.length === 0) return null;
      this.nodeCache.set(host, { node: name, at: Date.now() });
      return name;
    } catch {
      return null;
    }
  }

  /**
   * `qm list` on every candidate host: which VMs exist, on which node, running or not.
   * @param {{host?: string, signal?: AbortSignal, fresh?: boolean}} [options] listing options.
   * @returns {Promise<{hosts: object[], vms: object[]}>} the cluster view.
   */
  async listVms(options = {}) {
    // The cluster knows every VM at once; that is one ssh call instead of one per host, and it
    // also names the owning node, which `qm list` on a single host cannot do cluster-wide.
    if (this.cluster?.enabled === true) {
      try {
        const snapshot = await this.cluster.ensure({
          host: options.host,
          signal: options.signal,
          fresh: options.fresh,
        });
        const vms = Cluster.vms(snapshot).map((vm) => ({
          vmid: vm.vmid,
          name: vm.name,
          status: vm.status ?? 'unknown',
          node: vm.node,
          host: Cluster.addressOf(snapshot, vm.node),
          mem_mb: Math.round((vm.mem_total_bytes ?? 0) / 1048576),
          disk_gb: Math.round(((vm.disk_total_bytes ?? 0) / 1073741824) * 100) / 100,
          type: vm.type,
        }));
        return {
          hosts: [{ host: snapshot.seed.host, node: snapshot.seed.node, ok: true, error: null }],
          vms,
          cluster: snapshot.cluster,
          standalone: snapshot.standalone === true,
          source: 'cluster',
          snapshot,
        };
      } catch (error) {
        if (this.cluster.required === true) throw error;
      }
    }
    if (
      options.fresh !== true &&
      options.host === undefined &&
      this.listCache !== null &&
      Date.now() - this.listCache.at < LIST_CACHE_TTL_MS
    ) {
      return { hosts: this.listCache.hosts, vms: this.listCache.vms };
    }
    const hosts = this.candidates(options.host);
    const hostsView = await Promise.all(
      hosts.map(async (host) => {
        try {
          const result = await this.transport.run(
            host,
            'set -u\nhostname\nqm list 2>&1\n',
            { timeoutMs: 20000, signal: options.signal, allowNonZero: true },
          );
          const lines = result.stdout.split('\n');
          const node = lines[0]?.trim() ?? null;
          const rows = parseQmList(lines.slice(1).join('\n'));
          return { host, node, ok: result.code === 0, error: null, vms: rows };
        } catch (error) {
          return {
            host,
            node: null,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            vms: [],
          };
        }
      }),
    );
    const vms = hostsView.flatMap((entry) =>
      entry.vms.map((vm) => ({ ...vm, host: entry.host, node: entry.node })),
    );
    if (hostsView.every((entry) => !entry.ok)) {
      const allSsh = hostsView.every((entry) => /ssh|timed out|unreachable|refused|No route|resolve/i.test(entry.error ?? ''));
      throw new VmError(
        allSsh ? 'NODE_UNREACHABLE' : 'SSH_FAILED',
        `no host answered (${hostsView.map((entry) => `${entry.host}: ${entry.error ?? 'qm list failed'}`).join('; ')})`,
        { hosts: hostsView.map(({ host, error }) => ({ host, error })) },
      );
    }
    const view = { hosts: hostsView.map(({ vms: _vms, ...rest }) => rest), vms };
    if (options.host === undefined) this.listCache = { at: Date.now(), ...view };
    return view;
  }

  /**
   * The VM a call works on: the argument, then `defaultVmid`, then the only running VM.
   * @param {number|undefined} requested `vmid` argument.
   * @param {{host?: string, signal?: AbortSignal, fresh?: boolean}} [options] discovery options.
   * @returns {Promise<{vmid:number, source:string, vm?:object}>} chosen id.
   */
  async pickVmid(requested, options = {}) {
    const settings = this.settings();
    if (requested !== undefined && requested !== null) {
      const id = Number(requested);
      if (!Number.isInteger(id) || id <= 0) {
        throw new VmError('BAD_VMID', `vmid must be a positive integer (got ${JSON.stringify(requested)})`);
      }
      return { vmid: this.assertAllowed(id), source: 'call' };
    }
    if (settings.defaultVmid > 0) {
      return { vmid: this.assertAllowed(settings.defaultVmid), source: 'default' };
    }
    const view = await this.listVms(options);
    const running = view.vms.filter((vm) => vm.status === 'running');
    if (running.length === 1) {
      return { vmid: this.assertAllowed(running[0].vmid), source: 'discovered', vm: running[0] };
    }
    if (running.length === 0) {
      throw new VmError(
        'VM_NOT_FOUND',
        `no VM is running on ${view.hosts.map((entry) => entry.host).join(', ')}`,
        { hosts: view.hosts, vms: view.vms.map(({ vmid, name, status, node }) => ({ vmid, name, status, node })) },
      );
    }
    throw new VmError(
      'AMBIGUOUS_VMID',
      `${running.length} VMs are running (${running.map((vm) => `${vm.vmid} ${vm.name}`).join(', ')}); pass vmid`,
      {
        vms: running.map(({ vmid, name, status, node, host }) => ({ vmid, name, status, node, host })),
      },
    );
  }

  /**
   * Find the node that owns a VM, and its status.
   * @param {number} vmid VM id.
   * @param {{host?: string, signal?: AbortSignal, fresh?: boolean}} [options] discovery options.
   * @returns {Promise<{host:string, node:string|null, status:string}>} owner and status.
   */
  async resolve(vmid, options = {}) {
    // Fast path: the cluster says which node owns the VM, and `/etc/pve/.members` gives that
    // node's management address. `qm status` still runs on the owner — a probe is also the
    // reachability check, so a stale membership entry fails over to the per-host search.
    if (this.cluster?.enabled === true) {
      try {
        const snapshot = await this.cluster.ensure({
          host: options.host,
          signal: options.signal,
          fresh: options.fresh,
        });
        const vm = Cluster.findVmid(snapshot, vmid);
        if (vm !== null) {
          const address = Cluster.addressOf(snapshot, vm.node);
          if (address !== null) {
            const probe = await this.#probe(address, vmid, options.signal);
            if (probe.status !== undefined) {
              const result = { host: address, node: probe.node ?? vm.node, status: probe.status, source: 'cluster' };
              this.vmCache.set(vmid, { ...result, at: Date.now() });
              return result;
            }
          }
        }
      } catch (error) {
        if (this.cluster.required === true) throw error;
      }
    }
    const cached = this.vmCache.get(vmid);
    if (cached !== undefined && options.fresh !== true && Date.now() - cached.at < VM_CACHE_TTL_MS) {
      // A cached host is only reused when it still owns the VM: a migrated VM must not be
      // addressed through a stale entry for a whole minute.
      const probe = await this.#probe(cached.host, vmid, options.signal);
      if (probe.status !== undefined) return probe;
      this.vmCache.delete(vmid);
    }
    const hosts = this.candidates(options.host);
    const probes = await Promise.all(
      hosts.map(async (host) => ({ host, probe: await this.#probe(host, vmid, options.signal) })),
    );
    const found = probes.find((entry) => entry.probe.status !== undefined) ?? null;
    if (found === null) {
      const lines = probes.map(({ host, probe }) => `${host}: ${probe.error ?? 'not this node'}`);
      throw new VmError('VM_NOT_FOUND', `VM ${vmid} is not on ${hosts.join(', ')} (${lines.join('; ')})`, {
        vmid,
        hosts,
      });
    }
    this.vmCache.set(vmid, {
      host: found.host,
      node: found.probe.node,
      status: found.probe.status,
      at: Date.now(),
    });
    return found.probe;
  }

  /**
   * One `qm status` probe on one host. A result without `status` means "this host does not own
   * the VM" (or could not be reached) — `error` says which.
   * @param {string} host address or alias.
   * @param {number} vmid VM id.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<{host:string,node:string|null,status:string}|{host:string,error:string}>} probe.
   */
  async #probe(host, vmid, signal) {
    try {
      const result = await this.transport.run(
        host,
        `set -u\nhostname\nqm status ${Number(vmid)} 2>&1\necho "rc=$?"\n`,
        { timeoutMs: 15000, signal, allowNonZero: true },
      );
      const lines = result.stdout.split('\n');
      const node = lines[0]?.trim() || null;
      const status = /status:\s*([a-z]+)/i.exec(result.stdout)?.[1]?.toLowerCase() ?? null;
      const rc = Number(/rc=(\d+)/.exec(result.stdout)?.[1] ?? '-1');
      if (status === null || rc !== 0) {
        return {
          host,
          error: lines.slice(1).join(' ').trim().slice(0, 200) || `qm status exit ${rc}`,
        };
      }
      return { host, node, status };
    } catch (error) {
      return { host, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Forget every cached mapping (after a rollback, which may move or restart the VM).
   */
  clear() {
    this.vmCache.clear();
    this.listCache = null;
    this.cluster?.clear();
  }

  /**
   * The cluster snapshot, for tools that report on the cluster itself.
   * @param {{host?: string, signal?: AbortSignal, fresh?: boolean}} [options] seed override.
   * @returns {Promise<object|null>} snapshot, or null when discovery is off or failed.
   */
  async clusterView(options = {}) {
    if (this.cluster?.enabled !== true) return null;
    try {
      return await this.cluster.ensure(options);
    } catch (error) {
      if (this.cluster.required === true) throw error;
      return null;
    }
  }

  /**
   * Wait for the guest agent of a VM to answer.
   * @param {string} node node address (ssh host).
   * @param {number} vmid VM id.
   * @param {{timeoutMs: number, signal?: AbortSignal, intervalMs?: number}} options wait options.
   * @returns {Promise<{ok:boolean, ms:number}>} readiness.
   */
  async waitAgent(node, vmid, options) {
    return waitFor(() => agentPing(this.transport, node, vmid), {
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs ?? 2000,
      signal: options.signal,
    });
  }
}
