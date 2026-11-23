// The note model: one OpenAI-compatible chat completion, and the JSON in its
// reply. The backend is Nutanix Enterprise AI, a gateway in front of a reasoning
// model, so: plain chat completions, never response_format and never tool
// calling (the gateway may not have them), and the JSON is parsed out of the
// text, which may arrive wrapped in a <think> block and code fences.

import { errMessage } from "./errors.ts";
import type { FetchLike } from "./github.ts";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

/** The one thing the scribe needs from a model. */
export interface Llm {
  complete(req: LlmRequest): Promise<string>;
}

export interface OpenAiCompatibleOptions {
  /** e.g. https://nai.example.com/enterpriseai/gateway/v1 (no trailing slash needed). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable so tests never touch the network. */
  fetchFn?: FetchLike;
}

interface ChatChoice {
  message?: { content?: string | null } | null;
  finish_reason?: string | null;
}

interface ChatResponse {
  choices?: Array<ChatChoice | null> | null;
}

/**
 * The model stopped at max_tokens: the JSON in its reply is cut in half. That is
 * an unusable answer, so it is the one thing a failed completion is asked again.
 */
export class OutputTruncated extends Error {}

export function openaiCompatible(options: OpenAiCompatibleOptions): Llm {
  const fetchFn = options.fetchFn ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    async complete(req: LlmRequest): Promise<string> {
      const res = await fetchFn(`${base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          max_tokens: req.maxTokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
      const parsed = JSON.parse(body) as ChatResponse;
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason === "length") throw new OutputTruncated("LLM: output truncated at max_tokens");
      const content = choice?.message?.content;
      if (typeof content !== "string" || content.trim() === "") throw new Error("LLM: the reply holds no message content");
      return content;
    },
  };
}

/**
 * The reply with the reasoning and the code fences taken out. Only the text after
 * the LAST closing think tag counts: a model that reasons in several blocks puts
 * its answer after the last one. A think tag that never closes means the reply
 * was cut off in the middle of the reasoning, so there is nothing to parse.
 */
function plain(text: string): string {
  const lower = text.toLowerCase();
  const close = lower.lastIndexOf("</think>");
  if (close !== -1) return text.slice(close + "</think>".length).replace(/```[a-z]*\n?/gi, "");
  if (lower.includes("<think>")) throw new Error("the reasoning did not finish: no closing </think> in the reply");
  return text.replace(/```[a-z]*\n?/gi, "");
}

/**
 * The one JSON object in a model's reply, parsed and validated. The outermost
 * braces are taken, so prose around the object does no harm; anything else is a
 * throw, and the caller decides whether to ask again.
 */
export function extractJson<T>(text: string, validate: (value: unknown) => T): T {
  const body = plain(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the reply holds no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new Error(`the reply is not valid JSON: ${errMessage(err)}`);
  }
  return validate(parsed);
}

/** The same request, once. A failed parse or validation is sent back with the reason. */
const RETRY_SUFFIX = "\n\nYour previous reply could not be used";

/**
 * A completion whose reply must be one validated JSON object: one attempt, then
 * one retry that hands the model the reason its reply was unusable. A reply cut
 * off at max_tokens is unusable too, so it takes the same retry; a gateway that
 * cannot be reached at all is not, and is not asked twice. A second failure throws.
 */
export async function completeJson<T>(llm: Llm, req: LlmRequest, validate: (value: unknown) => T): Promise<T> {
  const again = async (reason: string): Promise<T> => {
    const second = await llm.complete({
      ...req,
      user: `${req.user}${RETRY_SUFFIX}: ${reason}. Reply with only the JSON object, no prose and no code fences.`,
    });
    return extractJson(second, validate);
  };

  let first: string;
  try {
    first = await llm.complete(req);
  } catch (err) {
    if (err instanceof OutputTruncated) return again(errMessage(err));
    throw err;
  }
  try {
    return extractJson(first, validate);
  } catch (err) {
    return again(errMessage(err));
  }
}
