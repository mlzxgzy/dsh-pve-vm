/**
 * dsh-pve-vm — observe and drive a Proxmox VE cluster without leaving the agent.
 *
 * The plugin wraps the prototype in `prototype/pve/`: QMP screendumps from the node (not the guest
 * desktop), a detached frame recorder on the node tmpfs, the session-1 bridge for injected input,
 * and the guest agent for unattended PowerShell.
 *
 * Wiring only: settings are read at call time (the operator may change them without a reload), and
 * one shared ssh transport / node registry / bridge is reused so caches survive between calls.
 */
import { Cluster } from './lib/cluster.js';
import { resolveSettings, snapshot, Config } from './lib/config.js';
import { guard } from './lib/errors.js';
import { NodeRegistry } from './lib/nodes.js';
import { Transport } from './lib/ssh.js';
import { SessionBridge } from './lib/bridge.js';
import { burstStatus, stopBurst } from './lib/burst.js';
import { clusterTools } from './tools/cluster.js';
import { lifecycleTools } from './tools/vm.js';
import { screenTools } from './tools/screen.js';
import { inputTools } from './tools/input.js';
import { guestTools } from './tools/guest.js';

export { Config };

export const name = 'dsh-pve-vm';

export const inject = ['tools', 'subprocess'];

/**
 * Register the tools.
 * @param {object} ctx the plugin context.
 * @param {object} config the live config section (fields are read through {@link snapshot}).
 */
export function apply(ctx, config) {
  const settings = () => resolveSettings(snapshot(config));
  const spawn = (spec) => ctx.subprocess.spawn(spec);
  const cwd = process.cwd();
  const transport = new Transport({ settings, spawn, cwd });
  // One cluster view is shared by every tool: it is read at call time, cached for
  // `clusterCacheMs`, and gives VM→node→address resolution without probing every host.
  const cluster = new Cluster({ settings, transport });
  const registry = new NodeRegistry({ settings, transport, cluster });
  const bridge = new SessionBridge({ settings, transport });
  const deps = {
    ctx,
    settings,
    transport,
    cluster,
    registry,
    bridge,
    spawn,
    cwd,
    burstStatus: (node, vmid, paths) => burstStatus(transport, node, { vmid, root: paths.root, burst: paths.burst }),
    stopBurst: (node, vmid, paths) => stopBurst(transport, node, { vmid, root: paths.root, burst: paths.burst }),
  };
  const tools = [
    ...clusterTools(deps),
    ...lifecycleTools(deps),
    ...screenTools(deps),
    ...inputTools(deps),
    ...guestTools(deps),
  ];
  for (const tool of tools) {
    // A tool never throws at the harness: every failure becomes the canonical value
    // `{ok:false, code, message, hint, details?}`, which the renderer turns into one readable block.
    // (Most tools guard themselves; this is the net for the few paths that throw early.)
    const definition = { ...tool, execute: (args, exec) => guard(() => tool.execute(args, exec)) };
    // `pve_guest_exec` is arbitrary PowerShell as SYSTEM: it is not merely refused, it is absent
    // from the tool list unless the operator enabled it.
    ctx.tools.register(
      definition,
      tool.name === 'pve_guest_exec' ? { when: () => settings().allowGuestExec === true } : {},
    );
  }
  ctx.effect(() => () => {
    // Unloading the plugin must not leave a recorder loop on the node. The recorder also stops
    // itself at its deadline; this is the fast path, and it never blocks the unload. Every host is
    // asked in one round trip, and every VM's burst directory is covered without knowing the ids.
    registry.clear();
    bridge.reset();
    const current = settings();
    const stopAll = `set -u\nfor d in ${current.tmpfsDir}/v*/burst; do [ -d "$d" ] && : > "$d/STOP"; done\n`;
    for (const host of current.ssh.hosts) {
      transport.run(host, stopAll, { timeoutMs: 8000 }).catch(() => {});
    }
  });
}
