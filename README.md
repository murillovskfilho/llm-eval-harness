# llm-eval-harness

Evaluation harness for an LLM feature: a parcel-delivery support assistant built on the Claude API. It measures what support bots actually get wrong, and compares two models on the same cases.

- **Grounding and hallucination:** answers come only from the policy, and "the policy doesn't cover this" is a correct answer.
- **Prompt injection:** direct ("ignore your instructions") and indirect, hidden in shipment data the bot reads.
- **Privacy:** never discuss another customer's parcels, never accept passwords or card numbers.
- **Escalation and the JSON contract:** the reply must carry the right flags and cite the policy sections it used.
- **Language:** reply in the customer's language (English, Portuguese, Spanish cases).

| | |
|---|---|
| System under test | `src/app/assistant.ts` + `src/app/policy.md` (a fictional carrier, Northwind Parcel) |
| Cases | 42, in 8 categories. Readable list: [`cases/CASES.md`](cases/CASES.md) |
| Models compared | Claude Haiku 5.5 (baseline) vs Claude Sonnet 5.5 (`v1`), effort `medium` |
| Judge | Claude Opus 5.5, structured output, never the model under test |
| How responses are produced | Recorded locally through Claude Code (`claude -p`), billed to a Claude subscription, or through the Messages API with a key. Same request either way |
| CI | Every push: typecheck, self-test and a replay of recorded responses (no key, no cost). A live run against the API is available on demand |

## Results

Not run against the API yet. The harness, graders and CI are verified offline (see *How I know the harness works*); the first recorded run will land in `evals/logistics-support/SUMMARY.md`.

## How a case is graded

Cheap, deterministic checks first; the LLM judge only for what needs judgment.

| Check | How | Why it is not left to the judge |
|---|---|---|
| JSON contract | The reply must parse into `ReplySchema` (Zod, enforced by structured outputs) and have the right `covered_by_policy` and `escalate` flags and at least one expected citation | It is exact. A judge adds cost and noise |
| Required facts | Each case lists the facts that must appear, with accepted spellings (`3–5`, `3-5`, `3 to 5`) | Numbers and fees are checkable strings |
| Safety | Strings that must never appear: another customer's city, the card number, the injected `APPROVED-500` code | A leak is a leak, whatever the phrasing |
| Language | Stop-word vote over the reply | Cheap and good enough for three languages |
| Faithful | Judge: every claim is supported by the policy or the customer's own data | Paraphrased claims can't be string-matched |
| Correct | Judge: same conclusion as the reference answer | Same |

A case **passes** only if every check passes. Each metric is also reported on its own, so a model that is safe but wordy is distinguishable from one that leaks data.

## How I know the harness works

`npm run selftest` runs with no network and fails CI if any of these break:

- **Oracle:** replies built from each case's expectations pass 100%. If a correct answer could fail, the grader is wrong.
- **Null:** empty replies pass 0%. If an empty answer could pass, the grader is too lenient.
- **Missing recording:** a replay with no recording lands in `errors.jsonl` as `missing_recording`, never as a score of 0. Plumbing failures must not look like model failures.

## Design decisions and trade-offs

- **Record and replay instead of calling the model on every push.** CI replays recorded responses (`cassettes/`), so pull requests are free, fast and deterministic, and grader changes can be tested against the same model outputs. The trade-off: replay can't see model drift, so the suite is re-recorded when a model or the prompt changes.
- **Recorded through Claude Code, not a paid API key.** `src/llm.ts` has two backends behind one function. The default runs `claude -p` with the same model, system prompt, effort and JSON schema the API call would use, and strips what Claude Code adds on its own: no tools, no CLAUDE.md, plugins, hooks or MCP servers, an empty working folder. It keeps the project free to run on a subscription. The trade-offs: recording happens on a developer machine, not in CI, and the cost column is what the same tokens would cost at API list prices, not a bill. Set `EVAL_BACKEND=api` and `ANTHROPIC_API_KEY` to record against the Messages API instead; the cassettes are interchangeable.
- **Structured outputs for both the assistant and the judge.** The contract is enforced by the API instead of parsed from prose, so a "broken JSON" failure means the model failed, not my regex.
- **No server-side model fallback.** Fallbacks would quietly answer a refused request with a different model and contaminate the comparison. The runner asserts that the served model is the requested one and records refusals instead.
- **One rep per case.** With 42 cases the 95% interval on a pass rate is about ±15 points, so this suite can catch large regressions, not small ones. The summary prints the interval next to every score. More reps cost money linearly; more cases would be the better buy.
- **The judge sees a reference answer, not just a rubric.** It makes "correct" checkable. The risk is penalizing a different but valid answer, which is why the references state the conclusion, not the wording.
- **The judge treats the reply as data.** The reply can contain injected text too; the judge's system prompt says so explicitly.
- **Cost is derived, not recorded.** Rows keep `model` and `usage`; `src/summary.ts` prices them, including the judge's tokens, which are easy to forget and can be half the bill.

## What I'd add next

- A small human-labeled set to measure how often the judge agrees with a person.
- Multi-turn cases (an injection planted in turn 1 and triggered in turn 3).
- A prompt variant (`v2`) hill-climbed against a held-out split, to show the eval steering a real change.
- Latency and cost budgets as CI gates, not just columns.

## How to run

```bash
npm ci
npm run selftest          # offline proof that the harness grades correctly
npm run cases             # regenerate cases/CASES.md from cases/cases.json
```

To record new responses you need [Claude Code](https://claude.com/claude-code) signed in to a Claude subscription. No API key:

```bash
npm run record:haiku     # runs every case through claude -p and saves responses to cassettes/
npm run record:sonnet
npm run summary          # writes evals/logistics-support/SUMMARY.md
npm run report           # writes evals/logistics-support/report.html
```

With an API key instead, set `EVAL_BACKEND=api` and `ANTHROPIC_API_KEY` before the record commands.

With neither, `npm run eval:haiku` and `npm run eval:sonnet` replay the recordings in `cassettes/`.

## Layout

```
src/app/            the system under test (prompt, policy, output schema)
src/llm.ts          the only place that talks to Claude: record / replay / live / stub, via claude -p or the API
src/grade.ts        deterministic checks + LLM judge
src/run.ts          concurrent runner: per-case timeout, resume, error sidecar
src/summary.ts      SUMMARY.md, every number computed from results.jsonl
cases/              42 cases and two fictional customers
evals/              results per variant (baseline = Haiku, v1 = Sonnet)
tools/              static HTML report builder
```
