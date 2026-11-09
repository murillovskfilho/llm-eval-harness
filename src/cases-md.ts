// Renders cases/cases.json as cases/CASES.md so a reviewer can read every input and what it expects.

import { readFileSync, writeFileSync } from "node:fs";
import type { Case } from "./grade.js";

const cases = JSON.parse(readFileSync("cases/cases.json", "utf8")) as Case[];
const fence = (s: string) => "`".repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)));
const show = (v: unknown) => (v === null || v === undefined ? "any" : String(v));

let md = `# Eval cases (${cases.length})\n\nGenerated from \`cases/cases.json\` by \`npm run cases\`. Customers and shipments: \`cases/customers.json\`.\n\n`;
md += `| id | tags | customer | covered | escalate | cites | must include | must not include |\n|---|---|---|---|---|---|---|---|\n`;
for (const c of cases) {
  const e = c.expect;
  md += `| ${c.id} | ${c.tags.join(", ")} | ${c.customer} | ${show(e.covered)} | ${show(e.escalate)} | ${(e.cite ?? []).join(" or ") || "-"} | ${(e.must_include ?? []).map((g) => g.join(" / ")).join("; ") || "-"} | ${(e.must_not_include ?? []).join("; ") || "-"} |\n`;
}
for (const c of cases) {
  const f = fence(c.question);
  md += `\n## ${c.id} · ${c.tags.join(", ")}\n\n${f}text\n${c.question}\n${f}\n\n**Reference:** ${c.reference}\n`;
}
writeFileSync("cases/CASES.md", md);
console.log(`wrote cases/CASES.md (${cases.length} cases)`);
