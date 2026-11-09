// One place where the harness talks to Claude, with record/replay so CI is free and deterministic.
//
// EVAL_MODE
//   replay (default) read the response from cassettes/; fail if it is missing
//   record           call the API and save the response to cassettes/
//   live             call the API, save nothing
//   stub             no network at all: answers come from a function the caller supplies
//                    (used to prove the runner and graders work: oracle and null runs)

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";

export type Mode = "replay" | "record" | "live" | "stub";
export const MODE = (process.env.EVAL_MODE ?? "replay") as Mode;
const CASSETTES = process.env.EVAL_CASSETTES ?? "cassettes";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface CallResult<T> {
  parsed: T | null;
  text: string;
  model: string;
  stop_reason: string | null;
  usage: Usage;
  latency_s: number;
  source: "api" | "cassette" | "stub";
}

export interface CallArgs<T> {
  model: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort: "low" | "medium" | "high";
  maxTokens?: number;
  stub?: () => T | string;
}

let client: Anthropic | null = null;
const api = () => (client ??= new Anthropic({ maxRetries: 4, timeout: 60_000 }));

function cassettePath(a: CallArgs<unknown>): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ model: a.model, system: a.system, user: a.user, effort: a.effort }))
    .digest("hex")
    .slice(0, 24);
  return join(CASSETTES, a.model, `${key}.json`);
}

export async function callModel<T>(a: CallArgs<T>): Promise<CallResult<T>> {
  const zero: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  if (MODE === "stub") {
    if (!a.stub) throw new Error("stub mode needs a stub answer");
    const out = a.stub();
    const text = typeof out === "string" ? out : JSON.stringify(out);
    const check = a.schema.safeParse(typeof out === "string" ? safeJson(out) : out);
    return { parsed: check.success ? check.data : null, text, model: a.model, stop_reason: "end_turn", usage: zero, latency_s: 0, source: "stub" };
  }

  const path = cassettePath(a as CallArgs<unknown>);
  if (MODE === "replay") {
    if (!existsSync(path)) throw new MissingCassette(`no recording for this call (${path}); run with EVAL_MODE=record`);
    const saved = JSON.parse(readFileSync(path, "utf8")) as CallResult<unknown>;
    const check = a.schema.safeParse(saved.parsed);
    return { ...saved, parsed: check.success ? check.data : null, source: "cassette" } as CallResult<T>;
  }

  const started = performance.now();
  const response = await api().messages.parse({
    model: a.model,
    max_tokens: a.maxTokens ?? 4000,
    system: a.system,
    messages: [{ role: "user", content: a.user }],
    output_config: { effort: a.effort, format: zodOutputFormat(a.schema) },
  });
  const latency_s = (performance.now() - started) / 1000;

  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const u = response.usage;
  const result: CallResult<T> = {
    parsed: (response.parsed_output as T | null) ?? null,
    text,
    model: response.model,
    stop_reason: response.stop_reason,
    usage: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    },
    latency_s,
    source: "api",
  };

  if (MODE === "record") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result, null, 2));
  }
  return result;
}

export class MissingCassette extends Error {}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
