// Integration test: starts the server on a temporary database and calls every tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "pd-mcp-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, PRODUCT_DESIGN_DB: join(dir, "db.json") },
});
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content[0].text;
};

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`ok - ${label}`);
};

const names = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(names, [
  "add_requirement",
  "add_user_story",
  "advance_phase",
  "create_project",
  "get_project",
  "list_requirements",
  "map_user_flow",
  "prioritize_rice",
  "set_requirement_status",
]);
ok("exposes 9 tools");

assert.equal(await call("list_requirements"), "No requirements found.");
ok("empty list at start");

const r1 = JSON.parse(await call("add_requirement", { title: "Voice dictation", description: "Dictate the quote aloud", priority: "must" }));
assert.equal(r1.id, 1);
assert.equal(r1.status, "open");
ok("add_requirement saves and assigns an id");

await call("add_requirement", { title: "Export PDF", description: "Export to PDF" });
const list = JSON.parse(await call("list_requirements"));
assert.equal(list[0].priority, "must", "must comes first");
assert.equal(list[1].priority, "should", "default priority is should");
ok("list_requirements sorts by priority");

const filtered = JSON.parse(await call("list_requirements", { priority: "must" }));
assert.equal(filtered.length, 1);
ok("filter by priority");

const done = JSON.parse(await call("set_requirement_status", { id: 1, status: "done" }));
assert.equal(done.status, "done");
assert.equal(await call("set_requirement_status", { id: 99, status: "done" }), "Requirement 99 not found.");
ok("set_requirement_status");

const story = await call("add_user_story", { persona: "craftsman", goal: "dictate the quote", benefit: "save time", acceptanceCriteria: ["Text is transcribed"] });
assert.match(story, /\*\*As a\*\* craftsman/);
assert.match(story, /- \[ \] Text is transcribed/);
ok("add_user_story");

const rice = JSON.parse(
  await call("prioritize_rice", {
    items: [
      { name: "A", reach: 100, impact: 2, confidence: 0.8, effort: 4 },
      { name: "B", reach: 500, impact: 0.5, confidence: 1, effort: 2 },
    ],
  }),
);
assert.deepEqual(rice.map((x) => x.name), ["B", "A"]);
assert.equal(rice[0].score, 125);
ok("prioritize_rice computes and sorts");

const flow = await call("map_user_flow", { name: "Login", steps: [{ label: "Open" }, { label: "Registered?", decision: true }, { label: "Dashboard" }] });
assert.match(flow, /S1\{Registered\?\}/);
assert.match(flow, /S1 --> S2/);
ok("map_user_flow");

// Mandatory project phases
const p = JSON.parse(await call("create_project", { name: "Quote app", problem: "Slow quotes", users: "craftsmen", goal: "quote in 5 minutes" }));
assert.equal(p.phase, "discovery");
ok("create_project starts in discovery");

let adv = JSON.parse(await call("advance_phase", { projectId: p.id }));
assert.equal(adv.phase, "definition");
ok("completed discovery advances");

const blocked = JSON.parse(await call("advance_phase", { projectId: p.id }));
assert.equal(blocked.phase, "definition");
assert.equal(blocked.missing.length, 2);
ok("definition blocked without requirements and stories");

await call("add_requirement", { title: "Voice dictation", description: "Dictate the lines", priority: "must", projectId: p.id });
await call("add_user_story", { persona: "craftsman", goal: "dictate", benefit: "time", acceptanceCriteria: ["ok"], projectId: p.id });
adv = JSON.parse(await call("advance_phase", { projectId: p.id }));
assert.equal(adv.phase, "prioritization");
ok("definition complete with linked items");

await call("prioritize_rice", { items: [{ name: "X", reach: 10, impact: 1, confidence: 1, effort: 1 }], projectId: p.id });
adv = JSON.parse(await call("advance_phase", { projectId: p.id }));
assert.equal(adv.phase, "flows");
ok("prioritization complete with saved RICE");

await call("map_user_flow", { name: "Quote", steps: [{ label: "A" }, { label: "B" }], projectId: p.id });
adv = JSON.parse(await call("advance_phase", { projectId: p.id }));
assert.equal(adv.phase, "verification");
ok("flows complete with saved diagram");

const v1 = JSON.parse(await call("advance_phase", { projectId: p.id }));
assert.equal(v1.missing.length, 1, "one must still open");
const reqId = JSON.parse(await call("list_requirements", { projectId: p.id }))[0].id;
await call("set_requirement_status", { id: reqId, status: "done" });
assert.match(await call("advance_phase", { projectId: p.id }), /Project closed/);
const info = JSON.parse(await call("get_project", { projectId: p.id }));
assert.equal(info.phase, "closed");
ok("verification blocks with open musts and closes when all are done");

await client.close();
console.log(`\n${passed} checks passed`);
