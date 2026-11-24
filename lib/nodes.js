/**
 * Which node owns the VM, and which VMs may be touched at all.
 *
 * The node is **discovered**, never assumed: the reference console tools of the same ecosystem
 * have `sshHost` pointing at pve01 and die with
 * `Configuration file 'nodes/pve01/qemu-server/15047.conf' does not exist`, because the VM lives on
 * pve04 (pitfall 2 of the brief). VM 15047 was on pve04 on 2026-11-24; a future migration must not
 * require editing code, so every call asks `qm status`.
 */
import { VmError } from './errors.js';
import { agentPing, queryVmStatus, waitFor } from './ssh.js';

/** How long a discovered node→VM mapping is trusted, ms. */
const CACHE_TTL_MS = 60000;

export class NodeRegistry {
  /**
   * @param {{settings: () => object, transport: object}} deps wiring.
   */
  constructor(deps) {
    this.settings = deps.settings;
    this.transport = deps.transport;
    /** @type {Map<number, {node: string, at: number}>} */
    this.cache = new Map();
  }

  /**
   * Validate a VM id against the allowlist.
   * @param {unknown} vmid the requested id.
   * @returns {number} the id.
   */
  assertVmid(vmid) {
    const settings = this.settings();
    const id = Number(vmid ?? settings.defaultVmid);
    if (!Number.isInteger(id) || id <= 0) {
      throw new VmError(
        'BAD_VMID',
        `vmid must be a positive integer (got ${JSON.stringify(vmid ?? null)}); set defaultVmid or pass vmid`,
      );
    }
    if (!settings.allowedVmids.includes(id)) {
      throw new VmError(
        'VMID_NOT_ALLOWED',
        `VM ${id} is not in allowedVmids (${settings.allowedVmids.join(', ') || 'the list is empty'})`,
        { vmid: id },
      );
    }
    return id;
  }

  /**
   * Find the node that owns a VM.
   * @param {number} vmid VM id.
   * @param {{signal?: AbortSignal, fresh?: boolean}} [options] cancellation and cache bypass.
   * @returns {Promise<{node:string, status:string}>} owner and VM status.
   */
  async resolve(vmid, options = {}) {
    const settings = this.settings();
    if (settings.ssh.nodes.length === 0) {
      throw new VmError('NODE_NOT_ALLOWED', 'no node is configured (settings → nodes)');
    }
    const cached = this.cache.get(vmid);
    if (cached !== undefined && options.fresh !== true && Date.now() - cached.at < CACHE_TTL_MS) {
      // The cached node is only reused if it still answers; a migrated VM must not be
      // addressed for a whole minute through a stale entry.
      try {
        const probe = await queryVmStatus(this.transport, cached.node, vmid);
        if (probe.status !== null) return { node: cached.node, status: probe.status };
      } catch {
        // fall through to a full probe
      }
      this.cache.delete(vmid);
    }
    const errors = [];
    const probes = settings.ssh.nodes.map(async (node) => {
      try {
        const probe = await queryVmStatus(this.transport, node, vmid);
        if (probe.status !== null) return { node, status: probe.status };
        errors.push(`${node}: VM ${vmid} is not on this node`);
        return null;
      } catch (error) {
        errors.push(`${node}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const results = await Promise.all(probes);
    const found = results.find((entry) => entry !== null) ?? null;
    if (found === null) {
      const unreachable = errors.every((line) => /ssh|timed out|unreachable|refused|No route/i.test(line));
      throw new VmError(
        unreachable ? 'NODE_UNREACHABLE' : 'VM_NOT_FOUND',
        `VM ${vmid} was not found on ${settings.ssh.nodes.join(', ')}: ${errors.join('; ').slice(0, 800)}`,
        { vmid, nodes: settings.ssh.nodes },
      );
    }
    this.cache.set(vmid, { node: found.node, at: Date.now() });
    return found;
  }

  /**
   * Forget a cached mapping (after a rollback, which may restart the VM elsewhere).
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Wait for the guest agent of a VM to answer.
   * @param {string} node node address.
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
