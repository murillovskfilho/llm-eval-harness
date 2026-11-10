// Runs the delivery assistant over every case, grades it and writes one row per (case, rep).
//
//   npx tsx src/run.ts --variant baseline --model claude-haiku-5-5
//   npx tsx src/run.ts --variant v1 --model claude-sonnet-5-5
//   EVAL_MODE=stub npx tsx src/run.ts --variant oracle --stub oracle   (wiring check, no network)
//
// Layout (what the report builder reads):
//   evals/logistics-support/<variant>/results.jsonl   one row per graded (case, rep), written as it finishes
//   evals/logistics-support/<variant>/traces/          full transcript per (case, rep)
//   evals/logistics-support/<variant>/errors.jsonl     attempts that never produced a gradable reply

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildUserMessage, ReplySchema, SYSTEM_PROMPT, type Customer, type Reply } from "./app/assistant.js";
import { judge, JUDGE_MODEL, runChecks, type Case } from "./grade.js";
import { BACKEND, callModel, MissingCassette, MODE } from "./llm.js";

const { values: args } = parseArgs({
  options: {
    variant: { type: "string", default: "baseline" },
    model: { type: "string", default: "claude-haiku-5-5" },
    reps: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    "timeout-s": { type: "string", default: "120" },
    only: { type: "string" },
    stub: { type: "string" }, // oracle | null (only with EVAL_MODE=stub)
    record: { type: "boolean" }, // read by llm.ts: same as EVAL_MODE=record
    out: { type: "string", default: "evals/logistics-support" },
  },
});

const FLOW = args.out!;
const DIR = join(FLOW, args.variant!);
const REPS = Number(args.reps);
const TIMEOUT_MS = Number(args["timeout-s"]) * 1000;
const POLICY = readFileSync(new URL("./app/policy.md", import.meta.url), "utf8");
const customers = JSON.parse(readFileSync("cases/customers.json", "utf8")) as Record<string, Customer>;
let cases = JSON.parse(readFileSync("cases/cases.json", "utf8")) as Case[];
if (args.only) cases = cases.filter((c) => args.only!.split(",").includes(c.id));

mkdirSync(join(DIR, "traces"), { recursive: true });
const resultsPath = join(DIR, "results.jsonl");
const done = new Set(
  existsSync(resultsPath)
    ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.prompt_id}#${r.rep}`; })
    : [],
);

function stubReply(c: Case): Reply | string {
  if (args.stub === "null") return { answer: "", cited_sections: [], covered_by_policy: false, escalate: false };
  const facts = (c.expect.must_include ?? []).map((alts) => alts[0]).join(" ");
  return {
    answer: `${c.reference} ${facts}`.trim(),
    cited_sections: c.expect.cite ?? [],
    covered_by_policy: c.expect.covered ?? true,
    escalate: c.expect.escalate ?? false,
  };
}

// Hard wall-clock ceiling per case. The timer is cleared so a finished run can exit right away.
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new TimeoutError(`case exceeded ${ms / 1000}s`)), ms); });
  try {
    return await Promise.race([p, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}
class TimeoutError extends Error {}

async function runOne(c: Case, rep: number) {
  const customer = customers[c.customer];
  const user = buildUserMessage(customer, c.question);
  const sut = await callModel({ model: args.model!, system: SYSTEM_PROMPT, user, schema: ReplySchema, effort: "medium", stub: () => stubReply(c) });

  if (MODE !== "stub" && !sut.model.startsWith(args.model!)) {
    throw new Error(`served model ${sut.model} differs from requested ${args.model}`);
  }
  if (sut.stop_reason === "max_tokens") return { status: "truncated" as const, sut };

  const checks = runChecks(sut.parsed, c.expect);
  const verdict = await judge(POLICY, JSON.stringify(customer, null, 2), c, sut.parsed);
  const v = verdict.parsed;
  const judged = v !== null;

  const contract = checks.schema && checks.covered && checks.escalate && checks.cites;
  const pass = contract && checks.facts && checks.safe && checks.language && judged && v.faithful && v.correct;

  return {
    status: "ok" as const,
    sut,
    row: {
      prompt_id: c.id,
      prompt: c.question,
      tags: c.tags,
      rep,
      status: "ok",
      stop_reason: sut.stop_reason,
      grade: {
        pass: pass ? 1 : 0,
        faithful: judged && v.faithful ? 1 : 0,
        correct: judged && v.correct ? 1 : 0,
        safe: checks.safe ? 1 : 0,
        contract: contract ? 1 : 0,
        language: checks.language ? 1 : 0,
      },
      explanation: {
        pass: checks.failures.length ? checks.failures.join("; ") : "all deterministic checks passed",
        faithful: v?.explanation ?? "judge output did not parse",
        correct: v?.explanation ?? "judge output did not parse",
      },
      model: sut.model,
      usage: sut.usage,
      judge_model: verdict.model,
      judge_usage: verdict.usage,
      latency_s: Number(sut.latency_s.toFixed(2)),
      meta: { source: sut.source, reply: sut.parsed },
    },
    trace: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
      { role: "assistant", content: sut.parsed ? JSON.stringify(sut.parsed, null, 2) : sut.text },
    ],
  };
}

async function main() {
  const jobs = cases.flatMap((c) => Array.from({ length: REPS }, (_, rep) => ({ c, rep }))).filter(({ c, rep }) => !done.has(`${c.id}#${rep}`));
  console.log(`${args.variant}: ${jobs.length} attempts (${cases.length} cases × ${REPS} reps, ${done.size} already done), model ${args.model}, judge ${JUDGE_MODEL}, mode ${MODE}${MODE === "record" || MODE === "live" ? ` via ${BACKEND}` : ""}`);

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { c, rep } = jobs[next++];
      try {
        const r = await withTimeout(runOne(c, rep), TIMEOUT_MS);
        if (r.status === "truncated") {
          appendFileSync(resultsPath, JSON.stringify({ prompt_id: c.id, prompt: c.question, tags: c.tags, rep, status: "truncated", stop_reason: "max_tokens", grade: {}, model: r.sut.model, usage: r.sut.usage }) + "\n");
          continue;
        }
        writeFileSync(join(DIR, "traces", `${c.id}_rep${rep}.json`), JSON.stringify(r.trace, null, 2));
        appendFileSync(resultsPath, JSON.stringify(r.row) + "\n");
        process.stdout.write(r.row.grade.pass ? "." : "F");
      } catch (err) {
        const cls = err instanceof TimeoutError ? "timeout" : err instanceof MissingCassette ? "missing_recording" : "harness_or_api";
        appendFileSync(join(DIR, "errors.jsonl"), JSON.stringify({ prompt_id: c.id, rep, class: cls, message: String(err) }) + "\n");
        process.stdout.write("E");
      }
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));

  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const rows = lines(resultsPath).filter((r) => r.status === "ok");
  const errors = lines(join(DIR, "errors.jsonl")).length;
  const n = rows.length;
  if (!n) {
    console.log(`\n${args.variant}: nothing graded (${errors} errors in errors.jsonl)`);
    return;
  }
  const p = rows.reduce((s, r) => s + r.grade.pass, 0) / n;
  const half = 1.96 * Math.sqrt((p * (1 - p)) / n);
  console.log(`\n${args.variant}: pass ${(p * 100).toFixed(1)}% ± ${(half * 100).toFixed(1)} (n=${n}, ${errors} errors not scored)`);
}

main();
