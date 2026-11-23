// The note model without the network: the one request it makes, the JSON taken
// out of a reasoning model's reply, and the one retry. Fake fetch, fake clock of
// replies: nothing here waits and nothing here is real.

import assert from "node:assert/strict";
import { test } from "node:test";
import { completeJson, extractJson, openaiCompatible, OutputTruncated, type Llm, type LlmRequest } from "../src/llm.ts";
import type { FetchLike } from "../src/github.ts";
import { FakeLlm } from "./fakes.ts";

const REQ: LlmRequest = { system: "be a scribe", user: "the dictation", maxTokens: 100, timeoutMs: 1000 };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(reply: unknown, status = 200): { calls: Call[]; fetchFn: FetchLike } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
  };
  return { calls, fetchFn };
}

const chat = (content: string, finish = "stop"): unknown => ({ choices: [{ message: { content }, finish_reason: finish }] });

test("one chat completion: the gateway's URL, a bearer key, both messages, no sampling", async () => {
  const { calls, fetchFn } = fakeFetch(chat("hi"));
  const llm = openaiCompatible({ baseUrl: "https://nai.example.com/enterpriseai/gateway/v1/", apiKey: "k-1", model: "zy-pi-uep", fetchFn });

  assert.equal(await llm.complete(REQ), "hi");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://nai.example.com/enterpriseai/gateway/v1/chat/completions", "a trailing slash is not doubled");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer k-1", "content-type": "application/json" });
  assert.ok(calls[0].init.signal instanceof AbortSignal, "every call carries a timeout");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    model: "zy-pi-uep",
    messages: [
      { role: "system", content: "be a scribe" },
      { role: "user", content: "the dictation" },
    ],
    max_tokens: 100,
    temperature: 0,
  });
});

test("a refused or empty completion is a throw that names the status", async () => {
  const refused = openaiCompatible({ baseUrl: "https://gw/v1", apiKey: "k", model: "m", fetchFn: fakeFetch({ error: "nope" }, 504).fetchFn });
  await assert.rejects(refused.complete(REQ), /LLM 504: .*nope/);

  const empty = openaiCompatible({ baseUrl: "https://gw/v1", apiKey: "k", model: "m", fetchFn: fakeFetch({ choices: [] }).fetchFn });
  await assert.rejects(empty.complete(REQ), /no message content/);
});

test("the JSON object is taken out of fences, a think block and the prose around it", () => {
  const note = { topic: "Acme sizing" };
  const validate = (value: unknown): { topic: string } => {
    const topic = (value as { topic?: unknown }).topic;
    if (typeof topic !== "string") throw new Error("no topic");
    return { topic };
  };

  assert.deepEqual(extractJson('```json\n{"topic":"Acme sizing"}\n```', validate), note);
  assert.deepEqual(extractJson('<think>The user said Acme. Let me weigh it up.</think>\n{"topic":"Acme sizing"}', validate), note);
  assert.deepEqual(extractJson('Here it is:\n```\n{"topic":"Acme sizing"}\n```\nDone.', validate), note);
  assert.deepEqual(extractJson('{"topic":"Acme sizing","actions":[{"owner":"ZY"}]}', validate), note, "the outermost object is the one taken");
});

test("a reply with no usable JSON is a throw, and so is a validator's own", () => {
  const validate = (value: unknown): unknown => {
    if (typeof (value as { topic?: unknown }).topic !== "string") throw new Error("the note is not valid: no topic");
    return value;
  };
  assert.throws(() => extractJson("I could not do that.", validate), /no JSON object/);
  assert.throws(() => extractJson("{topic: Acme sizing}", validate), /not valid JSON/);
  assert.throws(() => extractJson('{"date":"2026-11-25"}', validate), /the note is not valid: no topic/);
});

test("a reply that cannot be used is asked for again, with the reason in the follow-up", async () => {
  const llm = new FakeLlm();
  llm.replies.push("Sure! Here is your note: {not json}", '{"topic":"Acme sizing"}');
  const validate = (value: unknown): { topic: string } => {
    const topic = (value as { topic?: unknown }).topic;
    if (typeof topic !== "string") throw new Error("the note is not valid: topic must be a string");
    return { topic };
  };

  assert.deepEqual(await completeJson(llm, REQ, validate), { topic: "Acme sizing" });
  assert.equal(llm.requests.length, 2);
  assert.equal(llm.requests[0].user, "the dictation");
  assert.match(llm.requests[1].user, /^the dictation\n\nYour previous reply could not be used: the reply is not valid JSON/);
  assert.match(llm.requests[1].user, /Reply with only the JSON object/);
});

test("a second unusable reply throws: one retry, no more", async () => {
  const llm = new FakeLlm();
  llm.replies.push("no", "still no");
  await assert.rejects(completeJson(llm, REQ, () => ({})), /no JSON object/);
  assert.equal(llm.requests.length, 2);
});

test("a model that cannot be reached at all is asked exactly once", async () => {
  const llm = new FakeLlm();
  llm.down = new Error("LLM 502: bad gateway");
  await assert.rejects(completeJson(llm, REQ, () => ({})), /LLM 502/);
  assert.equal(llm.requests.length, 1, "a connection failure is not a parse failure");
});

test("a reply cut off at max_tokens is an explicit error, not a half-parsed note", async () => {
  const llm = openaiCompatible({ baseUrl: "https://gw/v1", apiKey: "k", model: "m", fetchFn: fakeFetch(chat('{"topic":"Acme', "length")).fetchFn });
  await assert.rejects(llm.complete(REQ), (err: unknown) => {
    assert.ok(err instanceof OutputTruncated);
    assert.match(err.message, /output truncated/);
    return true;
  });
});

test("a truncated reply is the one retry, and the retry says why", async () => {
  const requests: LlmRequest[] = [];
  const llm: Llm = {
    async complete(req) {
      requests.push(req);
      if (requests.length === 1) throw new OutputTruncated("LLM: output truncated at max_tokens");
      return '{"topic":"Acme sizing"}';
    },
  };
  const validate = (value: unknown): { topic: string } => ({ topic: (value as { topic: string }).topic });

  assert.deepEqual(await completeJson(llm, REQ, validate), { topic: "Acme sizing" });
  assert.equal(requests.length, 2);
  assert.match(requests[1].user, /could not be used: LLM: output truncated at max_tokens/);
});

test("a reply that reasons in two blocks is read after the LAST closing think tag", () => {
  const validate = (value: unknown): unknown => value;
  // The model reasons, drafts something with braces in it, reasons again, and
  // only then answers: the answer is what follows the last closing tag.
  const reply = '<think>first thought</think>\nDraft: {"topic":"draft"}\n<think>second thought</think>\n{"topic":"Acme"}';
  assert.deepEqual(extractJson(reply, validate), { topic: "Acme" });
});

test("a think tag that never closes is a reasoning that did not finish", () => {
  assert.throws(() => extractJson('<think>Acme, ten nodes, and then I was cut', (value) => value), /reasoning did not finish/);
});
