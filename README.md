# Yeti PM

An [MCP](https://modelcontextprotocol.io) server that guides product design work through mandatory phases, so an AI assistant like Claude can run a project from problem to verified scope.

It covers five phases, in order:

1. **discovery**: problem, users and goal
2. **definition**: requirements (MoSCoW) and user stories
3. **prioritization**: RICE scoring of ideas
4. **flows**: Mermaid flow diagrams
5. **verification**: all `must` requirements completed, then the project closes

A phase only advances when its requirements are met. `advance_phase` tells you what is missing.

## Tools

| Tool | What it does |
| --- | --- |
| `create_project` | Start a project in the discovery phase |
| `get_project` | Show phase, what is missing, and linked items |
| `advance_phase` | Move to the next phase, or list what is missing |
| `add_requirement` | Add a requirement with a MoSCoW priority |
| `list_requirements` | List requirements, filtered by priority, status or project |
| `set_requirement_status` | Mark a requirement `open` or `done` |
| `add_user_story` | Create a user story with acceptance criteria |
| `prioritize_rice` | Compute and sort RICE scores |
| `map_user_flow` | Generate a Mermaid flow diagram |

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

Early version (0.2.0). Phases are strict by design. Making them optional is planned but not implemented.

## License

MIT. See [LICENSE](LICENSE).
