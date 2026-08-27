import fg from "fast-glob";
import { z } from "zod";
import { getProjectRoot } from "../lib/config.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.nuxt/**", "**/.output/**"];

export const listFilesInputShape = {
  dir: z
    .string()
    .optional()
    .describe("Directory relative to PROJECT_ROOT to search in. Defaults to the whole project."),
  pattern: z
    .string()
    .optional()
    .describe("Glob pattern relative to `dir`, e.g. \"**/*.spec.ts\" or \"pages/**/*.vue\". Defaults to all files."),
};

export const listFilesSchema = z.object(listFilesInputShape);
export type ListFilesInput = z.infer<typeof listFilesSchema>;

export interface ListFilesOutput {
  files: Array<{ path: string; sizeBytes: number; extension: string }>;
}

export async function listFiles(input: ListFilesInput): Promise<ListFilesOutput> {
  const root = getProjectRoot();
  const cwd = input.dir ? `${root}/${input.dir}` : root;
  const pattern = input.pattern ?? "**/*";
  const entries = await fg(pattern, {
    cwd,
    ignore: DEFAULT_IGNORE,
    onlyFiles: true,
    stats: true,
    dot: false,
  });
  const files = entries.map((entry) => {
    const relativePath = input.dir ? `${input.dir}/${entry.path}` : entry.path;
    const dotIndex = entry.path.lastIndexOf(".");
    return {
      path: relativePath,
      sizeBytes: entry.stats?.size ?? 0,
      extension: dotIndex >= 0 ? entry.path.slice(dotIndex + 1) : "",
    };
  });
  return { files };
}
