import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_EOCD_SEARCH_BYTES = 0xffff + 22;

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ReadZipOptions {
  /** Entries whose name does not satisfy the filter are never decompressed. */
  filter: (name: string) => boolean;
  /** Upper bound for each decompressed entry. Larger entries are skipped. */
  maxEntryBytes: number;
  /** Upper bound for the archive file itself. */
  maxArchiveBytes: number;
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function readEntries(fd: number, fileSize: number): ZipEntry[] {
  const searchLength = Math.min(fileSize, MAX_EOCD_SEARCH_BYTES);
  const tail = readAt(fd, fileSize - searchLength, searchLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive (end of central directory not found).");

  const entryCount = tail.readUInt16LE(eocd + 10);
  const directorySize = tail.readUInt32LE(eocd + 12);
  const directoryOffset = tail.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new Error("Zip64 archives are not supported.");
  }

  const directory = readAt(fd, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < entryCount && offset + 46 <= directory.length; index++) {
    if (directory.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) break;
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    entries.push({
      compressionMethod: directory.readUInt16LE(offset + 10),
      compressedSize: directory.readUInt32LE(offset + 20),
      uncompressedSize: directory.readUInt32LE(offset + 24),
      localHeaderOffset: directory.readUInt32LE(offset + 42),
      name: directory.toString("utf8", offset + 46, offset + 46 + nameLength),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(fd: number, entry: ZipEntry, maxEntryBytes: number): Buffer | undefined {
  if (entry.uncompressedSize > maxEntryBytes) return undefined;
  const header = readAt(fd, entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_FILE_HEADER) return undefined;
  const dataOffset = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const compressed = readAt(fd, dataOffset, entry.compressedSize);
  if (entry.compressionMethod === 0) return compressed;
  if (entry.compressionMethod === 8) return inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
  return undefined;
}

/**
 * Minimal, dependency-free zip reader for Playwright trace archives. Only the requested entries are
 * decompressed, and every read is size-bounded so a large or hostile archive cannot exhaust memory.
 */
export function readZipEntries(archivePath: string, options: ReadZipOptions): Map<string, Buffer> {
  const fd = openSync(archivePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize > options.maxArchiveBytes) throw new Error("Archive exceeds the configured size limit.");
    const result = new Map<string, Buffer>();
    for (const entry of readEntries(fd, fileSize)) {
      if (!options.filter(entry.name)) continue;
      try {
        const data = readEntryData(fd, entry, options.maxEntryBytes);
        if (data) result.set(entry.name, data);
      } catch {
        // A corrupt entry is skipped; the remaining entries can still be useful.
      }
    }
    return result;
  } finally {
    closeSync(fd);
  }
}
