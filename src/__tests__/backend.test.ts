import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildSystemOneWindowRequest,
  createTypeSafeJevScorer,
  groupFramesIntoScenes,
  startServer,
  type RunningBackendServer,
  type ScoredFrame,
  type SearchResponsePayload
} from "../index.js";

/**
 * Generates a 12-second synthetic MP4 clip (10 fps, 320x240) with two disjoint red scenes:
 * - [0s..2s): blue
 * - [2s..5s): red (frames at 2s, 3s, 4s)
 * - [5s..8s): blue (negative frames at 5s, 6s, 7s)
 * - [8s..10s): red (frames at 8s, 9s)
 * - [10s..12s): blue
 */
function generateDisjointSceneVideo(outputPath: string): void {
  const filterComplex = [
    "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0[outv]"
  ].join(";");

  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=10:d=2,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x240:r=10:d=3,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=10:d=3,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x240:r=10:d=2,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=10:d=2,format=yuv420p",
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "10",
      outputPath
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to generate synthetic test video: ${result.stderr}`);
  }
}

/**
 * Inspects an extracted JPEG file using ffmpeg rawvideo RGB24 to check if it is predominantly red.
 */
function isFramePredominantlyRed(jpegPath: string): boolean {
  const res = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      jpegPath,
      "-vf",
      "scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1"
    ]
  );
  if (res.status !== 0 || !res.stdout || res.stdout.length < 3) {
    return false;
  }
  const r = res.stdout[0];
  const b = res.stdout[2];
  return r > 150 && b < 100;
}

async function pollSearchUntilTerminal(
  baseUrl: string,
  searchId: string,
  headers: Record<string, string> = {},
  timeoutMs = 15000
): Promise<SearchResponsePayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/searches/${searchId}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponsePayload;
    if (
      body.status === "completed" ||
      body.status === "cancelled" ||
      body.status === "failed"
    ) {
      return body;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for search ${searchId} to reach terminal state.`);
}

