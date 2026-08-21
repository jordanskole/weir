/**
 * Regenerates the JSON Schema files editor tooling (VS Code's
 * redhat.vscode-yaml / yaml-language-server) validates `.field`/`.edge`
 * files against. Mechanical output of schema.ts — never hand-edit the
 * generated files, re-run this instead: `npm run generate:schemas`.
 */

import { writeFile } from "node:fs/promises";
import { edgeSchema, fieldSchema } from "../src/schema.js";

const targets: [string, object][] = [
  ["../../../examples/person-birthday/src/fields/field.schema.json", fieldSchema()],
  ["../../../examples/person-birthday/src/edges/edge.schema.json", edgeSchema()],
];

for (const [target, schema] of targets) {
  const path = new URL(target, import.meta.url);
  await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  console.log(`wrote ${path.pathname}`);
}
