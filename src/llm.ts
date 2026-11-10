// One place where the harness talks to Claude, with record/replay so CI is free and deterministic.
//
// EVAL_MODE
//   replay (default) read the response from cassettes/; fail if it is missing
//   record           call the API and save the response to cassettes/
//   live             call the API, save nothing
//   stub             no network at all: answers come from a function the caller supplies
//                    (used to prove the runner and graders work: oracle and null runs)
//
// EVAL_BACKEND (only for record and live)
//   cli (default)    run `claude -p` from Claude Code, billed to a Claude subscription: no API key, no extra cost
//   api              call the Messages API with ANTHROPIC_API_KEY, billed per token
//
// Both backends send the same model, system prompt, user message, effort and JSON schema, and write
// the same cassette, so replay and CI don't care which one recorded a response.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export type Mode = "replay" | "record" | "live" | "stub";
// `--record` on the command line is a shortcut for EVAL_MODE=record that works the same in every shell.
export const MODE = (process.env.EVAL_MODE ?? (process.argv.includes("--record") ? "record" : "replay")) as Mode;
export type Backend = "cli" | "api";
export const BACKEND = (process.env.EVAL_BACKEND ?? "cli") as Backend;
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
  source: "api" | "cli" | "cassette" | "stub";
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

  const result = BACKEND === "cli" ? await callCli(a) : await callApi(a);

  if (MODE === "record") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result, null, 2));
  }
  return result;
}

async function callApi<T>(a: CallArgs<T>): Promise<CallResult<T>> {
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
  return result;
}

// Claude Code in print mode. The flags strip everything Claude Code would add on top of a plain call:
// --system-prompt replaces its own prompt, --tools "" removes every tool, --safe-mode skips CLAUDE.md,
// plugins, hooks and MCP servers, and the empty temp folder keeps the project out of its context.
// No --fallback-model, for the same reason the API path has none: a fallback would contaminate the comparison.
const CLI_CWD = join(tmpdir(), "llm-eval-harness-cli");

async function callCli<T>(a: CallArgs<T>): Promise<CallResult<T>> {
  mkdirSync(CLI_CWD, { recursive: true });
  const args = [
    "-p",
    "--model", a.model,
    "--system-prompt", a.system,
    "--json-schema", JSON.stringify(z.toJSONSchema(a.schema)),
    "--effort", a.effort,
    "--output-format", "json",
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  const started = performance.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: CLI_CWD, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude -p exited with ${code}: ${(err || out).slice(0, 500)}`))));
    child.stdin.end(a.user);
  });
  const latency_s = (performance.now() - started) / 1000;

  const r = JSON.parse(stdout) as CliResult;
  if (r.is_error || r.subtype !== "success") throw new Error(`claude -p failed: ${r.subtype} ${String(r.result ?? "").slice(0, 300)}`);

  // modelUsage is keyed by the model that actually served the call; the runner asserts it matches.
  const served = Object.keys(r.modelUsage ?? {});
  if (served.length !== 1) throw new Error(`expected one served model, got ${JSON.stringify(served)}`);
  const m = r.modelUsage[served[0]];
  const check = a.schema.safeParse(r.structured_output);

  return {
    parsed: check.success ? check.data : null,
    text: typeof r.result === "string" ? r.result : JSON.stringify(r.structured_output ?? null),
    model: served[0],
    // Structured output arrives through a tool call, so "tool_use" is the normal ending here.
    stop_reason: r.stop_reason === "tool_use" ? "end_turn" : r.stop_reason,
    usage: {
      input_tokens: m.inputTokens,
      output_tokens: m.outputTokens,
      cache_read_input_tokens: m.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: m.cacheCreationInputTokens ?? 0,
    },
    latency_s,
    source: "cli",
  };
}

interface CliResult {
  is_error: boolean;
  subtype: string;
  stop_reason: string | null;
  result?: string;
  structured_output?: unknown;
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
}

export class MissingCassette extends Error {}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