describe("Scene Finder Backend Contract & Jev Pipeline", () => {
  let sharedFixtureDir = "";
  let syntheticMoviePath = "";
  const activeServers: RunningBackendServer[] = [];
  const tempDirs: string[] = [];

  beforeAll(() => {
    sharedFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-finder-fixtures-"));
    syntheticMoviePath = path.join(sharedFixtureDir, "disjoint-red-scenes.mp4");
    generateDisjointSceneVideo(syntheticMoviePath);
  });

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      if (srv) {
        await srv.close();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("splits on known negative frames, supports single-frame hits, and refuses to merge across unsupported gaps", () => {
    const frames: ScoredFrame[] = [
      { id: "frame_0", index: 0, timestampSeconds: 0, fileName: "frame_0.jpg", filePath: "/tmp/0.jpg", noul: 0.1 },
      { id: "frame_1", index: 1, timestampSeconds: 1, fileName: "frame_1.jpg", filePath: "/tmp/1.jpg", noul: 0.82 },
      { id: "frame_2", index: 2, timestampSeconds: 2, fileName: "frame_2.jpg", filePath: "/tmp/2.jpg", noul: 0.94 },
      // Known negative frame at index 3 splits the scene
      { id: "frame_3", index: 3, timestampSeconds: 3, fileName: "frame_3.jpg", filePath: "/tmp/3.jpg", noul: 0.15 },
      // Single isolated hit at index 4 -> startSeconds === endSeconds === 4
      { id: "frame_4", index: 4, timestampSeconds: 4, fileName: "frame_4.jpg", filePath: "/tmp/4.jpg", noul: 0.77 },
      // Consecutive index 5, but unsupported timestamp gap (9s vs 4s when sampleStepSeconds=1) -> must NOT merge with frame_4
      { id: "frame_5", index: 5, timestampSeconds: 9, fileName: "frame_5.jpg", filePath: "/tmp/5.jpg", noul: 0.88 }
    ];

    const results = groupFramesIntoScenes(frames, {
      sampleStepSeconds: 1,
      searchId: "srch_unit"
    });

    expect(results).toEqual([
      {
        id: "frame_2",
        startSeconds: 1,
        endSeconds: 2,
        peakTimestampSeconds: 2,
        score: 0.94,
        thumbnailUrl: "/api/searches/srch_unit/thumbnails/frame_2.jpg"
      },
      {
        id: "frame_5",
        startSeconds: 9,
        endSeconds: 9,
        peakTimestampSeconds: 9,
        score: 0.88,
        thumbnailUrl: "/api/searches/srch_unit/thumbnails/frame_5.jpg"
      },
      {
        id: "frame_4",
        startSeconds: 4,
        endSeconds: 4,
        peakTimestampSeconds: 4,
        score: 0.77,
        thumbnailUrl: "/api/searches/srch_unit/thumbnails/frame_4.jpg"
      }
    ]);
  });

  it("supports live getApiKey updates on /api/health and enforces optional X-Scene-Finder-Token", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-health-"));
    tempDirs.push(dataDir);

    let liveKey = "";
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      apiToken: "desktop-secret-token-123",
      getApiKey: () => liveKey
    });
    activeServers.push(server);

    // Without X-Scene-Finder-Token -> 401
    const unauthRes = await fetch(`${server.url}/api/health`);
    expect(unauthRes.status).toBe(401);

    // With token, while liveKey is empty -> ready: false, checks.apiKey: false
    const headers = { "X-Scene-Finder-Token": "desktop-secret-token-123" };
    const healthBefore = await fetch(`${server.url}/api/health`, { headers });
    expect(healthBefore.status).toBe(200);
    const bodyBefore = await healthBefore.json();
    expect(bodyBefore).toEqual({
      ready: false,
      checks: {
        apiKey: false,
        ffmpeg: true,
        ffprobe: true
      }
    });

    // Update key dynamically via getApiKey
    liveKey = "ts_live_super_secret_key_value";
    const healthAfter = await fetch(`${server.url}/api/health`, { headers });
    expect(healthAfter.status).toBe(200);
    const rawText = await healthAfter.text();
    expect(rawText).not.toContain("ts_live_super_secret_key_value");
    expect(JSON.parse(rawText)).toEqual({
      ready: true,
      checks: {
        apiKey: true,
        ffmpeg: true,
        ffprobe: true
      }
    });
  });

  it("uploads a movie, serves HTTP Range media, extracts measured timestamps, scores ordered Jev windows, and returns disjoint matches + thumbnails", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-e2e-"));
    tempDirs.push(dataDir);

    const capturedRequests: Array<{
      url: string;
      headers: Record<string, string>;
      body: ReturnType<typeof buildSystemOneWindowRequest>;
    }> = [];

    // Mock fetch for TypeSafe Jev /v1/systemone that inspects actual extracted frame pixels
    const fakeJevFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const reqHeaders = (init?.headers ?? {}) as Record<string, string>;
      const parsedBody = JSON.parse(String(init?.body ?? "{}")) as ReturnType<
        typeof buildSystemOneWindowRequest
      >;
      capturedRequests.push({ url, headers: reqHeaders, body: parsedBody });

      const isNegativeQuery = parsedBody.state.query.toLowerCase().includes("absent car");
      const answers: Record<string, { type: "noul"; noul: number }> = {};

      for (const frameItem of parsedBody.state.frames) {
        const asset = parsedBody.assets[frameItem.image];
        expect(asset).toBeDefined();
        expect(asset.type).toBe("image");
        expect(asset.format).toBe("jpg");

        // Write decoded JPEG to temp file to verify pixel color & dimensions
        const tmpJpg = path.join(dataDir, `verify_${frameItem.id}.jpg`);
        await fsp.writeFile(tmpJpg, Buffer.from(asset.data_base64, "base64"));

        if (isNegativeQuery) {
          answers[frameItem.id] = { type: "noul", noul: 0.01 };
        } else {
          const isRed = isFramePredominantlyRed(tmpJpg);
          // Give highest score to 3s and 8s so peakTimestampSeconds is deterministic
          let score = 0.08;
          if (isRed) {
            score =
              Math.abs(frameItem.timestampSeconds - 3) < 0.25
                ? 0.95
                : Math.abs(frameItem.timestampSeconds - 8) < 0.25
                  ? 0.89
                  : 0.81;
          }
          answers[frameItem.id] = { type: "noul", noul: score };
        }
      }

      return new Response(
        JSON.stringify({
          model: "jev-1.14.0",
          answers,
          usage: { input_tokens: 400, output_tokens: 20 }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const jevScorer = createTypeSafeJevScorer({
      apiKey: "test-jev-api-key-9999",
      model: "jev-preview",
      apiBaseUrl: "https://api.typesafe.ai",
      fetchImpl: fakeJevFetch
    });

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      windowSize: 4,
      jevScorer
    });
    activeServers.push(server);

    // 1. Upload movie via POST /api/movies
    const fileBytes = await fsp.readFile(syntheticMoviePath);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileBytes], { type: "video/mp4" }),
      "disjoint-red-scenes.mp4"
    );

    const uploadRes = await fetch(`${server.url}/api/movies`, {
      method: "POST",
      body: formData
    });
    expect(uploadRes.status).toBe(201);
    const uploadJson = (await uploadRes.json()) as {
      movie: {
        id: string;
        name: string;
        durationSeconds: number;
        width: number;
        height: number;
        mediaUrl: string;
      };
    };

    expect(uploadJson.movie.id).toMatch(/^mov_/);
    expect(uploadJson.movie.name).toBe("disjoint-red-scenes.mp4");
    expect(uploadJson.movie.width).toBe(320);
    expect(uploadJson.movie.height).toBe(240);
    expect(uploadJson.movie.durationSeconds).toBeCloseTo(12, 0);
    expect(uploadJson.movie.mediaUrl).toBe(`/api/movies/${uploadJson.movie.id}/media`);

    // 2. Verify playable media supports HTTP Range requests
    const rangeRes = await fetch(`${server.url}${uploadJson.movie.mediaUrl}`, {
      headers: { Range: "bytes=0-127" }
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeRes.headers.get("content-range")).toMatch(/^bytes 0-127\/\d+$/);
    const rangeBytes = new Uint8Array(await rangeRes.arrayBuffer());
    expect(rangeBytes.byteLength).toBe(128);

    // 3. Start positive search for "red scene"
    const searchRes = await fetch(
      `${server.url}/api/movies/${uploadJson.movie.id}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "bright red scene" })
      }
    );
    expect(searchRes.status).toBe(202);
    const { searchId } = (await searchRes.json()) as { searchId: string };
    expect(searchId).toMatch(/^srch_/);

    const completed = await pollSearchUntilTerminal(server.url, searchId);
    expect(completed.status).toBe("completed");
    expect(completed.movieId).toBe(uploadJson.movie.id);
    expect(completed.query).toBe("bright red scene");
    expect(completed.sampleStepSeconds).toBe(1);
    expect(completed.total).toBeGreaterThanOrEqual(12);
    expect(completed.processed).toBe(completed.total);

    // Verify Jev System One requests had required headers and model
    expect(capturedRequests.length).toBeGreaterThanOrEqual(3);
    expect(capturedRequests[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(capturedRequests[0].headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
    expect(capturedRequests[0].headers.Authorization).toBe("Bearer test-jev-api-key-9999");
    expect(capturedRequests[0].body.model).toBe("jev-preview");

    // Verify the two disjoint red scenes [2..4] and [8..9] were NOT merged across [5..7]
    expect(completed.results).toHaveLength(2);
    expect(completed.results[0]).toEqual({
      id: "frame_3",
      startSeconds: 2,
      endSeconds: 4,
      peakTimestampSeconds: 3,
      score: 0.95,
      thumbnailUrl: `/api/searches/${searchId}/thumbnails/frame_3.jpg`
    });
    expect(completed.results[1]).toEqual({
      id: "frame_8",
      startSeconds: 8,
      endSeconds: 9,
      peakTimestampSeconds: 8,
      score: 0.89,
      thumbnailUrl: `/api/searches/${searchId}/thumbnails/frame_8.jpg`
    });

    // 4. Verify thumbnail URL works directly in browser and is a valid JPEG of the red frame
    const thumbRes = await fetch(`${server.url}${completed.results[0].thumbnailUrl}`);
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers.get("content-type")).toContain("image/jpeg");
    const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
    expect(thumbBytes[0]).toBe(0xff);
    expect(thumbBytes[1]).toBe(0xd8);

    // 5. Verify negative query returns empty results
    const negRes = await fetch(
      `${server.url}/api/movies/${uploadJson.movie.id}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "absent car on highway" })
      }
    );
    expect(negRes.status).toBe(202);
    const { searchId: negSearchId } = (await negRes.json()) as { searchId: string };
    const negCompleted = await pollSearchUntilTerminal(server.url, negSearchId);
    expect(negCompleted.status).toBe("completed");
    expect(negCompleted.processed).toBe(negCompleted.total);
    expect(negCompleted.results).toEqual([]);
  });

  it("supports cancelling an active search via DELETE /api/searches/:searchId", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-cancel-"));
    tempDirs.push(dataDir);

    let notifyWindowEntered: (() => void) | undefined;
    const windowEnteredPromise = new Promise<void>((resolve) => {
      notifyWindowEntered = resolve;
    });

    const slowScorer = {
      async scoreFrameWindow(input: { frames: Array<{ id: string }>; signal: AbortSignal }) {
        notifyWindowEntered?.();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10000);
          input.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true }
          );
        });
        return Object.fromEntries(input.frames.map((f) => [f.id, 0.5]));
      }
    };

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      windowSize: 2,
      jevScorer: slowScorer
    });
    activeServers.push(server);

    const fileBytes = await fsp.readFile(syntheticMoviePath);
    const formData = new FormData();
    formData.append("file", new Blob([fileBytes], { type: "video/mp4" }), "clip.mp4");
    const uploadRes = await fetch(`${server.url}/api/movies`, {
      method: "POST",
      body: formData
    });
    const { movie } = (await uploadRes.json()) as { movie: { id: string } };

    const searchRes = await fetch(`${server.url}/api/movies/${movie.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "red square" })
    });
    const { searchId } = (await searchRes.json()) as { searchId: string };

    await windowEnteredPromise;

    const delRes = await fetch(`${server.url}/api/searches/${searchId}`, {
      method: "DELETE"
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ ok: true });

    const cancelledState = await pollSearchUntilTerminal(server.url, searchId);
    expect(cancelledState.status).toBe("cancelled");
  });

  it("reports clear setup/provider errors and never leaks secret API keys", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-errors-"));
    tempDirs.push(dataDir);

    let currentKey = "";
    const failingFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          error: `Upstream error for key ${currentKey}`
        }),
        { status: 500 }
      );
    };

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      getApiKey: () => currentKey,
      jevScorer: createTypeSafeJevScorer({
        apiKey: () => currentKey,
        model: "jev-preview",
        fetchImpl: failingFetch
      })
    });
    activeServers.push(server);

    const fileBytes = await fsp.readFile(syntheticMoviePath);
    const formData = new FormData();
    formData.append("file", new Blob([fileBytes], { type: "video/mp4" }), "clip.mp4");
    const uploadRes = await fetch(`${server.url}/api/movies`, {
      method: "POST",
      body: formData
    });
    const { movie } = (await uploadRes.json()) as { movie: { id: string } };

    // 1. Missing API key -> fails with MISSING_API_KEY, never invents results
    const noKeySearch = await fetch(`${server.url}/api/movies/${movie.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "red scene" })
    });
    const { searchId: noKeyId } = (await noKeySearch.json()) as { searchId: string };
    const noKeyResult = await pollSearchUntilTerminal(server.url, noKeyId);
    expect(noKeyResult.status).toBe("failed");
    expect(noKeyResult.results).toEqual([]);
    expect(noKeyResult.error?.code).toBe("MISSING_API_KEY");

    // 2. Provider error -> fails with JEV_PROVIDER_ERROR and redacts secret key
    currentKey = "secret_typesafe_key_xyz987";
    const errSearch = await fetch(`${server.url}/api/movies/${movie.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "red scene" })
    });
    const { searchId: errId } = (await errSearch.json()) as { searchId: string };
    const errResult = await pollSearchUntilTerminal(server.url, errId);
    expect(errResult.status).toBe("failed");
    expect(errResult.error?.code).toBe("JEV_PROVIDER_ERROR");
    expect(errResult.error?.message).not.toContain("secret_typesafe_key_xyz987");
    expect(errResult.error?.message).toContain("[REDACTED]");
  });
});
