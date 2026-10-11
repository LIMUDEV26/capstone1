#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const deepMode = process.argv.includes('--deep');

const defaultRetention = 10;
const envRetention = Number.parseInt(process.env.BACKUP_MAX_FILES || '', 10);
const backupRetention = Number.isInteger(envRetention) && envRetention > 0
  ? Math.min(envRetention, 500)
  : defaultRetention;

const dirsToRemove = ['.next', '.turbo', 'out', 'HTML', 'coverage'];
const filesToRemove = ['tsconfig.tsbuildinfo'];
if (deepMode) {
  dirsToRemove.push('node_modules');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(value >= 10 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

async function getFileSizeSafe(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function getDirectorySizeSafe(dirPath) {
  let total = 0;
  const stack = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        total += await getFileSizeSafe(fullPath);
      }
    }
  }

  return total;
}

async function removePath(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  const beforeSize = await getDirectorySizeSafe(fullPath) || await getFileSizeSafe(fullPath);

  try {
    await fs.rm(fullPath, { recursive: true, force: true });
    return { relativePath, removed: true, bytes: beforeSize };
  } catch {
    return { relativePath, removed: false, bytes: 0 };
  }
}

async function pruneBackups() {
  const backupDir = path.join(projectRoot, 'backups');
  let entries;
  try {
    entries = await fs.readdir(backupDir, { withFileTypes: true });
  } catch {
    return { deletedFiles: 0, deletedBytes: 0, keptFiles: 0 };
  }

  const backupFiles = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^backup_.*\.sql$/i.test(entry.name)) continue;

    const fullPath = path.join(backupDir, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      backupFiles.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      continue;
    }
  }

  backupFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = backupFiles.slice(backupRetention);

  let deletedBytes = 0;
  let deletedFiles = 0;
  for (const file of toDelete) {
    try {
      await fs.rm(file.fullPath, { force: true });
      deletedBytes += file.size;
      deletedFiles += 1;
    } catch {
      // keep going
    }
  }

  return {
    deletedFiles,
    deletedBytes,
    keptFiles: Math.max(0, backupFiles.length - deletedFiles),
  };
}

async function main() {
  const removedItems = [];
  for (const rel of dirsToRemove) {
    removedItems.push(await removePath(rel));
  }
  for (const rel of filesToRemove) {
    removedItems.push(await removePath(rel));
  }

  const backupSummary = await pruneBackups();
  const freedFromItems = removedItems.reduce((sum, item) => sum + item.bytes, 0);
  const totalFreed = freedFromItems + backupSummary.deletedBytes;

  console.log('Storage cleanup complete.');
  console.log(`Mode: ${deepMode ? 'deep' : 'standard'}`);
  console.log(`Freed: ${formatBytes(totalFreed)}`);
  console.log('');
  console.log('Removed paths:');
  for (const item of removedItems) {
    const status = item.removed ? 'removed' : 'not-found-or-skipped';
    console.log(`- ${item.relativePath}: ${status} (${formatBytes(item.bytes)})`);
  }
  console.log('');
  console.log('Backup retention:');
  console.log(`- keep latest: ${backupRetention}`);
  console.log(`- deleted backups: ${backupSummary.deletedFiles} (${formatBytes(backupSummary.deletedBytes)})`);
  console.log(`- backups kept: ${backupSummary.keptFiles}`);
  if (!deepMode) {
    console.log('');
    console.log('Tip: run "npm run clean:storage:deep" to also remove node_modules.');
  }
}

main().catch((error) => {
  console.error('Storage cleanup failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
