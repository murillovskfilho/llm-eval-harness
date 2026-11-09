// Proves the harness before any paid call, with no network:
//   oracle  - replies built from each case's expectations must pass ~100%
//   null    - empty replies must fail ~100%
//   replay with no recordings must land in errors.jsonl, never as a 0 score

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const OUT = ".selftest";
rmSync(OUT, { recursive: true, force: true });

function run(variant: string, env: Record<string, string>, extra: string[] = []) {
  execFileSync(process.execPath, ["--import", "tsx", "src/run.ts", "--variant", variant, "--out", OUT, ...extra], {
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  const rows = (f: string) => (existsSync(join(OUT, variant, f)) ? readFileSync(join(OUT, variant, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { results: rows("results.jsonl"), errors: rows("errors.jsonl") };
}

const failures: string[] = [];
const rate = (rows: { grade: { pass: number } }[]) => rows.reduce((s, r) => s + r.grade.pass, 0) / Math.max(rows.length, 1);

const oracle = run("oracle", { EVAL_MODE: "stub" }, ["--stub", "oracle"]);
const oracleFails = oracle.results.filter((r) => !r.grade.pass);
if (rate(oracle.results) !== 1) failures.push(`oracle should pass 100%, failed: ${oracleFails.map((r) => `${r.prompt_id} (${r.explanation.pass})`).join(", ")}`);

const nul = run("null", { EVAL_MODE: "stub" }, ["--stub", "null"]);
if (rate(nul.results) !== 0) failures.push(`null replies should pass 0%, passed: ${nul.results.filter((r) => r.grade.pass).map((r) => r.prompt_id).join(", ")}`);

const missing = run("replay-empty", { EVAL_MODE: "replay", EVAL_CASSETTES: join(OUT, "no-cassettes") }, ["--only", "g01,g02"]);
if (missing.results.length !== 0 || missing.errors.length !== 2 || missing.errors.some((e) => e.class !== "missing_recording")) {
  failures.push(`missing recordings should be 2 errors and 0 graded rows, got ${missing.results.length} rows and ${JSON.stringify(missing.errors)}`);
}

rmSync(OUT, { recursive: true, force: true });
if (failures.length) {
  console.error("\nSELFTEST FAILED\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("\nSELFTEST OK: oracle 100%, null 0%, missing recordings reported as errors");
