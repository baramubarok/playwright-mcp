import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

export function readReportFixture(name: string): string {
  return readFileSync(path.join(testDirectory, "..", "fixtures", "reports", name), "utf8");
}
