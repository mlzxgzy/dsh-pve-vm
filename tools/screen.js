/**
 * Observation tools: one frame, a recorded burst, and the frames of that burst.
 *
 * All three go through the **host** QMP socket, never through the guest: with the PVE console
 * detached, DWM stops composing and an in-guest `CopyFromScreen` returns a stale frame (playbook
 * A-9). And QMP accepts one client, so a burst owns the socket while it runs — a screenshot taken
 * then fails fast with QMP_BUSY instead of queueing behind the burst (an earlier implementation
 * blocked for 399 s on exactly that).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { burstStatus, startBurst, stopBurst } from '../lib/burst.js';
import { localDir, remotePaths } from '../lib/config.js';
import { VmError, guard } from '../lib/errors.js';
import { fetchFrames, inlineImage } from '../lib/frames.js';
import { blankness, parsePpm, writeFrame } from '../lib/img.js';
import { clickScript } from '../lib/actions.js';
import { queryVmStatus } from '../lib/ssh.js';
import { NODE_PARAM, schema, textRender, seconds, sessionCwd, target, VMID_PARAM } from './common.js';
import { screendump } from '../lib/qmp.js';

/** Largest base64 payload the `inline` option will add, bytes. */
const INLINE_LIMIT = 200 * 1024;

/**
 * File-safe UTC timestamp.
 * @returns {string} e.g. `2026-11-24T04-31-07-512Z`.
 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Build the observation tools.
 * @param {object} deps plugin dependencies.
 * @returns {object[]} tool definitions.
 */
