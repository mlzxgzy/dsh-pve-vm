/**
 * Audit log for the one dangerous tool (`pve_guest_exec`).
 *
 * It runs arbitrary PowerShell as SYSTEM inside the guest; the brief asks for a complete local
 * record of every call, so the log keeps the whole script (not a truncated preview) plus the
 * outcome. The file rolls at 1 MiB and keeps one previous generation: an audit trail that can grow
 * without limit is a way to fill the operator's disk.
 */
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { localDir } from './config.js';

/** Rotation threshold, bytes. */
const MAX_BYTES = 1024 * 1024;

/**
 * Where the audit log lives.
 * @param {object} settings resolved settings.
 * @param {string} cwd session working directory.
 * @returns {string} absolute path.
 */
export function auditPath(settings, cwd) {
  if (settings.auditLog.startsWith('/')) return settings.auditLog;
  return join(localDir(settings, cwd), 'audit.jsonl');
}

/**
 * Append one audit record, rotating first when the file grew too large.
 * @param {object} settings resolved settings.
 * @param {string} cwd session working directory.
 * @param {object} entry record fields (`script`, `vmid`, `node`, `exitcode`, `ms`, `error`).
 * @returns {Promise<{path:string, rotated:boolean}>} where it went.
 */
export async function appendAudit(settings, cwd, entry) {
  const path = auditPath(settings, cwd);
  await mkdir(dirname(path), { recursive: true });
  let rotated = false;
  try {
    const info = await stat(path);
    if (info.size > MAX_BYTES) {
      await rename(path, `${path}.1`).catch(async () => {
        await writeFile(`${path}.1`, '');
      });
      rotated = true;
    }
  } catch {
    // The file does not exist yet: nothing to rotate.
  }
  const record = { ts: new Date().toISOString(), ...entry };
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  return { path, rotated };
}
