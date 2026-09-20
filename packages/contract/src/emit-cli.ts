import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtefact, strictPaths } from "./emit.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "contract.schema.json");
const artefact = buildArtefact();

// Refuse to write an artefact that would make the Swift side a strict reader (R1).
const strict = strictPaths(artefact);
if (strict.length > 0) {
  console.error(`refusing to emit: ${strict.length} strict object(s) — R1 violation`);
  for (const p of strict.slice(0, 10)) console.error(`  ${p}`);
  process.exit(1);
}

writeFileSync(out, `${JSON.stringify(artefact, null, 2)}\n`);
console.log(`wrote ${out}`);
