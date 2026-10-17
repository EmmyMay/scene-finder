import crypto from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, redactSecrets } from "./env.js";
import type { FrameWindowScoreInput, JevScorer } from "./types.js";

export interface TypeSafeJevScorerOptions {
  apiKey: string | (() => string);
  model?: string | (() => string);
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}

interface SystemOneNoulAnswer {
  type?: string;
  noul?: number;
}

interface SystemOneResponseBody {
  model?: string;
  answers?: Record<string, SystemOneNoulAnswer>;
}

export function buildSystemOneWindowRequest(
  model: string,
  input: FrameWindowScoreInput,
  encodedFrames: Array<{ id: string; index: number; timestampSeconds: number; base64: string; assetRef: string }>
): {
  model: string;
  state: {
    movie: string;
    query: string;
    frames: Array<{
      id: string;
      order: number;
      timestampSeconds: number;
      image: string;
    }>;
  };
  assets: Record<
    string,
    {
      type: "image";
      format: "jpg";
      data_base64: string;
    }
  >;
  questions: Record<
    string,
    {
      type: "noul";
      instructions: string;
      criteria: {
        true: string;
        false: string;
      };
    }
  >;
} {
  const stateFrames: Array<{
    id: string;
    order: number;
    timestampSeconds: number;
    image: string;
  }> = [];

  const assets: Record<
    string,
    {
      type: "image";
      format: "jpg";
      data_base64: string;
    }
  > = {};

  const questions: Record<
    string,
    {
      type: "noul";
      instructions: string;
      criteria: {
        true: string;
        false: string;
      };
    }
  > = {};

  encodedFrames.forEach((frame, windowPosition) => {
    stateFrames.push({
      id: frame.id,
      order: windowPosition,
      timestampSeconds: frame.timestampSeconds,
      image: frame.assetRef
    });

    assets[frame.assetRef] = {
      type: "image",
      format: "jpg",
      data_base64: frame.base64
    };

    // Refer to the image in state via backtick path `frames[i].image` so each asset
    // reference string is expanded only once in state.
    questions[frame.id] = {
      type: "noul",
      instructions: `Inspect movie frame \`frames[${windowPosition}].image\` at timestamp ${frame.timestampSeconds}s in the ordered \`frames\` window. Does this specific frame directly show the visible action and details requested in \`query\`: "${input.query}"?`,
      criteria: {
        true: `The frame visibly depicts the specific action, subject, and details described in query (${input.query}), not merely the same character or setting in an unrelated shot.`,
        false: `The frame does not visibly show the specific action or details described in query (${input.query}).`
      }
    };
  });

  return {
    model,
    state: {
      movie: input.movieName,
      query: input.query,
      frames: stateFrames
    },
    assets,
    questions
  };
}

export function createTypeSafeJevScorer(options: TypeSafeJevScorerOptions): JevScorer {
  const baseUrl = (options.apiBaseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, "");
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  return {
    async scoreFrameWindow(input: FrameWindowScoreInput): Promise<Record<string, number>> {
      const currentApiKey = (
        typeof options.apiKey === "function" ? options.apiKey() : options.apiKey
      ).trim();

      if (!currentApiKey) {
        throw new AppError(
          "MISSING_API_KEY",
          "TYPESAFE_API_KEY is not configured. Configure TYPESAFE_API_KEY in the server environment before running a search.",
          503
        );
      }

      const currentModel =
        (typeof options.model === "function" ? options.model() : options.model)?.trim() ||
        "jev-preview";

      if (input.frames.length === 0) {
        return {};
      }

      const encodedFrames = await Promise.all(
        input.frames.map(async (frame) => {
          const buffer = await fs.readFile(frame.filePath);
          return {
            id: frame.id,
            index: frame.index,
            timestampSeconds: frame.timestampSeconds,
            base64: buffer.toString("base64"),
            assetRef: `frame-asset-${crypto.randomUUID()}`
          };
        })
      );

      const requestPayload = buildSystemOneWindowRequest(currentModel, input, encodedFrames);

      let body: SystemOneResponseBody | undefined;
      const payload = JSON.stringify(requestPayload);
      for (let attempt = 0; attempt < 3; attempt++) {
        input.signal.throwIfAborted();
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), options.requestTimeoutMs ?? 45000);
        const signal = AbortSignal.any([input.signal, timeout.signal]);
        let retryMs = Math.min(30000, (options.retryDelayMs ?? 1000) * 2 ** attempt);
        let retryable = true;
        try {
          const response = await fetchFn(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentApiKey}`,
              "TypeSafe-Danger-Zone-Images": "true",
              "Content-Type": "application/json"
            },
            body: payload,
            signal
          });
          retryable = response.ok || [408, 429, 500, 502, 503, 504].includes(response.status);
          if (!response.ok) {
            const retryAfter = response.headers.get("Retry-After");
            if (retryAfter) {
              const seconds = Number(retryAfter);
              const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
              // Never retry earlier than the provider asks. Long waits become an explicit retry.
              if (requestedDelay > 30000) retryable = false;
              else if (Number.isFinite(requestedDelay)) retryMs = Math.max(retryMs, requestedDelay);
            }
            const detail = (await response.text()).slice(0, 400);
            const code = [401, 403].includes(response.status) ? "JEV_API_KEY_REJECTED" : response.status === 429 ? "JEV_RATE_LIMITED" : "JEV_PROVIDER_ERROR";
            throw new AppError(code, `Jev provider request failed (HTTP ${response.status}: ${redactSecrets(detail, [currentApiKey])})`, 502);
          }
          // The same deadline covers headers and body consumption.
          const text = await response.text();
          try { body = JSON.parse(text) as SystemOneResponseBody; }
          catch { throw new AppError("JEV_INVALID_RESPONSE", "Jev provider returned non-JSON response.", 502); }
          break;
        } catch (error) {
          input.signal.throwIfAborted();
          if (error instanceof AppError && error.code === "JEV_INVALID_RESPONSE") retryable = false;
          if (!retryable || attempt === 2) {
            if (error instanceof AppError) throw error;
            throw new AppError(timeout.signal.aborted ? "JEV_TIMEOUT" : "JEV_PROVIDER_ERROR",
              timeout.signal.aborted ? "Jev took too long to respond. Retry the remaining frames." :
                `Failed to reach Jev provider: ${redactSecrets(error instanceof Error ? error.message : "Network request failed", [currentApiKey])}`, 502);
          }
        } finally {
          clearTimeout(timer);
        }
        input.onRetry?.(true);
        try { await delay(retryMs, undefined, { signal: input.signal }); }
        finally { input.onRetry?.(false); }
      }

      const answers = body?.answers;
      if (!answers || typeof answers !== "object") {
        throw new AppError(
          "JEV_INVALID_RESPONSE",
          "Jev provider response is missing the 'answers' object.",
          502
        );
      }

      const scores: Record<string, number> = {};
      for (const frame of input.frames) {
        const answer = answers[frame.id];
        const noul = answer?.noul;
        if (answer?.type !== "noul" || typeof noul !== "number" || !Number.isFinite(noul)) {
          throw new AppError(
            "JEV_INVALID_RESPONSE",
            `Jev provider response is missing a valid noul score for '${frame.id}'.`,
            502
          );
        }
        scores[frame.id] = Math.max(0, Math.min(1, noul));
      }

      return scores;
    }
  };
}
