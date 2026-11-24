# dsh-pve-vm

**English** | [简体中文](README.zh-CN.md)

A DeepSeek Harness (DSH) plugin that lets an agent **operate a Proxmox VE cluster** — inventory the cluster and its assets, then watch and drive a virtual machine: screen capture, burst recording, frame retrieval, clicking, typing, keys, PowerShell inside the guest, and snapshot rollback — without writing a single `ssh` command by hand.

A PVE "machine" is really a cluster, so the cluster is the unit of connection: one `ssh` gives the node → address map, quorum, every VM and every storage pool. Neither hosts nor VMIDs are baked in.

```
pve_cluster_status  quorum, per-node cpu/mem/VM counts, cluster totals — one ssh
pve_cluster_assets  filter nodes/VMs/storage by node, type, status, name; bounded
pve_vm_status     which node owns the VM, is the guest agent alive, is a recorder running
pve_screenshot    host-side QMP frame → local JPEG, path + bytes only (never base64 by default)
pve_burst         background recorder at N fps into the node's tmpfs, self-stopping
pve_fetch_frames  pull an index range back and convert, with real frame intervals
pve_click         click at screen coordinates (14-step smooth movement)
pve_type          send text (SendKeys, escaped)
pve_key           press one key or a chord (ctrl+a, alt+f4, f5, …)
pve_guest_exec    run PowerShell inside the guest over the QEMU guest agent
pve_snapshot      roll back to a snapshot, reboot, and wait for the agent
```

## Nothing is baked in

No cluster address, node name, VMID or snapshot name lives in this package.

| What | How it is resolved |
| --- | --- |
| Which host answers | `node:"pve04"` on the call (an ssh alias **or** an address), else `PVE_HOSTS`, else settings `hosts` |
| The cluster | `/etc/pve/.members` + `pvecm` + `pvesh get /cluster/resources`, read once and cached 15 s |
| Node name → address | the `ip` in `.members` (`pve04` does not resolve in DNS; `ssh root@pve04` fails) |
| Which node owns the VM | the cluster inventory; falls back to `qm status` per candidate — a migrated VM is found, not assumed |
| Which VM | `vmid`, else `defaultVmid`, else the only *running* VM; several running VMs fail with `AMBIGUOUS_VMID` and the candidate list |
| What may be touched | `allowedVmids` is an **optional** restriction (empty = unrestricted) |

`clusterMode` decides how hard that is: `auto` (default — try the cluster, fall back to per-host `qm list`), `on` (must be a cluster), `off` (never read it). Cluster reads are read-only: no create, migrate or destroy.

## Install

```bash
plugin_manager install_bundle target=/abs/path/to/dsh-plugin/dsh-pve-vm
# or: Settings → Plugins → Add plugin → pick this directory
```

The bundled `cordis.patch.yml` inserts the entry with **no config**, so nothing happens until you say which machine to work on:

```bash
PVE_HOSTS=pve04,192.168.90.101        # env
# or settings: hosts: ["pve04"]
# or per call:  pve_cluster_status {node: "pve04"}
```

Requires ssh access to a PVE node (root by default), a running VM, and — for the input tools — a logged-in console session (Windows: session 1) on the guest.

## Failure shape

Every tool returns `{ok:false, code, message, hint, details?}` instead of throwing. Common codes: `NODE_NOT_CONFIGURED`, `NODE_UNREACHABLE` (VPN down — 8 s, not a hang), `AMBIGUOUS_VMID`, `QMP_BUSY`, `AGENT_DOWN`, `VM_STOPPED`, `SNAPSHOT_CONFIRM_REQUIRED`, `BRIDGE_TIMEOUT`.

`QMP_BUSY` during a burst is a **policy**, not physics: the recorder connects per frame, so the socket is idle between frames; the tool refuses anyway so that "don't steal the socket" is deterministic.

## Things worth knowing before you use it

- **Lists are bounded.** `pve_vm_status` prints at most 25 VMs (running first) plus `… and N more`; `pve_cluster_assets` defaults to 40 rows with full `counts`; a 276-VM cluster will not flood the context.
- **`node` is the seed, `on` is the filter.** `pve_cluster_assets {node:"192.168.90.104", on:"pve04"}` asks pve04's address for the entries that live on pve04.
- **Two sessions, two channels.** `pve_guest_exec` runs in session 0 (SYSTEM); click/type/key run in the interactive session 1. SendKeys from `pve_guest_exec` shows nothing on screen, and the input tools cannot run unattended scripts.
- **`pve_snapshot` stops the VM first** (`qm rollback` needs it stopped), so `agent_up_ms` measures rollback + cold boot + agent readiness: 40–90 s.
- **A restored or freshly booted guest may compose nothing**: the first frame is pure black (~12 KB), and the desktop appears after one real input. `pve_screenshot {wake:true}` detects that and clicks once.
- **QMP frames do not contain the mouse pointer.**
- **One click is not one page turn.** Injected events are consumed in batches; always confirm with a screenshot.
- **Coordinates are screen coordinates**, not window-relative. On 1280×800 the Start button centre is about (22, 783).

## Docs

- [docs/DETAIL.md](docs/DETAIL.md) — capabilities, the cluster connection model, all 21 settings, tool table, error code table, known limits, mapping to the `prototype/pve` scripts this grew from.
- [docs/SELFTEST.md](docs/SELFTEST.md) — every acceptance check with the command that was actually run and its result, including the real bugs found along the way.

## License

MIT
