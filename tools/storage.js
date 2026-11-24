/**
 * Storage: which pools exist and what is inside them.
 *
 * An agent that wants to clone from a template, mount an ISO, or find last night's backup needs to
 * know the volume ids first. `pvesh get .../storage/<id>/content` answers that, and asking for the
 * storage list answers "what pools are there at all" without guessing names like `local-lvm`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  compactStorageContent,
  compactStorageDefs,
  parseJson,
  storageContentScript,
  storageListScript,
  storageArg,
} from '../lib/vmops.js';
import { VmError } from '../lib/errors.js';
import { NODE_PARAM, schema, textRender, seedHost } from './common.js';

const MAX_ITEMS = 100;
const CONTENT_TYPES = ['iso', 'vztmpl', 'backup', 'images', 'rootdir', 'snippets'];

/** 1024-based size for a human. */
function size(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`;
}

/**
 * @param {object} deps plugin wiring.
 * @returns {object[]} the tool definitions.
 */
export function storageTools(deps) {
  return [
    defineTool({
      name: 'pve_storage_content',
      description:
        'List storage pools on a node and what is inside them: ISO images, container templates, backups, ' +
        'disk images. Without `storage` it lists the defined pools with their usage; with `storage` it ' +
        'lists that pool\'s volumes, optionally filtered by content type, VM id or a name substring. Use ' +
        'it to find the volume id before cloning from a template or attaching an ISO.',
      parameters: {
        node: NODE_PARAM,
        storage: {
          type: 'string',
          description: 'Storage id to inspect (e.g. "local", "local-lvm", "vm-b"). Omit to list the pools.',
        },
        content: {
          type: 'string',
          description: `Only volumes of this content type: ${CONTENT_TYPES.join(', ')}.`,
        },
        vmid: { type: 'number', description: 'Only volumes that belong to this VM id.' },
        name: { type: 'string', description: 'Only volumes whose id contains this text (case-insensitive).' },
        limit: { type: 'number', description: `How many volumes to return, 1…${MAX_ITEMS} (default 40).` },
        fresh: { type: 'boolean', description: 'Ignore the cluster snapshot cache for the seed host lookup.' },
      },
      output: {
        schema: schema({
          host: { type: 'string', description: 'Node address the query was run on.' },
          node: { type: 'string', description: 'PVE node name.' },
          storage: { type: 'string', description: 'The pool that was inspected, when one was named.' },
          storages: {
            type: 'array',
            description: 'Defined storage pools, when no pool was named.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                storage: { type: 'string', description: 'Pool id.' },
                type: { type: 'string', description: 'Plugin type (dir, lvmthin, nfs, cifs…).' },
                content: { type: 'string', description: 'Content types the pool allows.' },
                active: { type: 'boolean', description: 'Whether the pool is reachable right now.' },
                shared: { type: 'boolean', description: 'Whether the pool is shared between nodes.' },
                total: { type: 'number', description: 'Total bytes.' },
                used: { type: 'number', description: 'Used bytes.' },
                avail: { type: 'number', description: 'Available bytes.' },
              },
            },
          },
          items: {
            type: 'array',
            description: 'Volumes in the pool, after filtering.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                volid: { type: 'string', description: 'Volume id, e.g. local:iso/debian.iso.' },
                storage: { type: 'string', description: 'Pool the volume lives in.' },
                content: { type: 'string', description: 'iso, vztmpl, backup, images…' },
                format: { type: 'string', description: 'File format, when known.' },
                size: { type: 'number', description: 'Size in bytes.' },
                vmid: { type: 'number', description: 'Owning VM id, for image/backup volumes.' },
                ctime: { type: 'number', description: 'Creation time, unix seconds.' },
                notes: { type: 'string', description: 'Notes stored with the volume, truncated.' },
              },
            },
          },
          total: { type: 'number', description: 'How many volumes the filter matched.' },
          shown: { type: 'number', description: 'How many are in `items`.' },
          truncated: { type: 'boolean', description: 'True when `limit` cut the list.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE storage', (value) => {
          const where = value.node ? `${value.node} (${value.host})` : value.host;
          if (value.storage === undefined) {
            const lines = [`${value.total ?? 0} storage pool(s) on ${where}`];
            for (const pool of value.storages ?? []) {
              lines.push(
                `  ${pool.storage} (${pool.type ?? '?'}) ${pool.active === false ? 'inactive' : 'active'}` +
                  `${pool.content ? ` [${pool.content}]` : ''}  ${size(pool.used)}/${size(pool.total)}` +
                  `${pool.shared ? '  shared' : ''}`,
              );
            }
            return lines.join('\n');
          }
          const lines = [`${value.total ?? 0} volume(s) in ${value.storage} on ${where}`];
          for (const item of value.items ?? []) {
            lines.push(
              `  ${item.volid}  ${item.content ?? '?'}  ${size(item.size)}` +
                `${item.vmid === null || item.vmid === undefined ? '' : `  vm${item.vmid}`}`,
            );
          }
          if (value.truncated === true) lines.push(`  … ${(value.total ?? 0) - (value.shown ?? 0)} more; raise limit or filter`);
          return lines.join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const seed = await seedHost(deps, args, exec);
        if (args.storage === undefined || String(args.storage).trim() === '') {
          const run = await deps.transport.run(seed.host, storageListScript(), {
            timeoutMs: 45000,
            signal: exec.signal,
            allowNonZero: true,
          });
          const pools = compactStorageDefs(parseJson(run.stdout));
          return {
            ok: true,
            host: seed.host,
            ...(seed.node === null ? {} : { node: seed.node }),
            storages: pools,
            total: pools.length,
            wall_ms: Date.now() - started,
          };
        }
        const storage = storageArg(args.storage);
        if (args.content !== undefined && !CONTENT_TYPES.includes(String(args.content))) {
          throw new VmError('BAD_ARGS', `content must be one of ${CONTENT_TYPES.join(', ')}`, { allowed: CONTENT_TYPES });
        }
        const run = await deps.transport.run(
          seed.host,
          storageContentScript(storage, { content: args.content, vmid: args.vmid }),
          { timeoutMs: 60000, signal: exec.signal, allowNonZero: true },
        );
        const all = compactStorageContent(parseJson(run.stdout, 'STORAGE_UNKNOWN'));
        const needle = args.name === undefined ? null : String(args.name).toLowerCase();
        const filtered = needle === null ? all : all.filter((row) => String(row.volid ?? '').toLowerCase().includes(needle));
        const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(MAX_ITEMS, Math.trunc(Number(args.limit)))) : 40;
        const items = filtered.slice(0, limit);
        return {
          ok: true,
          host: seed.host,
          ...(seed.node === null ? {} : { node: seed.node }),
          storage,
          items,
          total: filtered.length,
          shown: items.length,
          truncated: items.length < filtered.length,
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
