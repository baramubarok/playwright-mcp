import assert from "node:assert/strict";
import test from "node:test";
import { parseGherkin } from "../../src/lib/testCases/gherkin.js";
import { detectDelimiter, parseCsv, parseDelimited, rowsToTestCases, splitList } from "../../src/lib/testCases/tabular.js";

const FEATURE = `# language: en
@auth
Feature: Login
  As a user I want to log in.

  Background:
    Given the app is open

  @TC-001 @smoke
  Scenario: Valid user can log in
    Given I am on the login page
    And I have a valid account
    When I fill in valid credentials
    And I submit the form
    Then I am redirected to the dashboard
    But I do not see an error

  @regression
  Scenario Outline: Invalid logins are rejected
    When I log in as "<user>"
    Then I see "<message>"

    Examples:
      | user  | message         |
      | bob   | Unknown user    |
      | alice | Wrong password  |

  Scenario: Empty scenario
    Given nothing happens
`;

test("parseGherkin maps keywords, tags, background and outline examples", () => {
  const { cases, warnings } = parseGherkin(FEATURE, "docs/test-case/login.feature");
  assert.equal(cases.length, 3);

  const [valid, outline, empty] = cases;
  assert.equal(valid.id, "TC-001");
  assert.equal(valid.title, "Valid user can log in");
  assert.equal(valid.feature, "Login");
  assert.equal(valid.priority, "smoke");
  assert.deepEqual(valid.tags, ["auth", "smoke"]);
  assert.deepEqual(valid.preconditions, ["the app is open", "I am on the login page", "I have a valid account"]);
  assert.deepEqual(valid.steps, ["I fill in valid credentials", "I submit the form"]);
  assert.deepEqual(valid.expected, ["I am redirected to the dashboard", "I do not see an error"]);
  assert.deepEqual(valid.source, { file: "docs/test-case/login.feature", line: 10 });

  assert.equal(outline.id, "login-2", "generated id when no id tag exists");
  assert.equal(outline.priority, "regression");
  assert.deepEqual(outline.examples, [
    { user: "bob", message: "Unknown user" },
    { user: "alice", message: "Wrong password" },
  ]);
  assert.equal(empty.steps.length, 0);
  assert.ok(warnings.some((warning) => /Empty scenario" has no When\/Then steps/.test(warning)));
  assert.ok(!warnings.some((warning) => /As a user/.test(warning)), "feature descriptions are not warnings");
});

test("parseGherkin ignores comments and doc strings and warns about stray text after steps", () => {
  const { cases, warnings } = parseGherkin(
    ['Feature: F', '@TC-9', 'Scenario: S', '  When I send', '    """', '    Then not a step', '    """', '  Then ok', '  Thne typo here', '  # Given commented'].join("\n"),
    "f.feature",
  );
  assert.deepEqual(cases[0].steps, ["I send"]);
  assert.deepEqual(cases[0].expected, ["ok"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /f\.feature:9 unrecognized line/);
  assert.deepEqual(parseGherkin("Feature: Nothing\n", "n.feature").warnings, ["n.feature: no Scenario found."]);
});

test("parseDelimited handles quotes, escaped quotes, embedded newlines, BOM and CRLF", () => {
  const rows = parseDelimited('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n"line1\nline2",z\r\n', ",");
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"'], ["line1\nline2", "z"]]);
  assert.equal(detectDelimiter("ID;Title;Steps"), ";");
  assert.equal(detectDelimiter("ID\tTitle\tSteps"), "\t");
  assert.equal(detectDelimiter("ID,Title,Steps"), ",");
});

test("splitList splits on ; and newlines and strips numbering and bullets", () => {
  assert.deepEqual(splitList("1. Open page; 2) Fill form\n- Click save\n\n"), ["Open page", "Fill form", "Click save"]);
  assert.deepEqual(splitList(""), []);
});

test("parseCsv maps flexible headers, priority and tags", () => {
  const csv = [
    "Test Case ID,Test Case Name,Pre-condition,Test Steps,Expected Result,Priority,Tags",
    'TC-101,Valid login,Account exists,"Open login; Fill form; Click Login","Dashboard shown; Welcome visible",Smoke,"@auth login"',
    ",Second case,,Open page,,P2,",
    ",,,,,,",
    "TC-103,,,Open page,Something,,",
  ].join("\n");
  const { cases, warnings } = parseCsv(csv, "docs/test-case/login.csv");

  assert.equal(cases.length, 2);
  assert.deepEqual(cases[0], {
    id: "TC-101",
    title: "Valid login",
    priority: "smoke",
    tags: ["auth", "login", "smoke"],
    preconditions: ["Account exists"],
    steps: ["Open login", "Fill form", "Click Login"],
    expected: ["Dashboard shown", "Welcome visible"],
    source: { file: "docs/test-case/login.csv", row: 2 },
  });
  assert.equal(cases[1].id, "login-2");
  assert.equal(cases[1].priority, "p2");
  assert.ok(warnings.some((warning) => /row 3: "Second case" has no expected result/.test(warning)));
  assert.ok(warnings.some((warning) => /row 5: skipped because Title is empty/.test(warning)));
});

test("rowsToTestCases reports missing required columns and empty files", () => {
  const missing = rowsToTestCases([["ID", "Notes"], ["1", "x"]], "a.csv");
  assert.deepEqual(missing.cases, []);
  assert.match(missing.warnings[0], /missing required column\(s\): title, steps\. Found headers: ID \| Notes/);
  assert.match(rowsToTestCases([], "b.csv").warnings[0], /empty/);
});

test("semicolon separated exports are detected", () => {
  const { cases } = parseCsv("ID;Title;Steps;Expected\nTC-1;Login;Open; Click;Done\n", "s.csv");
  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0].steps, ["Open"]);
});
