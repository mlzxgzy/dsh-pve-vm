/**
 * pve-vm-recorder — observe and drive a Proxmox VM without leaving the agent.
 *
 * The plugin wraps the prototype in `prototype/pve/`: QMP screendumps from the node (not the guest
 * desktop), a detached frame recorder on the node tmpfs, the session-1 bridge for injected input,
 * and the guest agent for unattended PowerShell.
 *
 * Wiring only: settings are read at call time (the operator may change them without a reload), and
 * one shared ssh transport / node registry / bridge is reused so caches survive between calls.
 */
import { resolveSettings, snapshot, Config } from './lib/config.js';
import { NodeRegistry } from './lib/nodes.js';
import { Transport } from './lib/ssh.js';
import { SessionBridge } from './lib/bridge.js';
import { burstStatus, stopBurst } from './lib/burst.js';
import { remotePaths } from './lib/config.js';
import { lifecycleTools } from './tools/vm.js';
import { screenTools } from './tools/screen.js';
import { inputTools } from './tools/input.js';
import { guestTools } from './tools/guest.js';

export { Config };

export const name = 'pve-vm-recorder';

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
  const registry = new NodeRegistry({ settings, transport });
  const bridge = new SessionBridge({ settings, transport });
  const deps = {
    ctx,
    settings,
    transport,
    registry,
    bridge,
    spawn,
    cwd,
    burstStatus: (node, vmid, paths) => burstStatus(transport, node, { vmid, root: paths.root, burst: paths.burst }),
    stopBurst: (node, vmid, paths) => stopBurst(transport, node, { vmid, root: paths.root, burst: paths.burst }),
  };
  const tools = [...lifecycleTools(deps), ...screenTools(deps), ...inputTools(deps), ...guestTools(deps)];
  for (const tool of tools) {
    // `pve_guest_exec` is arbitrary PowerShell as SYSTEM: it is not merely refused, it is absent
    // from the tool list unless the operator enabled it.
    ctx.tools.register(tool, tool.name === 'pve_guest_exec' ? { when: () => settings().allowGuestExec === true } : {});
  }
  ctx.effect(() => () => {
    // Unloading the plugin must not leave a recorder loop on the node. The recorder also stops
    // itself at its deadline; this is the fast path, and it never blocks the unload.
    registry.clear();
    bridge.reset();
    const current = settings();
    for (const vmid of current.allowedVmids) {
      const paths = remotePaths(current, vmid);
      for (const node of current.ssh.nodes) {
        stopBurst(transport, node, { vmid, root: paths.root, burst: paths.burst }).catch(() => {});
      }
    }
  });
}