export function screenTools(deps) {
  return [
    defineTool({
      name: 'pve_screenshot',
      description:
        'Capture the current screen of a running VM through the host QMP socket and save it as a local ' +
        'image (JPEG by default). Returns the path, size and dimensions — not the pixels: read the file to ' +
        'look at it, or pass inline:true for a small base64 copy. Fails immediately with QMP_BUSY while a ' +
        'burst is recording, because QMP serves one client.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        name: {
          type: 'string',
          description: 'File stem for the saved image (letters, digits, dash, underscore, dot). Defaults to a timestamp.',
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format (default jpeg). JPEG keeps a 1280x800 desktop around 60 KB.',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality scale for ffmpeg/ImageMagick, 1 (best) … 10 (smallest); default 4.',
        },
        inline: {
          type: 'boolean',
          description:
            'Include the pixels as base64 in the result (only when the image is under 200 KB). Off by ' +
            'default: a 1280x800 frame as base64 costs ~90 KB of context.',
        },
        wake: {
          type: 'boolean',
          description:
            'When the frame comes out blank (a VM booted with nobody at the console sends nothing to the ' +
            'VGA scanout), click once in the guest session and capture again. Default false.',
        },
        wakeX: {
          type: 'number',
          description: 'Screen x for the wake click, pixels (default 1150 — empty desktop on the right).',
        },
        wakeY: {
          type: 'number',
          description: 'Screen y for the wake click, pixels (default 620 — inside the desktop, above the taskbar).',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'PVE node name the frame came from.' },
          host: { type: 'string', description: 'ssh host that owns the VM.' },
          blank: {
            type: 'boolean',
            description: 'The frame is a flat black or single-colour image: the desktop is not composing.',
          },
          woke: {
            type: 'boolean',
            description: 'The frame was blank and a wake click was sent before the second capture.',
          },
          path: { type: 'string', description: 'Absolute path of the saved image (read it to see the screen).' },
          bytes: { type: 'number', description: 'Size of the saved image, bytes.' },
          w: { type: 'number', description: 'Frame width, pixels.' },
          h: { type: 'number', description: 'Frame height, pixels.' },
          format: { type: 'string', description: 'Image format actually written (png when no jpeg encoder was found).' },
          encoder: { type: 'string', description: 'Which encoder produced the file.' },
          data: { type: 'string', description: 'Base64 pixels, present only with inline:true and a small image.' },
          encoding: { type: 'string', description: 'Always "base64" when data is present.' },
          inline_skipped: { type: 'string', description: 'Why inline pixels were not included.' },
          ms: { type: 'number', description: 'Time of the screendump itself.' },
          wall_ms: { type: 'number', description: 'Total wall time including conversion.' },
        }),
        render: textRender('Screenshot saved', (value) => {
          const lines = [
            `VM ${value.vmid} on ${value.node}: ${value.w}x${value.h} ${value.format}, ${value.bytes} bytes → ${value.path}`,
            `screendump ${seconds(value.ms)}, total ${seconds(value.wall_ms)}` +
              (value.encoder ? `; encoder ${value.encoder}` : ''),
          ];
          if (value.data !== undefined) lines.push('pixels included as base64');
          if (value.inline_skipped !== undefined) lines.push(value.inline_skipped);
          return lines.join('\n');
        }),
      },
      timeoutMs: 120000,
      async execute(args, exec) {
        return guard(async () => {
          const started = Date.now();
          const settings = deps.settings();
          const resolved = await target(deps, args, exec);
          const { vmid } = resolved;
          const paths = remotePaths(settings, vmid);
          const state = await burstStatus(deps.transport, resolved.host, {
            vmid,
            root: paths.root,
            burst: paths.burst,
          });
          if (state.running) {
            // Do not queue and do not steal the socket: a recorder owns QMP until it stops.
            throw new VmError(
              'QMP_BUSY',
              `a frame recorder is running for VM ${vmid} (${state.frames ?? 0} frames recorded); ` +
                'QMP accepts a single client',
              { frames: state.frames, burst: true },
            );
          }
          const format = args.format === 'png' ? 'png' : settings.frameFormat;
          const quality = Math.max(1, Math.min(10, Number(args.quality ?? settings.frameQuality)));
          const stem =
            typeof args.name === 'string' && args.name.length > 0
              ? args.name.replace(/[^A-Za-z0-9._-]/g, '_')
              : `shot-${stamp()}`;
          const outDir = localDir(settings, sessionCwd(exec, deps.ctx), `v${vmid}/shots`);
          const outPath = join(outDir, `${stem}.${format === 'jpeg' ? 'jpg' : 'png'}`);
          const capture = async () => {
            const remoteOut = `${paths.shots}/shot-${stamp()}.ppm`;
            const shot = await screendump(deps.transport, resolved.host, {
              vmid,
              outFile: remoteOut,
              qmpTimeoutMs: settings.qmpTimeoutMs,
              signal: exec?.signal,
              timeoutMs: 60000,
            });
            const image = parsePpm(shot.ppm);
            const written = await writeFrame(image, {
              outPath,
              format,
              quality,
              spawn: deps.spawn,
              cwd: deps.cwd,
            });
            return { shot, written, blank: blankness(image).blank };
          };
          let result = await capture();
          let woke = false;
          if (args.wake === true && result.blank === true && resolved.status === 'running') {
            // A VM restored from a snapshot and booted with nobody at the console composes nothing, so
            // QMP returns a flat frame until a real session-1 input arrives (measured: 12,203 bytes
            // black vs 113,064 bytes with the desktop).
            const x = Math.max(0, Math.min(8191, Math.round(Number(args.wakeX ?? 1150))));
            const y = Math.max(0, Math.min(8191, Math.round(Number(args.wakeY ?? 620))));
            await deps.bridge.run({
              node: resolved.host,
              vmid,
              body: clickScript({ x, y }),
              timeoutMs: 60000,
              signal: exec?.signal,
            });
            await new Promise((resolve) => setTimeout(resolve, 900));
            result = await capture();
            woke = true;
          }
          const { shot, written } = result;
          const value = {
            ok: true,
            vmid,
            node: resolved.node,
            host: resolved.host,
            path: written.path,
            bytes: written.bytes,
            w: written.width,
            h: written.height,
            format: written.format,
            encoder: written.encoder,
            blank: result.blank,
            ...(woke ? { woke: true } : {}),
            ms: shot.ms,
            wall_ms: Date.now() - started,
          };
          if (args.inline === true) {
            if (written.bytes > INLINE_LIMIT) {
              value.inline_skipped = `inline skipped: the image is ${written.bytes} bytes, over the ${INLINE_LIMIT} byte limit — read the file instead`;
            } else {
              const payload = await inlineImage(written.path);
              value.data = payload.data;
              value.encoding = 'base64';
            }
          }
          return value;
        });
      },
    }),

    defineTool({
      name: 'pve_burst',
      description:
        'Record frames of a running VM: start, stop, or check a background recorder. Frames are written to ' +
        'the node tmpfs at the requested rate and are pulled later with pve_fetch_frames. The recorder is a ' +
        'detached process with its own deadline, so a cancelled tool call cannot leave a loop running forever; ' +
        'still stop it explicitly when you have enough. While it runs, QMP is taken: pve_screenshot answers ' +
        'QMP_BUSY.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'start (default), stop, or status.',
        },
        fps: {
          type: 'number',
          description:
            'Frames per second for action:"start", 1…15 (default 4). 4 is the measured sweet spot: a frame ' +
            'costs ~6 ms of node CPU and the interval stays at ~250 ms.',
        },
        seconds: {
          type: 'number',
          description:
            'Recording duration cap for action:"start", seconds (default 20, max burstMaxSeconds which ' +
            'defaults to 60). Pick 15–25 s: an action plus its settle time fits, and the pull stays cheap.',
        },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'PVE node name the recorder runs on.' },
          host: { type: 'string', description: 'ssh host that owns the VM.' },
          action: { type: 'string', description: 'Action that was performed.' },
          dir: { type: 'string', description: 'Remote directory holding the frames.' },
          local: { type: 'string', description: 'Local directory pve_fetch_frames will write to.' },
          fps: { type: 'number', description: 'Requested frame rate.' },
          frames: { type: 'number', description: 'Frames recorded so far.' },
          started_ms: { type: 'number', description: 'Recorder start time, epoch ms on the node.' },
          pid: { type: 'number', description: 'Recorder process id on the node.' },
          running: { type: 'boolean', description: 'The recorder is running.' },
          was_running: { type: 'boolean', description: 'For action:"stop": the recorder was running.' },
          waited_ms: { type: 'number', description: 'How long stopping took.' },
          killed: { type: 'boolean', description: 'The recorder had to be signalled after the stop file was ignored.' },
          deadline_ms: { type: 'number', description: 'When the recorder stops itself, epoch ms.' },
          log: { type: 'string', description: 'Tail of the recorder log when something failed.' },
          already: { type: 'boolean', description: 'A recorder was already running; this call only reported it.' },
        }),
        render: textRender('Recorder', (value) =>
          value.action === 'start'
            ? [
                `recording VM ${value.vmid} on ${value.node} at ${value.fps} fps into ${value.dir}`,
                `pid ${value.pid}, ${value.frames ?? 0} frames so far; pull them with pve_fetch_frames`,
                value.deadline_ms ? `stops itself at ${new Date(value.deadline_ms).toISOString()}` : '',
              ]
                .filter((line) => line.length > 0)
                .join('\n')
            : value.action === 'stop'
              ? [
                  value.was_running ? `recorder stopped after ${seconds(value.waited_ms)}` : 'no recorder was running',
                  `${value.frames ?? 0} frames in ${value.dir}${value.killed ? ' (had to be signalled)' : ''}`,
                ].join('\n')
              : value.running
                ? `recording at ${value.fps} fps, ${value.frames} frames, pid ${value.pid}`
                : `not recording; ${value.frames ?? 0} frames in ${value.dir}`,
        ),
      },
      timeoutMs: 60000,
      async execute(args, exec) {
        return guard(async () => {
          const settings = deps.settings();
          const action = args.action === 'stop' || args.action === 'status' ? args.action : 'start';
          const resolved = await target(deps, args, exec);
          const { vmid, host } = resolved;
          const paths = remotePaths(settings, vmid);
          const local = localDir(settings, sessionCwd(exec, deps.ctx), `v${vmid}/frames`);
          const status = await burstStatus(deps.transport, host, { vmid, root: paths.root, burst: paths.burst });
          if (action === 'status') {
            return {
              ok: true,
              vmid,
              node: resolved.node,
              host,
              action,
              dir: paths.burst,
              local,
              frames: status.frames,
              running: status.running,
              ...(status.pid === null || status.pid === undefined ? {} : { pid: status.pid }),
              ...(status.fps === null || status.fps === undefined ? {} : { fps: status.fps }),
              ...(status.started_ms === null || status.started_ms === undefined ? {} : { started_ms: status.started_ms }),
            };
          }
          if (action === 'stop') {
            const stopped = await stopBurst(deps.transport, host, { vmid, root: paths.root, burst: paths.burst });
            return {
              ok: true,
              vmid,
              node: resolved.node,
              host,
              action,
              dir: paths.burst,
              local,
              was_running: stopped.was_running,
              frames: stopped.frames,
              waited_ms: stopped.waited_ms,
              killed: stopped.killed,
              running: false,
            };
          }
          const vm = await queryVmStatus(deps.transport, host, vmid);
          if (vm.status !== 'running') {
            throw new VmError('VM_STOPPED', `VM ${vmid} is ${vm.status ?? 'unknown'} on ${host}`);
          }
          if (status.running) {
            return {
              ok: true,
              vmid,
              node: resolved.node,
              host,
              action,
              dir: paths.burst,
              local,
              frames: status.frames,
              running: true,
              pid: status.pid,
              fps: status.fps,
              started_ms: status.started_ms,
              already: true,
            };
          }
          const fps = Math.max(1, Math.min(15, Math.round(Number(args.fps ?? 4))));
          const seconds = Math.max(1, Math.min(settings.burstMaxSeconds, Math.round(Number(args.seconds ?? 20))));
          const started = await startBurst(deps.transport, host, {
            vmid,
            root: paths.root,
            burst: paths.burst,
            fps,
            seconds,
            qmpTimeoutMs: settings.qmpTimeoutMs,
            signal: exec?.signal,
          });
          // Give the recorder a moment to write its first frames, so `frames` is not always 0.
          await new Promise((resolve) => setTimeout(resolve, 700));
          const after = await burstStatus(deps.transport, host, { vmid, root: paths.root, burst: paths.burst });
          return {
            ok: true,
            vmid,
            node: resolved.node,
            host,
            action,
            dir: paths.burst,
            local,
            fps,
            frames: after.frames,
            started_ms: started.started_ms,
            pid: started.pid,
            running: after.running,
            deadline_ms: started.started_ms + seconds * 1000,
          };
        });
      },
    }),

    defineTool({
      name: 'pve_fetch_frames',
      description:
        'Copy recorded frames from the node to a local directory and convert them to images, optionally only a ' +
        'range. Fetches at most `max` frames per call (default 200): a 3000-frame burst is read in slices ' +
        'instead of one long stall, and each reply stays small. Reports the frame interval percentiles and ' +
        'whether the sequence was contiguous, so a bad recording is visible without opening the frames.',
      parameters: {
        vmid: VMID_PARAM,
        node: NODE_PARAM,
        from: { type: 'number', description: 'First frame index to fetch (inclusive, default 0).' },
        to: { type: 'number', description: 'Last frame index to fetch (inclusive, default all recorded).' },
        max: {
          type: 'number',
          description: 'Maximum frames in this reply, 1…1000 (default 200). Fetch the next slice by raising `from`.',
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format for the local copies (default jpeg).',
        },
        quality: { type: 'number', description: 'JPEG quality scale, 1 (best) … 10 (smallest); default 4.' },
      },
      output: {
        schema: schema({
          vmid: { type: 'number', description: 'VM id.' },
          node: { type: 'string', description: 'PVE node name the frames came from.' },
          host: { type: 'string', description: 'ssh host that owns the VM.' },
          dir: { type: 'string', description: 'Local directory holding the converted frames.' },
          count: { type: 'number', description: 'Frames written by this call.' },
          format: { type: 'string', description: 'Image format written.' },
          first_index: { type: 'number', description: 'Index of the first frame written.' },
          last_index: { type: 'number', description: 'Index of the last frame written.' },
          first_ms: { type: 'number', description: 'Recorder timestamp of the first frame, ms.' },
          last_ms: { type: 'number', description: 'Recorder timestamp of the last frame, ms.' },
          interval_p50_ms: { type: 'number', description: 'Median interval between frames, ms (≈250 at 4 fps).' },
          interval_p95_ms: { type: 'number', description: '95th percentile interval, ms.' },
          contiguous: { type: 'boolean', description: 'No gaps in the fetched index sequence.' },
          missing: { type: 'array', items: { type: 'number' }, description: 'First missing indices (up to 10).' },
          skipped: { type: 'array', items: { type: 'number' }, description: 'Frames the node could not read (up to 10).' },
          total_on_node: { type: 'number', description: 'Frames present for that range on the node.' },
          truncated_by_max: { type: 'boolean', description: 'More frames were available than `max` allowed.' },
          pattern: { type: 'string', description: 'File name pattern inside `dir`.' },
          sample: { type: 'array', items: { type: 'string' }, description: 'First few absolute paths.' },
          wall_ms: { type: 'number', description: 'Total wall time.' },
        }),
        render: textRender('Frames fetched', (value) =>
          [
            `${value.count} frames (${value.first_index}…${value.last_index}) → ${value.dir}`,
            `interval p50 ${value.interval_p50_ms ?? 'n/a'} ms, p95 ${value.interval_p95_ms ?? 'n/a'} ms`,
            value.contiguous ? 'indices contiguous' : `gaps at ${(value.missing ?? []).join(', ')}`,
            value.truncated_by_max ? 'more frames available: fetch the next slice with a higher `from`' : '',
            `total ${seconds(value.wall_ms)}`,
          ]
            .filter((line) => line.length > 0)
            .join('\n'),
        ),
      },
      timeoutMs: 600000,
      async execute(args, exec) {
        return guard(async () => {
          const settings = deps.settings();
          const resolved = await target(deps, args, exec);
          const { vmid, host } = resolved;
          const paths = remotePaths(settings, vmid);
          const from = Math.max(0, Math.round(Number(args.from ?? 0)));
          const to = Math.max(from, Math.round(Number(args.to ?? 99999)));
          const max = Math.max(1, Math.min(1000, Math.round(Number(args.max ?? 200))));
          const format = args.format === 'png' ? 'png' : 'jpeg';
          const quality = Math.max(1, Math.min(10, Number(args.quality ?? settings.frameQuality)));
          const outDir = localDir(settings, sessionCwd(exec, deps.ctx), `v${vmid}/frames`);
          const value = await fetchFrames({
            transport: deps.transport,
            node: host,
            vmid,
            burstDir: paths.burst,
            localDir: outDir,
            from,
            to,
            max,
            format,
            quality,
            spawn: deps.spawn,
            cwd: deps.cwd,
            signal: exec?.signal,
            timeoutMs: 540000,
          });
          return { ...value, node: resolved.node, host, wall_ms: value.ms };
        });
      },
    }),
  ];
}
