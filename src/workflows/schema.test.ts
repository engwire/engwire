import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv from "ajv/dist/2020";
import schema from "./workflow.schema.json" with { type: "json" };

const workflows = resolve(import.meta.dir, "..", "..", ".engwire", "workflows");

// `strict` refuses a keyword Ajv does not know, so a typo in the schema fails
// here rather than validating nothing.
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);

/** The name grammar without its anchors, to build the other rules from. */
const name = schema.$defs.name.pattern.slice(1, -1);

/** A passing workflow, fresh each time, to change one thing in. */
const example = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(workflows, "review-request.json"), "utf8"));

function problems(workflow: unknown): string[] {
  validate(workflow);
  return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

describe("workflow.schema.json", () => {
  test("uses the canonical schema identifier", () => {
    // Keep the schema identifier and the value `$schema` accepts in sync.
    expect(schema.$id).toBe("https://engwire.com/schemas/workflow.json");
    expect(schema.properties.$schema.const).toBe(schema.$id);
  });

  test("names plugins and actions with the one grammar", () => {
    // `uses` cannot $ref two halves into one string, so it spells the pattern
    // out; this keeps that copy honest.
    expect(schema.properties.steps.items.properties.uses.pattern).toBe(`^${name}\\.${name}$`);
  });

  test("every workflow this repository publishes validates", () => {
    const files = readdirSync(workflows).filter((file) => !file.startsWith("."));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // The file name is the canonical name, so it follows the same grammar.
      expect(file).toMatch(new RegExp(`^${name}\\.json$`));
      const workflow = JSON.parse(readFileSync(join(workflows, file), "utf8"));
      expect(workflow.$schema).toBe(schema.$id);
      expect(problems(workflow)).toEqual([]);
    }
  });

  test("an unknown key is an error, not a default", () => {
    // As config.toml does, at every level the schema owns. What goes in `with`
    // is the capability's to check.
    expect(problems({ ...example(), name: "review-request" })).not.toEqual([]);
    expect(problems({ ...example(), on: { github: { event: "a", evnet: "b" } } })).not.toEqual([]);
    expect(problems({ ...example(), steps: [{ uses: "agent.run", inputs: {} }] })).not.toEqual([]);
    expect(problems({ ...example(), steps: [{ uses: "agent.run", with: { anything: 1 } }] })).toEqual([]);
  });

  test("an event is a non-empty string, and `with` maps input names to values", () => {
    // Sources own event vocabulary, including whether whitespace-only names are valid.
    expect(problems({ ...example(), on: { github: { event: "" } } })).not.toEqual([]);
    expect(
      problems({ ...example(), steps: [{ uses: "agent.run", with: "skill=review" }] }),
    ).not.toEqual([]);
  });

  test("a workflow needs a title, one trigger and a step", () => {
    const { title: _title, ...untitled } = example();
    const { on: _on, ...untriggered } = example();
    const { steps: _steps, ...idle } = example();
    expect(problems(untitled)).not.toEqual([]);
    expect(problems(untriggered)).not.toEqual([]);
    expect(problems(idle)).not.toEqual([]);
    expect(problems({ ...example(), on: {} })).not.toEqual([]);
    expect(problems({ ...example(), on: { github: {} } })).not.toEqual([]);
    expect(
      problems({ ...example(), on: { github: { event: "a" }, linear: { event: "b" } } }),
    ).not.toEqual([]);
    expect(problems({ ...example(), steps: [] })).not.toEqual([]);
  });

  test("pins the current required keys and keeps description optional", () => {
    // Assert the current format; compatibility is not guaranteed (ADR-0003).
    expect(new Set(schema.required)).toEqual(new Set(["title", "on", "steps"]));
    expect(schema.properties.on.additionalProperties.required).toEqual(["event"]);
    expect(schema.properties.steps.items.required).toEqual(["uses"]);

    const { description: _description, ...terse } = example();
    expect(problems(terse)).toEqual([]);
  });

  test("the smallest workflow anyone can write is a workflow", () => {
    // Exercise minimum lengths; this cannot guard against adding upper bounds.
    expect(problems({ title: "X", on: { a: { event: "x" } }, steps: [{ uses: "a.b" }] })).toEqual([]);
  });

  test("a title and a description are each one line with something on it", () => {
    // Omit an optional description instead of supplying an empty string.
    for (const line of ["", " ", " Review", "Review ", "Review\nrequest"]) {
      expect(problems({ ...example(), title: line })).not.toEqual([]);
      expect(problems({ ...example(), description: line })).not.toEqual([]);
    }
  });

  test("a $schema, if given, is this one", () => {
    expect(problems({ ...example(), $schema: "https://example.com/other.json" })).not.toEqual([]);
    const { $schema: _schema, ...bare } = example();
    expect(problems(bare)).toEqual([]);
  });

  test("a trigger source is a plugin name", () => {
    // Literal cases guard the grammar independently of the schema-derived pattern above.
    for (const source of ["GitHub", "git_hub", "github.com", "-github", "github-", "1github", ""]) {
      expect(problems({ ...example(), on: { [source]: { event: "a" } } })).not.toEqual([]);
    }
    expect(problems({ ...example(), on: { github2: { event: "a" } } })).toEqual([]);
  });

  test("a step names a capability as plugin.action", () => {
    // Literals for the same reason as the trigger sources above, on both halves.
    const bad = [
      "run",
      "Agent.run",
      "agent.review.run",
      "agent.run_now",
      "agent-.run",
      "agent.run-",
      "a--b.run",
      "1agent.run",
      "agent.1run",
    ];
    for (const uses of bad) {
      expect(problems({ ...example(), steps: [{ uses }] })).not.toEqual([]);
    }
    expect(problems({ ...example(), steps: [{ uses: "github.submit-review", with: {} }] })).toEqual([]);
    expect(problems({ ...example(), steps: [{ uses: "agent2.run-v2" }] })).toEqual([]);
  });
});
