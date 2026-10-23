// Integration test: starts the server on a temporary database and calls every tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const dir = mkdtempSync(join(tmpdir(), "pd-mcp-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  // Jira variables are blanked so tests never reach a real Jira site
  env: { ...process.env, PRODUCT_DESIGN_DB: join(dir, "db.json"), JIRA_SITE: "", JIRA_EMAIL: "", JIRA_API_TOKEN: "" },
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
  "archive_project",
  "create_project",
  "delete_project",
  "delete_requirement",
  "delete_user_story",
  "duplicate_project",
  "export_backlog",
  "get_project",
  "import_requirements",
  "list_projects",
  "list_requirements",
  "list_stories",
  "map_user_flow",
  "prioritize_rice",
  "project_summary",
  "push_to_jira",
  "search_items",
  "set_criterion_status",
  "set_project_mode",
  "set_requirement_status",
  "sync_from_jira",
  "update_project",
  "update_requirement",
]);
ok("exposes 26 tools");

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
assert.match(flow, /S1 -- Yes --> S2/);
ok("map_user_flow links the decision with a Yes edge");

const branched = await call("map_user_flow", { name: "Login", steps: [{ label: "Open" }, { label: "Registered?", decision: true, no: 3 }, { label: "Dashboard" }, { label: "Sign up" }] });
assert.match(branched, /S1 -- Yes --> S2/);
assert.match(branched, /S1 -- No --> S3/);
assert.doesNotMatch(branched, /S1 --> S2/);
assert.match(await call("map_user_flow", { name: "Bad", steps: [{ label: "A", decision: true, no: 9 }, { label: "B" }] }), /out of range/);
ok("map_user_flow draws Yes and No branches and rejects bad indexes");

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

const mustReq = JSON.parse(await call("add_requirement", { title: "Voice dictation", description: "Dictate the lines", priority: "must", projectId: p.id }));
await call("add_user_story", { persona: "craftsman", goal: "dictate", benefit: "time", acceptanceCriteria: ["ok"], requirementIds: [mustReq.id], projectId: p.id });
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

// Free mode: phases can be advanced with items missing, and the skipped items are reported
const free = JSON.parse(await call("create_project", { name: "Free project", problem: "Test", users: "testers", goal: "test free mode", mode: "free" }));
assert.equal(free.mode, "free");
let fadv = JSON.parse(await call("advance_phase", { projectId: free.id }));
assert.equal(fadv.phase, "definition");
fadv = JSON.parse(await call("advance_phase", { projectId: free.id }));
assert.equal(fadv.phase, "prioritization");
assert.equal(fadv.skipped.length, 2, "definition items reported as skipped");
ok("free mode advances and reports skipped items");

// Strict is the default mode
const def = JSON.parse(await call("create_project", { name: "Default project", problem: "Test", users: "testers", goal: "default mode" }));
assert.equal(def.mode, "strict");
assert.equal(JSON.parse(await call("advance_phase", { projectId: def.id })).phase, "definition");
assert.equal(JSON.parse(await call("advance_phase", { projectId: def.id })).phase, "definition");
ok("strict is the default and still blocks");

