import { openSync, readSync, closeSync } from 'node:fs';

export function readAsar(archive, entry) {
  const fd = openSync(archive, 'r');
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    const json = Buffer.alloc(header.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    let file = JSON.parse(json);
    for (const part of entry.split('/').filter(Boolean)) file = file.files?.[part];
    if (!file || file.files || file.unpacked) throw new Error(`Cannot read packed entry: ${entry}`);
    const data = Buffer.alloc(Number(file.size));
    readSync(fd, data, 0, data.length, 8 + header.readUInt32LE(4) + Number(file.offset));
    return data.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1]?.endsWith('read-asar.mjs')) {
  for (const entry of process.argv.slice(3)) {
    console.log(`\n[${entry}]\n${readAsar(process.argv[2], entry)}`);
  }
}
