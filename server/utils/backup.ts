import { promises as fs } from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { dataDir, snapshot } from "./store";

/*
 * Backups are written outside the data directory by default (BACKUP_DIR), so a
 * damaged or deleted volume does not take its own copies with it. Each run is a
 * folder holding a transaction-consistent database snapshot plus the attachment
 * and repair-sheet files, which together are everything needed to restore.
 */

const FILE_DIRS = ["attachments", "repair-times-pdfs"];

export const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, "backups"));
const retention = () => Math.max(1, Number(process.env.BACKUP_RETENTION) || 7);

// 2026-11-12T03-15-00: sorts chronologically as a folder name.
function stamp() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}

function readableSqlite(bytes: Buffer) {
  return bytes.subarray(0, 16).toString("latin1") === "SQLite format 3\u0000";
}

async function copyEntry(source: string, destination: string) {
  // A link costs nothing and keeps unchanged files from multiplying across
  // nightly runs; it cannot cross volumes, so a copy is the fallback.
  try { await fs.link(source, destination); }
  catch { await fs.copyFile(source, destination); }
}

export async function pruneBackups() {
  let names: string[] = [];
  try {
    names = (await fs.readdir(backupDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
      .map(entry => entry.name);
  } catch {
    return;
  }
  names.sort().reverse();
  for (const stale of names.slice(retention())) {
    await fs.rm(path.join(backupDir, stale), { recursive: true, force: true });
  }
}

export async function runBackup(): Promise<{ directory: string; files: number }> {
  const directory = path.join(backupDir, stamp());
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const database = path.join(directory, "workshop.sqlite");
  await snapshot(database);
  // A backup nobody opened is a guess: refuse to keep one that is not database.
  if (!readableSqlite(await fs.readFile(database))) throw new Error("The database snapshot is not a SQLite file");

  let files = 0;
  for (const folder of FILE_DIRS) {
    const source = path.join(dataDir, folder);
    const target = path.join(directory, folder);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    let names: string[] = [];
    try { names = await fs.readdir(source); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of names) {
      await copyEntry(path.join(source, name), path.join(target, name));
      files += 1;
    }
  }

  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    format: "workshop-atlas-backup-v1",
    createdAt: new Date().toISOString(),
    database: "workshop.sqlite",
    folders: FILE_DIRS,
    files,
  }, null, 2), { mode: 0o600 });
  await pruneBackups();
  return { directory, files };
}

// A plain .tar.gz so a backup can be opened anywhere, with no export format of
// our own to maintain. Headers are written by hand: a backup must not depend on
// an extra package that could disappear from the image.
function tarHeader(name: string, size: number, modified: Date) {
  const block = Buffer.alloc(512, 0);
  block.write(name.slice(0, 100), 0, 100, "utf8");
  block.write("0000644\u0000", 100, 8, "ascii");
  block.write("0000000\u0000", 108, 8, "ascii");
  block.write("0000000\u0000", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\u0000`, 124, 12, "ascii");
  block.write(`${Math.floor(modified.getTime() / 1000).toString(8).padStart(11, "0")}\u0000`, 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii"); // checksum field, spaces while summing
  block.write("0", 156, 1, "ascii"); // regular file
  block.write("ustar\u0000", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += block[index];
  block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8, "ascii");
  return block;
}

type ArchiveEntry = { name: string; file?: string; data?: Buffer };

const README = `Workshop Atlas backup
=====================

workshop.sqlite        your workshop database: vehicles, records, accounts, sessions
attachments/           uploaded files, named by the id recorded in the database
repair-times-pdfs/     uploaded repair-time sheets, named the same way

Restoring
---------
Stop the application, then copy these into the data volume (/data in Docker):

  workshop.sqlite   -> /data/workshop.sqlite      (delete any -wal and -shm first)
  attachments/      -> /data/attachments/
  repair-times-pdfs/-> /data/repair-times-pdfs/

Start the same application version again. This archive holds customer
information and password hashes: treat it as private.
`;

async function* tarChunks(entries: ArchiveEntry[], modified: Date) {
  for (const entry of entries) {
    const data = entry.data ?? await fs.readFile(entry.file as string);
    yield tarHeader(entry.name, data.length, modified);
    const padding = (512 - (data.length % 512)) % 512;
    yield padding ? Buffer.concat([data, Buffer.alloc(padding, 0)]) : data;
  }
  yield Buffer.alloc(1024, 0); // end of archive
}

export async function backupArchive() {
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(backupDir, `.export-${randomUUID()}.sqlite`);
  await snapshot(temporary);
  let database: Buffer;
  try { database = await fs.readFile(temporary); }
  finally { await fs.rm(temporary, { force: true }); }
  if (!readableSqlite(database)) throw new Error("The database snapshot is not a SQLite file");

  const entries: ArchiveEntry[] = [
    { name: "README.txt", data: Buffer.from(README, "utf8") },
    { name: "workshop.sqlite", data: database },
  ];
  for (const folder of FILE_DIRS) {
    let names: string[] = [];
    try { names = await fs.readdir(path.join(dataDir, folder)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of names) entries.push({ name: `${folder}/${name}`, file: path.join(dataDir, folder, name) });
  }

  const gzip = createGzip();
  Readable.from(tarChunks(entries, new Date())).pipe(gzip);
  return {
    body: Readable.toWeb(gzip) as unknown as ReadableStream<Uint8Array>,
    filename: `workshop-atlas-backup-${stamp()}.tar.gz`,
  };
}
