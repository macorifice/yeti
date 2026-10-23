// Read-only HTML view of the design side of a project. It shows what Jira does not:
// phases, coverage of musts by stories, flow diagrams and RICE scores.

export type ReqView = {
  id: number;
  title: string;
  priority: "must" | "should" | "could" | "wont";
  done: boolean;
  covered: boolean;
};

export type ProjectView = {
  id: number;
  name: string;
  closed: boolean;
  phases: string[];
  currentIndex: number; // index into phases; phases.length when closed
  missing: string[];
  reqs: ReqView[];
  rice: { name: string; score: number }[];
  flows: string[];
};

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

// Flows are stored as fenced Mermaid blocks; the browser needs only the diagram text
const mermaidSource = (block: string) => block.replace(/^```mermaid\n?/, "").replace(/\n?```$/, "");

function projectSection(p: ProjectView): string {
  const phases = p.phases
    .map((name, i) => {
      const state = i < p.currentIndex ? "done" : i === p.currentIndex && !p.closed ? "current" : "todo";
      return `<li class="phase ${state}">${esc(name)}</li>`;
    })
    .join("");

  const musts = p.reqs.filter((r) => r.priority === "must");
  const mustRows = musts.length
    ? musts
        .map(
          (r) => `<tr><td>${esc(r.title)}</td><td>${r.done ? "Done" : "Open"}</td><td class="${r.covered ? "ok" : "warn"}">${r.covered ? "Covered" : "Not covered"}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No must requirements.</td></tr>`;

  const maxScore = Math.max(1, ...p.rice.map((r) => r.score));
  const riceBars = p.rice.length
    ? [...p.rice]
        .sort((a, b) => b.score - a.score)
        .map(
          (r) =>
            `<div class="bar"><span>${esc(r.name)}</span><div class="track"><div class="fill" style="width:${Math.round((r.score / maxScore) * 100)}%"></div></div><b>${r.score}</b></div>`,
        )
        .join("")
    : `<p class="muted">No RICE scores yet.</p>`;

  const flows = p.flows.length
    ? p.flows.map((f) => `<pre class="mermaid">${esc(mermaidSource(f))}</pre>`).join("")
    : `<p class="muted">No flows yet.</p>`;

  const missing = p.closed
    ? `<p class="ok">Project closed.</p>`
    : p.missing.length
      ? `<ul class="missing">${p.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`
      : `<p class="ok">Ready to move to the next phase.</p>`;

  return `
  <section class="project">
    <h2>${esc(p.name)}</h2>
    <h3>Phase</h3>
    <ol class="phases">${phases}</ol>
    <h3>What is missing</h3>
    ${missing}
    <h3>Musts and user stories</h3>
    <table><thead><tr><th>Requirement</th><th>Status</th><th>Story</th></tr></thead><tbody>${mustRows}</tbody></table>
    <h3>RICE</h3>
    ${riceBars}
    <h3>Flows</h3>
    ${flows}
  </section>`;
}

export function renderDashboard(projects: ProjectView[], generatedAt: string): string {
  const body = projects.map(projectSection).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Yeti dashboard</title>
<style>
:root { --bg:#ffffff; --fg:#1d1f23; --muted:#6b7280; --line:#e5e7eb; --ok:#15803d; --warn:#b45309; --accent:#2563eb; --code:#f4f5f7; }
@media (prefers-color-scheme: dark) { :root { --bg:#15171c; --fg:#e8eaf0; --muted:#9aa3b2; --line:#2a2e37; --ok:#4ade80; --warn:#fbbf24; --accent:#60a5fa; --code:#1d2028; } }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width:900px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:1.5rem; margin:0 0 4px; }
.sub { color:var(--muted); margin:0 0 24px; }
.project { border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:24px; }
.project h2 { margin:0 0 8px; font-size:1.25rem; }
.project h3 { font-size:.95rem; margin:18px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.phases { display:flex; flex-wrap:wrap; gap:6px; list-style:none; padding:0; margin:0; }
.phase { padding:4px 10px; border-radius:999px; border:1px solid var(--line); font-size:.85rem; }
.phase.done { background:var(--ok); color:#fff; border-color:var(--ok); }
.phase.current { border-color:var(--accent); color:var(--accent); font-weight:600; }
table { width:100%; border-collapse:collapse; font-size:.92rem; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
.ok { color:var(--ok); font-weight:600; }
.warn { color:var(--warn); font-weight:600; }
.muted { color:var(--muted); }
.missing { margin:0; padding-left:20px; }
.bar { display:grid; grid-template-columns:minmax(120px,30%) 1fr 48px; gap:10px; align-items:center; margin:6px 0; font-size:.9rem; }
.track { background:var(--line); border-radius:6px; height:10px; overflow:hidden; }
.fill { background:var(--accent); height:100%; }
.mermaid, pre.mermaid { background:var(--code); border-radius:8px; padding:12px; overflow-x:auto; font-size:.85rem; white-space:pre; }
</style>
</head>
<body>
<main>
  <h1>Yeti dashboard</h1>
  <p class="sub">Read-only view generated at ${esc(generatedAt)}. Execution happens in Jira.</p>
  ${body || `<p class="muted">No projects yet.</p>`}
</main>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: true, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
</script>
</body>
</html>
`;
}
