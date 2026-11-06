import { generatedId, isIdTag, isPriorityTag, type ParseResult, type TestCase } from "./types.js";

const STEP_PATTERN = /^(Given|When|Then|And|But|\*)\s+(.+)$/i;
const MAX_EXAMPLE_ROWS = 10;

type Section = "given" | "when" | "then";

interface Draft {
  title: string;
  line: number;
  tags: string[];
  given: string[];
  when: string[];
  then: string[];
  exampleHeader?: string[];
  examples: Array<Record<string, string>>;
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Light Gherkin reader: Feature, Background, Scenario / Scenario Outline (+ Examples) and tagged steps.
 * Given (and Background) become preconditions, When the steps, Then the expected results; And/But/*
 * continue the previous keyword. Comments, doc strings and step data tables are ignored.
 */
export function parseGherkin(content: string, file: string): ParseResult {
  const warnings: string[] = [];
  const cases: TestCase[] = [];
  let feature: string | undefined;
  let featureTags: string[] = [];
  let pendingTags: string[] = [];
  const background: string[] = [];
  let current: Draft | undefined;
  let inBackground = false;
  let inExamples = false;
  let inDocString = false;
  let section: Section = "given";

  const finish = (): void => {
    if (!current) return;
    const draft = current;
    current = undefined;
    const idTag = draft.tags.find(isIdTag);
    const priority = draft.tags.find(isPriorityTag);
    if (draft.when.length === 0 && draft.then.length === 0) {
      warnings.push(`${file}:${draft.line} scenario "${draft.title}" has no When/Then steps.`);
    }
    cases.push({
      id: idTag ?? generatedId(file, cases.length + 1),
      title: draft.title,
      ...(feature ? { feature } : {}),
      ...(priority ? { priority } : {}),
      tags: draft.tags.filter((tag) => tag !== idTag),
      preconditions: [...background, ...draft.given],
      steps: draft.when,
      expected: draft.then,
      ...(draft.examples.length > 0 ? { examples: draft.examples } : {}),
      source: { file, line: draft.line },
    });
  };

  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line.startsWith('"""') || line.startsWith("```")) {
      inDocString = !inDocString;
      continue;
    }
    if (inDocString || line === "" || line.startsWith("#")) continue;

    if (line.startsWith("@")) {
      pendingTags.push(...line.split(/\s+/).filter((token) => token.startsWith("@") && token.length > 1).map((token) => token.slice(1)));
      continue;
    }

    const keyword = line.match(/^(Feature|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios|Rule):\s*(.*)$/i);
    if (keyword) {
      const kind = keyword[1].toLowerCase();
      const text = keyword[2].trim();
      if (kind === "feature") {
        finish();
        feature = text || undefined;
        featureTags = pendingTags;
        pendingTags = [];
        inBackground = false;
        inExamples = false;
      } else if (kind === "background") {
        finish();
        inBackground = true;
        inExamples = false;
        section = "given";
        pendingTags = [];
      } else if (kind === "examples" || kind === "scenarios") {
        inExamples = true;
        pendingTags = [];
      } else if (kind === "rule") {
        pendingTags = [];
      } else {
        finish();
        inBackground = false;
        inExamples = false;
        section = "given";
        current = { title: text || `Scenario ${cases.length + 1}`, line: lineNumber, tags: [...featureTags, ...pendingTags], given: [], when: [], then: [], examples: [] };
        pendingTags = [];
      }
      continue;
    }

    if (line.startsWith("|")) {
      if (inExamples && current) {
        const cells = splitCells(line);
        if (!current.exampleHeader) current.exampleHeader = cells;
        else if (current.examples.length < MAX_EXAMPLE_ROWS) {
          const header = current.exampleHeader;
          current.examples.push(Object.fromEntries(header.map((name, column) => [name, cells[column] ?? ""])));
        }
      }
      continue;
    }

    const step = line.match(STEP_PATTERN);
    if (step) {
      const word = step[1].toLowerCase();
      if (word === "given") section = "given";
      else if (word === "when") section = "when";
      else if (word === "then") section = "then";
      const text = step[2].trim();
      if (inBackground) background.push(text);
      else if (current) current[section].push(text);
      else warnings.push(`${file}:${lineNumber} step outside a Scenario was ignored: "${line}"`);
      continue;
    }

    // Free text (Feature/Scenario descriptions) is valid Gherkin; only text after steps is likely a typo.
    if (current && current.given.length + current.when.length + current.then.length > 0) {
      warnings.push(`${file}:${lineNumber} unrecognized line ignored: "${line.slice(0, 60)}"`);
    }
  }
  finish();

  if (cases.length === 0) warnings.push(`${file}: no Scenario found.`);
  return { cases, warnings };
}
