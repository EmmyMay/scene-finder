import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTypeSafeJevScorer } from "../jev-client.js";
import type { FrameWindowScoreInput } from "../types.js";

let directory: string;
let input: FrameWindowScoreInput;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "sf-jev-retry-"));
  const filePath = path.join(directory, "frame.jpg");
  await fs.writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  input = { movieId: "movie", movieName: "test.mp4", query: "red", signal: new AbortController().signal,
    frames: [{ id: "frame_0", index: 0, timestampSeconds: 0, fileName: "frame.jpg", filePath }] };
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const success = () => new Response(JSON.stringify({ answers: { frame_0: { type: "noul", noul: .9 } } }));

it("retries transient responses with the same payload and reports recovery", async () => {
  const bodies: string[] = []; const notices: boolean[] = [];
  const scorer = createTypeSafeJevScorer({ apiKey: "test-secret", retryDelayMs: 0, fetchImpl: async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? new Response("busy", { status: 503 }) : bodies.length === 2
      ? new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }) : success();
  } });
  expect(await scorer.scoreFrameWindow({ ...input, onRetry: value => notices.push(value) })).toEqual({ frame_0: .9 });
  expect(bodies).toHaveLength(3); expect(new Set(bodies).size).toBe(1);
  expect(notices).toEqual([true, false, true, false]);
});

it.each([401, 403, 400, 422, 429])("does not blindly retry rejected requests or a long Retry-After (%s)", async status => {
  let calls = 0;
  const scorer = createTypeSafeJevScorer({ apiKey: "test-secret", retryDelayMs: 0, fetchImpl: async () => {
    calls++; return new Response("test-secret", { status, headers: status === 429 ? { "Retry-After": "120" } : {} });
  } });
  const error = await scorer.scoreFrameWindow(input).catch(error => error);
  expect(error.message).not.toContain("test-secret"); expect(calls).toBe(1);
});

it("bounds hung requests to three attempts, including a stalled response body", async () => {
  for (const bodyStalls of [false, true]) {
    let calls = 0;
    const scorer = createTypeSafeJevScorer({ apiKey: "test-secret", retryDelayMs: 0, requestTimeoutMs: 15,
      fetchImpl: async (_url, init) => {
        calls++;
        if (bodyStalls) return new Response(new ReadableStream({ start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        } }));
        return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      } });
    await expect(scorer.scoreFrameWindow(input)).rejects.toMatchObject({ code: "JEV_TIMEOUT" });
    expect(calls).toBe(3);
  }
});

it("cancels immediately during backoff without issuing another request", async () => {
  const controller = new AbortController(); let calls = 0;
  const scorer = createTypeSafeJevScorer({ apiKey: "test-secret", retryDelayMs: 10000, fetchImpl: async () => {
    calls++; return new Response("unavailable", { status: 503 });
  } });
  await expect(scorer.scoreFrameWindow({ ...input, signal: controller.signal,
    onRetry: retrying => { if (retrying) controller.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});

it("does not retry malformed successful responses", async () => {
  let calls = 0;
  const scorer = createTypeSafeJevScorer({ apiKey: "test-secret", retryDelayMs: 0,
    fetchImpl: async () => { calls++; return new Response("not JSON"); } });
  await expect(scorer.scoreFrameWindow(input)).rejects.toMatchObject({ code: "JEV_INVALID_RESPONSE" });
  expect(calls).toBe(1);
});