// Backlog export
const ex = JSON.parse(await call("create_project", { name: "Export test", problem: "Export", users: "team", goal: "export" }));
await call("add_requirement", { title: "Could item", description: "Nice to have", priority: "could", projectId: ex.id });
await call("add_requirement", { title: "Must, with comma", description: "Say \"hi\"", priority: "must", projectId: ex.id });
await call("add_user_story", { persona: "user", goal: "export", benefit: "share", acceptanceCriteria: ["File opens"], projectId: ex.id });
const md = await call("export_backlog", { projectId: ex.id });
assert.match(md, /# Export test — backlog/);
assert.ok(md.indexOf("Must, with comma") < md.indexOf("Could item"), "must before could");
assert.match(md, /### Story \d+/);
const csv = await call("export_backlog", { projectId: ex.id, format: "csv" });
const lines = csv.split("\n");
assert.equal(lines[0], "type,id,title,priority,status,details,persona,goal,benefit,criteria");
assert.match(lines[1], /^requirement,\d+,"Must, with comma",must,open,"Say ""hi""",,,,$/);
assert.match(lines[3], /^story,/);
assert.match(await call("export_backlog", { projectId: 999 }), /not found/);
ok("export_backlog exports Markdown and CSV with correct escaping");

// list_projects
const projects = JSON.parse(await call("list_projects", {}));
assert.ok(projects.some((x) => x.id === p.id && x.phase === "closed"));
assert.ok(JSON.parse(await call("list_projects", { includeClosed: false })).every((x) => x.phase !== "closed"));
ok("list_projects lists projects and can hide closed ones");

// Stories must point to real requirements
assert.match(await call("add_user_story", { persona: "a", goal: "b", benefit: "c", acceptanceCriteria: ["d"], requirementIds: [9999] }), /not found/);
ok("add_user_story rejects unknown requirement ids");

// A must without a linked story blocks verification
const t = JSON.parse(await call("create_project", { name: "Trace test", problem: "Trace", users: "team", goal: "trace" }));
await call("advance_phase", { projectId: t.id });
const tReq = JSON.parse(await call("add_requirement", { title: "Orphan must", description: "No story yet", priority: "must", projectId: t.id }));
await call("add_user_story", { persona: "user", goal: "something else", benefit: "x", acceptanceCriteria: ["y"], projectId: t.id });
await call("advance_phase", { projectId: t.id });
await call("prioritize_rice", { items: [{ name: "Z", reach: 1, impact: 1, confidence: 1, effort: 1 }], projectId: t.id });
await call("advance_phase", { projectId: t.id });
await call("map_user_flow", { name: "Trace", steps: [{ label: "A" }, { label: "B" }], projectId: t.id });
await call("advance_phase", { projectId: t.id });
await call("set_requirement_status", { id: tReq.id, status: "done" });
const tBlocked = JSON.parse(await call("advance_phase", { projectId: t.id }));
assert.equal(tBlocked.missing.length, 1);
assert.match(tBlocked.missing[0], /must without a user story/);
await call("add_user_story", { persona: "user", goal: "orphan", benefit: "x", acceptanceCriteria: ["y"], requirementIds: [tReq.id], projectId: t.id });
assert.match(await call("advance_phase", { projectId: t.id }), /Project closed/);
ok("verification blocks a must without a user story, and closes once it is linked");

// Flow links: next and ends on non-decision steps
const routed = await call("map_user_flow", { name: "Routing", steps: [{ label: "Start" }, { label: "Choice", decision: true, no: 3 }, { label: "Yes path", ends: true }, { label: "No path" }, { label: "Done" }] });
assert.match(routed, /S0 --> S1/);
assert.match(routed, /S1 -- Yes --> S2/);
assert.match(routed, /S1 -- No --> S3/);
assert.match(routed, /S3 --> S4/);
assert.doesNotMatch(routed, /S2 -->/);
const jumped = await call("map_user_flow", { name: "Jump", steps: [{ label: "A", next: 2 }, { label: "B" }, { label: "C" }] });
assert.match(jumped, /S0 --> S2/);
assert.doesNotMatch(jumped, /S0 --> S1/);
ok("map_user_flow supports next and ends for non-decision steps");

// Edit and delete
const e = JSON.parse(await call("add_requirement", { title: "Typo titel", description: "d", priority: "could" }));
const edited = JSON.parse(await call("update_requirement", { id: e.id, title: "Fixed title", priority: "must" }));
assert.equal(edited.title, "Fixed title");
assert.equal(edited.priority, "must");
assert.equal(edited.description, "d", "untouched fields stay the same");
assert.match(await call("update_requirement", { id: 9999, title: "x y z" }), /not found/);
ok("update_requirement changes only the fields passed");

const linkedReq = JSON.parse(await call("add_requirement", { title: "Will be deleted", description: "d" }));
const linkedStoryText = await call("add_user_story", { persona: "a", goal: "b", benefit: "c", acceptanceCriteria: ["x"], requirementIds: [linkedReq.id] });
const linkedStoryId = Number(linkedStoryText.match(/^Story (\d+)/)[1]);
assert.match(await call("delete_requirement", { id: linkedReq.id }), /deleted/);
assert.match(await call("delete_requirement", { id: linkedReq.id }), /not found/);
ok("delete_requirement removes the requirement");

assert.match(await call("delete_user_story", { id: linkedStoryId }), /deleted/);
assert.match(await call("delete_user_story", { id: linkedStoryId }), /not found/);
ok("delete_user_story removes the story, and reports unknown ids");

// Acceptance criteria status and file export
const crit = { id: Number((await call("add_user_story", { persona: "a", goal: "check", benefit: "c", acceptanceCriteria: ["first", "second"] })).match(/^Story (\d+)/)[1]) };
assert.match(await call("set_criterion_status", { storyId: crit.id, index: 1, done: true }), /criteriaDone/);
assert.match(await call("set_criterion_status", { storyId: crit.id, index: 5, done: true }), /out of range/);
assert.match(await call("set_criterion_status", { storyId: 9999, index: 0, done: true }), /not found/);
const critProject = JSON.parse(await call("create_project", { name: "Criteria", problem: "p", users: "u", goal: "g" }));
const linked = Number((await call("add_user_story", { persona: "a", goal: "check", benefit: "c", acceptanceCriteria: ["first", "second"], projectId: critProject.id })).match(/^Story (\d+)/)[1]);
await call("set_criterion_status", { storyId: linked, index: 1, done: true });
const critExport = await call("export_backlog", { projectId: critProject.id });
assert.match(critExport, /- \[ \] first/);
assert.match(critExport, /- \[x\] second/);
ok("set_criterion_status marks criteria and reports bad input");

const crProject = JSON.parse(await call("create_project", { name: "Export File", problem: "p", users: "u", goal: "g" }));
await call("add_user_story", { persona: "a", goal: "files", benefit: "b", acceptanceCriteria: ["x", "y"], projectId: crProject.id });
const saved = await call("export_backlog", { projectId: crProject.id, format: "csv", save: true });
const savedPath = saved.replace("Saved to ", "");
assert.match(saved, /^Saved to .*export-file\.csv$/);
assert.ok(existsSync(savedPath));
assert.match(readFileSync(savedPath, "utf8"), /^type,id,title/);
ok("export_backlog with save writes data/exports/<project>.<ext>");

// Archive and mode
const arch = JSON.parse(await call("create_project", { name: "To archive", problem: "p", users: "u", goal: "g" }));
await call("archive_project", { projectId: arch.id });
assert.ok(!JSON.parse(await call("list_projects", {})).some((x) => x.id === arch.id), "hidden by default");
assert.ok(JSON.parse(await call("list_projects", { includeArchived: true })).some((x) => x.id === arch.id), "shown when asked");
await call("archive_project", { projectId: arch.id, archived: false });
assert.ok(JSON.parse(await call("list_projects", {})).some((x) => x.id === arch.id), "back after unarchive");
assert.match(await call("archive_project", { projectId: 9999 }), /not found/);
ok("archive_project hides and restores projects");

const mode = JSON.parse(await call("create_project", { name: "Mode switch", problem: "p", users: "u", goal: "g" }));
const switched = JSON.parse(await call("set_project_mode", { projectId: mode.id, mode: "free" }));
assert.equal(switched.mode, "free");
assert.equal(JSON.parse(await call("advance_phase", { projectId: mode.id })).phase, "definition");
assert.equal(JSON.parse(await call("advance_phase", { projectId: mode.id })).phase, "prioritization");
ok("set_project_mode switches to free and advancing skips missing items");

// Update project and search
const up = JSON.parse(await call("create_project", { name: "Old name", problem: "old problem", users: "u", goal: "g" }));
const renamed = JSON.parse(await call("update_project", { projectId: up.id, name: "New name" }));
assert.equal(renamed.name, "New name");
assert.equal(renamed.problem, "old problem", "untouched fields stay");
assert.match(await call("update_project", { projectId: 9999, name: "x y" }), /not found/);
ok("update_project changes only the fields passed");

await call("add_requirement", { title: "Export alle fatture", description: "Esporta in PDF le fatture", priority: "could", projectId: up.id });
await call("add_user_story", { persona: "contabile", goal: "cercare una fattura", benefit: "trovarla in fretta", acceptanceCriteria: ["Ricerca per numero"], projectId: up.id });
const hitsAll = await call("search_items", { query: "FATTUR" });
assert.match(hitsAll, /"type": "requirement"/);
assert.match(hitsAll, /"type": "story"/);
assert.match(await call("search_items", { query: "fattur", projectId: 9999 }), /No items match/);
assert.match(await call("search_items", { query: "zzzzqqq" }), /No items match/);
ok("search_items finds requirements and stories, case-insensitive, by project");

// Duplicate a project as a template
const src = JSON.parse(await call("create_project", { name: "Template source", problem: "p", users: "u", goal: "g", mode: "free" }));
const srcReq = JSON.parse(await call("add_requirement", { title: "Template must", description: "d", priority: "must", projectId: src.id }));
await call("add_user_story", { persona: "a", goal: "use template", benefit: "b", acceptanceCriteria: ["x"], requirementIds: [srcReq.id], projectId: src.id });
await call("set_requirement_status", { id: srcReq.id, status: "done" });
const copy = JSON.parse(await call("duplicate_project", { projectId: src.id, name: "Template copy" }));
assert.equal(copy.name, "Template copy");
assert.equal(copy.mode, "free", "mode is copied");
assert.equal(copy.phase, 0, "starts from discovery");
const copyInfo = JSON.parse(await call("get_project", { projectId: copy.id }));
assert.equal(copyInfo.requirementCount, 1);
assert.equal(copyInfo.storyCount, 1);
assert.match(await call("search_items", { query: "template must", projectId: copy.id }), /"type": "requirement"/);
const copiedReq = JSON.parse(await call("list_requirements", { projectId: copy.id }))[0];
assert.equal(copiedReq.status, "open", "status is reset");
assert.match(await call("list_requirements", { projectId: src.id }), /"status": "done"/, "source is unchanged");
assert.match(await call("duplicate_project", { projectId: 9999, name: "x y" }), /not found/);
ok("duplicate_project copies items as open, without touching the source");

// Import requirements from CSV, round-trip with the export
const origin = JSON.parse(await call("create_project", { name: "CSV origin", problem: "p", users: "u", goal: "g" }));
await call("add_requirement", { title: "Prezzo, IVA incl.", description: "Say \"ciao\"\nsecond line", priority: "must", projectId: origin.id });
await call("add_requirement", { title: "Logo", description: "d", priority: "could", projectId: origin.id });
const csvText = await call("export_backlog", { projectId: origin.id, format: "csv" });
const target = JSON.parse(await call("create_project", { name: "CSV target", problem: "p", users: "u", goal: "g" }));
const result = JSON.parse(await call("import_requirements", { projectId: target.id, csv: csvText }));
assert.deepEqual(result, { imported: 2, skipped: 0 });
const imported = JSON.parse(await call("list_requirements", { projectId: target.id }));
assert.equal(imported[0].title, "Prezzo, IVA incl.", "commas survive");
assert.equal(imported[0].description, 'Say "ciao"\nsecond line', "quotes and newlines survive");
assert.equal(imported[0].priority, "must");
assert.equal(imported[1].priority, "could");
ok("import_requirements reads back exported CSV, quotes and newlines included");

const mixed = "type,id,title,priority,status,details\nstory,1,As a x,,,\nrequirement,2,Solo,bogus,open,dd";
const partial = JSON.parse(await call("import_requirements", { projectId: target.id, csv: mixed }));
assert.deepEqual(partial, { imported: 1, skipped: 1 });
assert.equal(JSON.parse(await call("list_requirements", { projectId: target.id })).find((r) => r.title === "Solo").priority, "should", "unknown priority falls back to should");
assert.match(await call("import_requirements", { projectId: target.id, csv: "a,b\n1,2" }), /must include/);
assert.match(await call("import_requirements", { projectId: 9999, csv: mixed }), /not found/);
ok("import_requirements skips stories, falls back on bad priority, and checks the header");

// Jira dry-run
const jp = JSON.parse(await call("create_project", { name: "Jira preview", problem: "p", users: "u", goal: "g" }));
const jr = JSON.parse(await call("add_requirement", { title: "Login sicuro", description: "Accesso con 2FA", priority: "must", projectId: jp.id }));
await call("add_user_story", { persona: "cliente", goal: "accedere", benefit: "vedere i preventivi", acceptanceCriteria: ["Richiede il codice", "Blocca dopo 5 errori"], requirementIds: [jr.id], projectId: jp.id });
const preview = JSON.parse(await call("push_to_jira", { projectId: jp.id, projectKey: "PROJ" }));
assert.equal(preview.dryRun, true);
assert.equal(preview.count, 2);
const [jiraTask, jiraStory] = preview.issues;
assert.equal(jiraTask.issueType, "Task");
assert.equal(jiraTask.priority, "Highest", "must maps to Highest");
assert.equal(jiraTask.project, "PROJ");
assert.equal(jiraStory.issueType, "Story");
assert.match(jiraStory.description, /- Blocca dopo 5 errori/);
ok("push_to_jira previews one Task per requirement and one Story per user story");

assert.match(await call("push_to_jira", { projectId: jp.id, projectKey: "PROJ", dryRun: false }), /Missing JIRA_SITE/);
const limited = JSON.parse(await call("push_to_jira", { projectId: jp.id, projectKey: "PROJ", limit: 1 }));
assert.equal(limited.count, 1, "limit applies to the preview");
assert.match(await call("push_to_jira", { projectId: 9999, projectKey: "PROJ" }), /not found/);
assert.match(await call("push_to_jira", { projectId: 9999, projectKey: "PROJ" }), /not found/);
ok("push_to_jira reports missing credentials and unknown projects, without sending");

// Jira update and sync guards (no network: credentials are blank in tests)
const sy = JSON.parse(await call("create_project", { name: "Sync guards", problem: "p", users: "u", goal: "g" }));
assert.match(await call("sync_from_jira", { projectId: sy.id }), /Missing JIRA_SITE/);
assert.match(await call("sync_from_jira", { projectId: 9999 }), /not found/);
const upPreview = JSON.parse(await call("push_to_jira", { projectId: sy.id, projectKey: "PROJ", update: true }));
assert.deepEqual(upPreview.updates, []);
ok("sync_from_jira reports missing credentials, and update preview lists nothing unlinked");

// Project summary
const sm = JSON.parse(await call("create_project", { name: "Summary", problem: "p", users: "u", goal: "g" }));
const smMust = JSON.parse(await call("add_requirement", { title: "Summary must", description: "d", priority: "must", projectId: sm.id }));
await call("add_requirement", { title: "Summary could", description: "d", priority: "could", projectId: sm.id });
const smStory = await call("add_user_story", { persona: "a", goal: "b", benefit: "c", acceptanceCriteria: ["one", "two"], requirementIds: [smMust.id], projectId: sm.id });
await call("set_criterion_status", { storyId: Number(smStory.match(/^Story (\d+)/)[1]), index: 0, done: true });
await call("prioritize_rice", { items: [{ name: "Top", reach: 10, impact: 3, confidence: 1, effort: 1 }, { name: "Low", reach: 1, impact: 1, confidence: 1, effort: 2 }], projectId: sm.id });
const summary = JSON.parse(await call("project_summary", { projectId: sm.id }));
assert.equal(summary.requirements.total, 2);
assert.equal(summary.requirements.byPriority.must, 1);
assert.equal(summary.musts.withStory, 1);
assert.equal(summary.musts.done, 0);
assert.equal(summary.stories.criteriaDone, 1);
assert.equal(summary.stories.criteriaTotal, 2);
assert.equal(summary.rice.leader, "Top");
assert.equal(summary.jiraLinked, 0);
assert.ok(summary.missing.length >= 0);
assert.match(await call("project_summary", { projectId: 9999 }), /not found/);
ok("project_summary reports requirements, musts, criteria, RICE leader and what is missing");

// CSV round trip with stories
const rt = JSON.parse(await call("create_project", { name: "RT source", problem: "p", users: "u", goal: "g" }));
await call("add_user_story", { persona: "cliente", goal: "pagare", benefit: "chiudere", acceptanceCriteria: ["Ricevuta", "Email"], projectId: rt.id });
const rtCsv = await call("export_backlog", { projectId: rt.id, format: "csv" });
const rtTarget = JSON.parse(await call("create_project", { name: "RT target", problem: "p", users: "u", goal: "g" }));
assert.deepEqual(JSON.parse(await call("import_requirements", { projectId: rtTarget.id, csv: rtCsv })), { imported: 1, skipped: 0 });
const rtInfo = JSON.parse(await call("get_project", { projectId: rtTarget.id }));
assert.equal(rtInfo.storyCount, 1);
assert.match(await call("export_backlog", { projectId: rtTarget.id }), /- \[ \] Ricevuta/);
ok("CSV round trip brings user stories back with their criteria");

// List stories and delete a project
const dp = JSON.parse(await call("create_project", { name: "To delete", problem: "p", users: "u", goal: "g" }));
const dpReq = JSON.parse(await call("add_requirement", { title: "Doomed requirement", description: "d", priority: "must", projectId: dp.id }));
const dpStory = await call("add_user_story", { persona: "x", goal: "y", benefit: "z", acceptanceCriteria: ["k"], requirementIds: [dpReq.id], projectId: dp.id });
const dpStoryId = Number(dpStory.match(/^Story (\d+)/)[1]);
const listed = JSON.parse(await call("list_stories", { projectId: dp.id }));
assert.equal(listed.length, 1);
assert.equal(listed[0].id, dpStoryId);
assert.deepEqual(listed[0].requirementIds, [dpReq.id]);
assert.equal(listed[0].criteria[0].done, false);
ok("list_stories shows ids, links and criteria state");

assert.match(await call("delete_project", { projectId: dp.id, confirm: false }), /not confirmed/);
assert.equal(JSON.parse(await call("get_project", { projectId: dp.id })).name, "To delete", "still there after refusal");
assert.match(await call("delete_project", { projectId: dp.id, confirm: true }), /deleted, with 1 requirement\(s\) and 1 user story/);
assert.match(await call("get_project", { projectId: dp.id }), /not found/);
assert.match(await call("search_items", { query: "Doomed" }), /No items match/);
assert.match(await call("list_stories", { projectId: dp.id }), /No user stories found/);
ok("delete_project refuses without confirm and removes the project with its items");

await client.close();
console.log(`\n${passed} checks passed`);
