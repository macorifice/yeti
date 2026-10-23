// Dashboard test: seeds a project through MCP, then starts "yeti-mcp dashboard" and checks the page and API.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "yeti-dash-"));
const env = { ...process.env, PRODUCT_DESIGN_DB: join(dir, "yeti.sqlite"), JIRA_SITE: "https://example.atlassian.net/", JIRA_EMAIL: "", JIRA_API_TOKEN: "" };

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`ok - ${label}`);
};

// Seed data through the MCP server, the same way Claude would
const client = new Client({ name: "dash-seed", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env }));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
const p = JSON.parse(await call("create_project", { name: "<script>alert(1)</script> Shop", problem: "Checkout is slow", users: "buyers", goal: "pay in one minute" }));
await call("advance_phase", { projectId: p.id });
const must = JSON.parse(await call("add_requirement", { title: "Pay by card", description: "Card payment", priority: "must", projectId: p.id }));
await call("add_requirement", { title: "Uncovered must", description: "No story yet", priority: "must", projectId: p.id });
await call("add_requirement", { title: "Gift wrap", description: "Optional", priority: "could", projectId: p.id });
const storyId = Number((await call("add_user_story", { persona: "buyer", goal: "pay by card", benefit: "finish quickly", acceptanceCriteria: ["Card accepted", "Receipt sent"], requirementIds: [must.id], projectId: p.id })).match(/^Story (\d+)/)[1]);
await call("set_criterion_status", { storyId, index: 0, done: true });
await call("prioritize_rice", { items: [{ name: "Card", reach: 100, impact: 2, confidence: 1, effort: 2 }, { name: "Wrap", reach: 10, impact: 1, confidence: 0.5, effort: 1 }], projectId: p.id });
await call("map_user_flow", { name: "Checkout", steps: [{ label: "Cart" }, { label: "Pay" }], projectId: p.id });
await client.close();

// Start the dashboard on a free port
const proc = spawn("node", ["dist/index.js", "dashboard", "--port", "0"], { env, stdio: ["ignore", "pipe", "inherit"] });
const base = await new Promise((resolve, reject) => {
  let out = "";
  proc.stdout.on("data", (chunk) => {
    out += chunk;
    const m = out.match(/Yeti dashboard: (http:\/\/127\.0\.0\.1:\d+)/);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (code) => reject(new Error(`dashboard exited with ${code}`)));
});

try {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /<title>Yeti<\/title>/);
  ok("serves the page with a content security policy");

  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].phase, "definition");
  assert.deepEqual(
    { musts: list[0].counts.musts, covered: list[0].counts.mustsCovered, met: list[0].counts.criteriaDone, total: list[0].counts.criteriaTotal },
    { musts: 2, covered: 1, met: 1, total: 2 },
  );
  ok("project list carries phase and progress counts");

  const d = await (await fetch(`${base}/api/projects/${p.id}`)).json();
  assert.equal(d.name, "<script>alert(1)</script> Shop", "data is returned as is; the page renders it as text");
  assert.equal(d.requirements.find((r) => r.id === must.id).storyIds[0], storyId);
  assert.deepEqual(d.stories[0].criteria, [{ text: "Card accepted", done: true }, { text: "Receipt sent", done: false }]);
  assert.deepEqual(d.rice.map((r) => r.name), ["Card", "Wrap"]);
  assert.equal(d.flows[0].name, "Checkout");
  assert.match(d.flows[0].source, /^flowchart TD/);
  assert.equal(d.jiraSite, "https://example.atlassian.net");
  ok("project detail has stories, criteria, sorted RICE, flows and the Jira site");

  assert.equal((await fetch(`${base}/api/projects/9999`)).status, 404);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/projects`, { method: "POST" })).status, 405);
  ok("unknown routes are 404 and writes are refused");

  const port = new URL(base).port;
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/projects", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  ok("requests for another host name are refused");
} finally {
  proc.kill();
}

console.log(`\n${passed} dashboard checks passed`);
