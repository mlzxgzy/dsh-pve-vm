/**
 * A `ctx.subprocess.spawn` stand-in for local smoke tests: the same handle shape the plugin sees
 * (`stdin`, `stdout`, `stderr`, `collected`, `done`, `terminate`), backed by node:child_process.
 *
 * This file is a development aid, not part of the plugin runtime.
 */
import { spawn as spawnChild } from 'node:child_process';

/**
 * Spawn one process and wrap it in the harness subprocess handle shape.
 * @param {{argv:string[], cwd:string, env?:object, stdio?:object, graceMs?:number}} spec subprocess spec.
 * @returns {object} a handle.
 */
export function spawnCompat(spec) {
  const [command, ...args] = spec.argv;
  const child = spawnChild(command, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? -1 }));
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    terminate: () => child.kill('SIGTERM'),
    collected: {
      stdout: {
        readFrom: () => ({ text: Buffer.concat(stdoutChunks).toString('utf8') }),
        snapshot: () => ({ bytes: Buffer.concat(stdoutChunks) }),
      },
      stderr: {
        readFrom: () => ({ text: Buffer.concat(stderrChunks).toString('utf8') }),
        snapshot: () => ({ bytes: Buffer.concat(stderrChunks) }),
      },
    },
  };
}
