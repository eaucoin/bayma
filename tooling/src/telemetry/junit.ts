import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

// Test results from a JUnit XML report, the one format every test runner
// here writes: `bun test --reporter=junit` and pytest's `--junitxml`. A
// report gives each test's outcome and duration but not when it started,
// so tests are recorded as results rather than as spans.

export type TestStatus = "pass" | "fail" | "skipped";

export interface TestResult {
  /** The file for Bun, the test class for pytest. */
  suite: string;
  /** The test's name, within the describe blocks around it. */
  name: string;
  status: TestStatus;
  seconds: number;
  file?: string;
  line?: number;
  /** For a failure: what failed, and the runner's message when it has one. */
  failure?: { type?: string; message?: string };
}

interface XmlElement {
  [key: string]: unknown;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  isArray: (name) => ["testsuite", "testcase"].includes(name),
});

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The first of an element's `failure` or `error` children. */
function failureOf(testcase: XmlElement): TestResult["failure"] {
  const found = testcase.failure ?? testcase.error;
  if (found === undefined) return undefined;
  const element = (Array.isArray(found) ? found[0] : found) as
    XmlElement | string;
  if (typeof element === "string") return { message: text(element) };
  return {
    type: text(element.type),
    message: text(element.message) ?? text(element["#text"]),
  };
}

function collect(
  suite: XmlElement,
  path: string[],
  results: TestResult[],
): void {
  for (const testcase of (suite.testcase ?? []) as XmlElement[]) {
    const failure = failureOf(testcase);
    const file = text(testcase.file);
    const line = Number(testcase.line);
    results.push({
      suite: file ?? text(testcase.classname) ?? path[0] ?? "",
      name: [...path.slice(1), String(testcase.name)].join(" > "),
      status: failure
        ? "fail"
        : testcase.skipped !== undefined
          ? "skipped"
          : "pass",
      seconds: Number(testcase.time) || 0,
      ...(file ? { file } : {}),
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(failure ? { failure } : {}),
    });
  }
  for (const nested of (suite.testsuite ?? []) as XmlElement[])
    collect(nested, [...path, String(nested.name)], results);
}

/** Every test in a JUnit XML report, in the report's order. */
export function parseJUnit(xml: string): TestResult[] {
  const document = parser.parse(xml) as XmlElement;
  const root = (document.testsuites ?? document) as XmlElement;
  const results: TestResult[] = [];
  for (const suite of (root.testsuite ?? []) as XmlElement[])
    collect(suite, [String(suite.name)], results);
  return results;
}

export function readJUnit(path: string): TestResult[] {
  return parseJUnit(readFileSync(path, "utf8"));
}
