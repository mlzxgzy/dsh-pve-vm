/**
 * The task queue: what the node is actually doing.
 *
 * `qm clone`, `qm migrate`, backups and restores all hand back a UPID and keep working in the
 * background. Without this tool an agent can start such an operation and then have no way to tell
 * "still copying" from "failed halfway" — the cluster would look idle while a disk is 40 % copied.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { VmError } from '../lib/errors.js';
import { waitTask, taskStatus } from '../lib/tasks.js';
import { compactTasks, parseJson, parseUpid, taskListScript, taskLogScript } from '../lib/vmops.js';
import { NODE_PARAM, schema, seconds, seedHost, textRender } from './common.js';

const ACTIONS = ['list', 'status', 'log'];
const MAX_TASKS = 50;

/**
 * @param {object} deps plugin wiring.
 * @returns {object[]} the tool definitions.
 */
export function taskTools(deps) {
  return [
    defineTool({
      name: 'pve_task',
      description:
        'Look at the node\'s task queue: list recent tasks (newest first), read one task\'s status, or read ' +
        'its log tail. Every asynchronous PVE operation — clone, migrate, backup, restore — is a task, ' +
        'so this is how you find out whether it finished and whether it succeeded (`exitstatus: "OK"`). ' +
        'Use `wait:true` on a UPID to block until it stops.',
      parameters: {
        node: NODE_PARAM,
        action: { type: 'string', enum: ACTIONS, description: 'list (default), status, or log.' },
        upid: {
          type: 'string',
          description: 'Task id (UPID:…) for status/log. The node is taken from the UPID itself.',
        },
        vmid: { type: 'number', description: 'For list: only tasks that belong to this VM id.' },
        type: { type: 'string', description: 'For list: only this task type, e.g. qmclone, qmmigrate, vzdump.' },
        limit: { type: 'number', description: `How many tasks to return, 1…${MAX_TASKS} (default 20).` },
        wait: { type: 'boolean', description: 'For status: keep polling until the task stops (default false).' },
        timeoutMs: { type: 'number', description: 'For wait: give up after this many milliseconds (default 300000).' },
      },
      output: {
        schema: schema({
          host: { type: 'string', description: 'Node address the query was run on.' },
          node: { type: 'string', description: 'PVE node name.' },
          action: { type: 'string', enum: ACTIONS, description: 'The action that was requested.' },
          upid: { type: 'string', description: 'The task id, for status and log.' },
          tasks: {
            type: 'array',
            description: 'Task rows, newest first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                upid: { type: 'string', description: 'Task id.' },
                type: { type: 'string', description: 'Task type, e.g. qmclone.' },
                vmid: { type: 'string', description: 'The VM the task belongs to.' },
                node: { type: 'string', description: 'Node that ran it.' },
                user: { type: 'string', description: 'User that started it.' },
                status: { type: 'string', description: 'running, or the final status word (OK, …).' },
                started_at: { type: 'number', description: 'Start time, unix seconds.' },
                ended_at: { type: 'number', description: 'End time, unix seconds (absent while running).' },
                running: { type: 'boolean', description: 'True while the worker is alive.' },
              },
            },
          },
          total: { type: 'number', description: 'How many tasks the filter matched.' },
          state: { type: 'string', description: 'For status: running, ok, failed, timeout or cancelled.' },
          exitstatus: { type: 'string', description: 'For status: the task\'s own exit status (OK, or the error).' },
          running: { type: 'boolean', description: 'For status: whether the worker is still alive.' },
          waited_ms: { type: 'number', description: 'For status/wait: how long the poll took.' },
          log: { type: 'string', description: 'For log: the tail of the task log.' },
          truncated: { type: 'boolean', description: 'True when the log tail was cut.' },
          wall_ms: { type: 'number', description: 'Wall time of the whole call, milliseconds.' },
        }),
        render: textRender('PVE tasks', (value) => {
          if (value.action === 'list') {
            const lines = [`${value.total ?? 0} task(s) on ${value.node ?? value.host}`];
            for (const task of value.tasks ?? []) {
              const when = task.started_at ? new Date(task.started_at * 1000).toISOString().slice(11, 19) : '';
              lines.push(
                `  ${task.type ?? '?'} vm${task.vmid ?? '?'} ${task.running ? 'running' : task.status ?? '?'}  ${when}  ${task.upid ?? ''}`,
              );
            }
            return lines.join('\n');
          }
          if (value.action === 'status') {
            return (
              `task ${value.upid}: ${value.state ?? 'unknown'}` +
              (value.exitstatus ? ` (exitstatus ${value.exitstatus})` : '') +
              (value.waited_ms === undefined ? '' : ` after ${seconds(value.waited_ms)}`)
            );
          }
          return [`task ${value.upid}: log tail`, value.log ?? '(empty)'].join('\n');
        }),
      },
      async execute(args, exec) {
        const started = Date.now();
        const action = String(args.action ?? 'list').trim();
        if (!ACTIONS.includes(action)) throw new VmError('BAD_ARGS', `"${action}" is not a task action`, { allowed: ACTIONS });
        const seed = await seedHost(deps, args, exec);
        if (action === 'list') {
          const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(MAX_TASKS, Math.trunc(Number(args.limit)))) : 20;
          const run = await deps.transport.run(
            seed.host,
            taskListScript({ limit, vmid: args.vmid, type: args.type, source: 'all' }),
            { timeoutMs: 45000, signal: exec.signal, allowNonZero: true },
          );
          const rows = compactTasks(parseJson(run.stdout));
          return {
            ok: true,
            host: seed.host,
            ...(seed.node === null ? {} : { node: seed.node }),
            action,
            tasks: rows,
            total: rows.length,
            wall_ms: Date.now() - started,
          };
        }
        const upid = String(args.upid ?? '').trim();
        if (!upid) throw new VmError('BAD_ARGS', `action "${action}" needs a upid`, { action });
        parseUpid(upid);
        parseUpid(upid);
        if (action === 'log') {
          const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(500, Math.trunc(Number(args.limit)))) : 60;
          const run = await deps.transport.run(seed.host, taskLogScript(upid, { limit }), {
            timeoutMs: 45000,
            signal: exec.signal,
            allowNonZero: true,
          });
          const tail = /###TAIL\n([\s\S]*)$/.exec(run.stdout)?.[1] ?? '';
          const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);
          const text = lines.join('\n');
          return {
            ok: true,
            host: seed.host,
            ...(seed.node === null ? {} : { node: seed.node }),
            action,
            upid,
            log: text.slice(-8000),
            truncated: text.length > 8000,
            wall_ms: Date.now() - started,
          };
        }
        const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Math.max(1000, Number(args.timeoutMs)) : 300000;
        const status =
          args.wait === true
            ? await waitTask({ transport: deps.transport, node: seed.host, upid, timeoutMs, signal: exec.signal })
            : await taskStatus({ transport: deps.transport, node: seed.host, upid, signal: exec.signal });
        if (status.state === 'timeout') {
          throw new VmError('TASK_TIMEOUT', `task ${upid} is still running after ${seconds(timeoutMs)}`, {
            upid,
            state: status.state,
            waited_ms: status.ms,
          });
        }
        if (status.state === 'failed') {
          throw new VmError('TASK_FAILED', `task ${upid} ended with exitstatus ${status.exitstatus}`, {
            upid,
            state: status.state,
            exitstatus: status.exitstatus,
          });
        }
        return {
          ok: true,
          host: seed.host,
          ...(seed.node === null ? {} : { node: seed.node }),
          action,
          upid,
          state: status.state,
          ...(status.exitstatus ? { exitstatus: status.exitstatus } : {}),
          running: status.running,
          waited_ms: status.ms ?? 0,
          wall_ms: Date.now() - started,
        };
      },
    }),
  ];
}
