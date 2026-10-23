# Yeti

Available on npm as [`yeti-mcp`](https://www.npmjs.com/package/yeti-mcp).

An [MCP](https://modelcontextprotocol.io) server that guides product design work through mandatory phases, so an AI assistant like Claude can run a project from problem to verified scope.

It covers five phases, in order:

1. **discovery**: problem, users and goal
2. **definition**: requirements (MoSCoW) and user stories
3. **prioritization**: RICE scoring of ideas
4. **flows**: Mermaid flow diagrams
5. **verification**: every `must` requirement completed and covered by a user story, then the project closes

Projects have a mode, chosen at creation:

- **`strict`** (default): a phase advances only when its requirements are met. `advance_phase` tells you what is missing.
- **`free`**: phases advance regardless, and the response lists what was skipped.

## Tools

| Tool | What it does |
| --- | --- |
| `create_project` | Start a project in the discovery phase, in `strict` or `free` mode |
| `list_projects` | List projects with id, name, phase and mode; archived ones are hidden unless `includeArchived` is set |
| `update_project` | Change a project's name, problem, users or goal |
| `push_to_jira` | Create Jira issues for a project (Task per requirement, Story per user story). Dry-run by default; needs `JIRA_SITE`, `JIRA_EMAIL` and `JIRA_API_TOKEN`; `limit` sends a subset; `update` refreshes issues already linked; items already sent are skipped |
| `sync_from_jira` | Mark requirements and stories done when their Jira issue is done, and reopen them when it goes back. Items closed by hand in Yeti are not reopened. Read-only on Jira |
| `search_items` | Search requirements and stories by text, optionally within one project |
| `import_requirements` | Import requirements and user stories from CSV in the `export_backlog` format. Story-to-requirement links are not restored |
| `duplicate_project` | Copy a project's requirements and stories into a new project, as open items (a template) |
| `archive_project` | Hide a project from `list_projects` without deleting it |
| `set_project_mode` | Switch a project between `strict` and `free` |
| `project_summary` | Progress overview: requirements by priority and status, musts covered by stories, criteria done, RICE leader, Jira links, and what is missing to close |
| `get_project` | Show phase, what is missing, and linked items |
| `advance_phase` | Move to the next phase, or list what is missing |
| `add_requirement` | Add a requirement with a MoSCoW priority |
| `list_requirements` | List requirements, filtered by priority, status or project |
| `export_backlog` | Export a project backlog as Markdown or CSV; with `save`, also writes it to `data/exports/` |
| `update_requirement` | Change a requirement's title, description or priority |
| `delete_requirement` | Delete a requirement and unlink it from stories |
| `set_criterion_status` | Mark one acceptance criterion of a user story as done or not done |
| `list_stories` | List user stories with their ids, links, criteria state and Jira key |
| `delete_project` | Permanently delete a project and its items. Requires `confirm: true`; Jira issues are not touched |
| `delete_user_story` | Delete a user story |
| `set_requirement_status` | Mark a requirement `open` or `done` |
| `add_user_story` | Create a user story with acceptance criteria, optionally linked to requirements (`requirementIds`) |
| `prioritize_rice` | Compute and sort RICE scores |
| `map_user_flow` | Generate a Mermaid flow diagram, with Yes/No branches, `next` and `ends` |

Requirements, stories, RICE scores and flows accept an optional `projectId` to link them to a project.

## Requirements

- Node.js 18 or later

## Install

```bash
git clone https://github.com/macorifice/yeti.git
cd yeti
npm install
npm run build
```

## Connect to Claude Desktop

Add this to `claude_desktop_config.json`, using the absolute path to `dist/index.js` on your machine:

```json
{
  "mcpServers": {
    "yeti": {
      "command": "node",
      "args": ["/absolute/path/to/yeti/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after editing the file.

## Usage

Once connected, you work with Yeti by talking to Claude. A typical project looks like this.

**1. Create a project**

> Create a project "Quotes for craftsmen". Problem: writing quotes takes hours. Users: plumbers and painters. Goal: a quote in five minutes.

Yeti creates the project in the `discovery` phase.

**2. Move through the phases**

- **definition**: add at least one requirement and one user story linked to it.
- **prioritization**: score the ideas with RICE.
- **flows**: draw at least one flow diagram.
- **verification**: every `must` requirement is done and covered by a user story.

In `strict` mode (the default), Yeti will not advance until the phase is complete, and it tells you what is missing. In `free` mode, it advances and lists what it skipped. You can switch with `set_project_mode`.

**3. Work on the backlog**

- Edit or delete requirements and stories.
- Mark acceptance criteria as done.
- Search across a project.
- Duplicate a project to reuse it as a template.
- Import requirements from a CSV file.

**4. Export**

> Export the project backlog as Markdown and save it to a file.

With `save: true`, the file is written to `data/exports/` next to the database.

**Good to know**

- Data is stored locally, in `data/db.json`. The content still passes through the chat, so do not put sensitive data in it.
- RICE scores are the numbers you enter. Yeti sorts them; it does not estimate them.

## Credentials

Yeti works without any account. Only one tool talks to an external service:

- **Everything else** (projects, requirements, stories, RICE, flows, verification, export, search) runs locally and needs no credentials.
- **`push_to_jira`** creates issues in Jira. It needs three environment variables:

| Variable | Value |
| --- | --- |
| `JIRA_SITE` | Your Jira site, e.g. `https://your-team.atlassian.net` |
| `JIRA_EMAIL` | The email of your Atlassian account |
| `JIRA_API_TOKEN` | An API token created at [id.atlassian.com](https://id.atlassian.com) → Security → API tokens |

Set them in your shell profile, for example in `~/.zshrc`:

```bash
export JIRA_SITE="https://your-team.atlassian.net"
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="your-token-here"
```

Never put the token in the repository, in a config file you commit, or in a chat. If a token is exposed, revoke it in the same page and create a new one.

Without these variables, `push_to_jira` refuses to send and tells you which one is missing. Dry-run previews work without them as well.

## Data

Data is stored in `data/db.json` inside the project folder. To use another location, set the `PRODUCT_DESIGN_DB` environment variable:

```json
"env": { "PRODUCT_DESIGN_DB": "/absolute/path/to/db.json" }
```

## Test

```bash
npm test
```

The test starts the server on a temporary database and checks every tool and the phase flow.

## Status

Early version (0.2.0). Projects can run in `strict` or `free` mode.

## License

MIT. See [LICENSE](LICENSE).
