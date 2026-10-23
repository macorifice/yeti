// Keeps server.json (MCP Registry metadata) on the same version as package.json.
// Runs from the npm "version" script, so "npm version patch" updates both files.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));
server.version = pkg.version;
for (const p of server.packages) if (p.identifier === pkg.name) p.version = pkg.version;
writeFileSync("server.json", JSON.stringify(server, null, 2) + "\n");
console.log(`server.json -> ${pkg.version}`);
