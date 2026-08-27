import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { resolveInProjectRoot } from "../lib/config.js";

const MAX_BYTES = 200_000;

export const readFileInputShape = {
  path: z.string().describe("Path relative to PROJECT_ROOT, e.g. \"docs/fsd/payment.md\" or \"src/pages/payment.vue\"."),
};

export const readFileSchema = z.object(readFileInputShape);
export type ReadFileInput = z.infer<typeof readFileSchema>;

export interface ReadFileOutput {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

export function readFile(input: ReadFileInput): ReadFileOutput {
  const absolutePath = resolveInProjectRoot(input.path);
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${input.path}`);
  }
  const buffer = readFileSync(absolutePath);
  const truncated = buffer.byteLength > MAX_BYTES;
  const content = buffer.subarray(0, MAX_BYTES).toString("utf-8");
  return {
    path: input.path,
    content,
    sizeBytes: stat.size,
    truncated,
  };
}
