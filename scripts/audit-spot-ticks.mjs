import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

export function isValidSpotSessionTimestamp(ts) {
  const kst = new Date(ts * 1000 + 9 * 3600000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minutes >= 480 && minutes <= 1080;
}

export function auditSpotTicks(dbPath, {apply = false, backupPath} = {}) {
  if (apply) {
    if (!backupPath) throw new Error('APPLY_REQUIRES_BACKUP_PATH');
    fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  }
  const db = new Database(dbPath);
  try {
    const rows = db.prepare('SELECT ts FROM ticks ORDER BY ts').all();
    const invalid = rows.filter((row) => !isValidSpotSessionTimestamp(row.ts)).map((row) => row.ts);
    if (apply && invalid.length > 0) {
      const remove = db.prepare('DELETE FROM ticks WHERE ts = ?');
      db.transaction((timestamps) => {
        for (const ts of timestamps) remove.run(ts);
      })(invalid);
    }
    return {total: rows.length, invalid: invalid.length, retained: rows.length - invalid.length, applied: apply};
  } finally {
    db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf('--db');
  if (dbIndex < 0 || !args[dbIndex + 1]) throw new Error('USAGE: --db <path> [--apply --backup <path>]');
  const backupIndex = args.indexOf('--backup');
  const result = auditSpotTicks(args[dbIndex + 1], {
    apply: args.includes('--apply'),
    backupPath: backupIndex >= 0 ? args[backupIndex + 1] : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
