import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildSystemOneWindowRequest,
  chooseSampleStepSeconds,
  createTypeSafeJevScorer,
  extractSampledFrames,
  groupFramesIntoScenes,
  probeVideoFile,
  startServer,
  type RunningBackendServer,
  type ScoredFrame,
  type SearchResponsePayload
} from "../index.js";

/**
 * Generates a 12-second synthetic MP4 clip (10 fps, 320x240, with sine audio) containing two disjoint red scenes:
 * - [0s..2s): blue
 * - [2s..5s): red (frames at 2s, 3s, 4s)
 * - [5s..8s): blue (negative frames at 5s, 6s, 7s)
 * - [8s..10s): red (frames at 8s, 9s)
 * - [10s..12s): blue
 */
function generateDisjointSceneVideo(outputPath: string): void {
  const filterComplex = "[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0[outv]";

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
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=12",
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-map",
      "5:a:0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "10",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      outputPath
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to generate synthetic test MP4 video: ${result.stderr}`);
  }
}

/**
 * Generates a real 6-second MKV file encoded with MPEG-4 part 2 video + FLAC audio:
 * - [0s..2s): blue
 * - [2s..4s): red (frames at 2s, 3s)
 * - [4s..6s): blue
 */
function generateNonChromiumMkvVideo(outputPath: string): void {
  const filterComplex = "[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]";

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
      "color=c=red:s=320x240:r=10:d=2,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=10:d=2,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=520:duration=6",
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-map",
      "3:a:0",
      "-c:v",
      "mpeg4",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "flac",
      outputPath
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to generate synthetic test MKV video: ${result.stderr}`);
  }
}

/**
 * Generates a multi-stream MKV with:
 * - v:0: blue 320x240, 4s (non-default disposition)
 * - v:1: red 640x480, 2s (default disposition)
 */
function generateMultiStreamMkvVideo(outputPath: string): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=10:d=4,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=640x480:r=10:d=2,format=yuv420p",
      "-map",
      "0:v:0",
      "-map",
      "1:v:0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-disposition:v:0",
      "0",
      "-disposition:v:1",
      "default",
      outputPath
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to generate multi-stream MKV video: ${result.stderr}`);
  }
}

function isFramePredominantlyRed(jpegPath: string): boolean {
  const res = spawnSync("ffmpeg", [
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
  ]);
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
  let syntheticMkvPath = "";
  let multiStreamMkvPath = "";
  const activeServers: RunningBackendServer[] = [];
  const tempDirs: string[] = [];

  beforeAll(() => {
    sharedFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "scene-finder-fixtures-"));
    syntheticMoviePath = path.join(sharedFixtureDir, "disjoint-red-scenes.mp4");
    syntheticMkvPath = path.join(sharedFixtureDir, "visual-events.mkv");
    multiStreamMkvPath = path.join(sharedFixtureDir, "multi-stream.mkv");
    generateDisjointSceneVideo(syntheticMoviePath);
    generateNonChromiumMkvVideo(syntheticMkvPath);
    generateMultiStreamMkvVideo(multiStreamMkvPath);
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

  it("splits on known negative frames, supports single-frame hits, refuses to merge across unsupported gaps, and uses consistent sampling steps", () => {
    // 90s and 2h movies use consistent 2s step instead of 48s; short <=15s clips use 1s
    expect(chooseSampleStepSeconds(7200)).toBe(2);
    expect(chooseSampleStepSeconds(90)).toBe(2);
    expect(chooseSampleStepSeconds(12)).toBe(1);
    expect(chooseSampleStepSeconds(1.5)).toBe(0.5);
    expect(() => chooseSampleStepSeconds(12, 0.0001)).toThrow(/sampleStepSeconds/);
    expect(() => chooseSampleStepSeconds(12, 0)).toThrow(/sampleStepSeconds/);
    expect(() => chooseSampleStepSeconds(12, -2)).toThrow(/sampleStepSeconds/);

    const frames: ScoredFrame[] = [
      { id: "frame_0", index: 0, timestampSeconds: 0, fileName: "frame_0.jpg", filePath: "/tmp/0.jpg", noul: 0.1 },
      { id: "frame_1", index: 1, timestampSeconds: 1, fileName: "frame_1.jpg", filePath: "/tmp/1.jpg", noul: 0.82 },
      { id: "frame_2", index: 2, timestampSeconds: 2, fileName: "frame_2.jpg", filePath: "/tmp/2.jpg", noul: 0.94 },
      { id: "frame_3", index: 3, timestampSeconds: 3, fileName: "frame_3.jpg", filePath: "/tmp/3.jpg", noul: 0.15 },
      { id: "frame_4", index: 4, timestampSeconds: 4, fileName: "frame_4.jpg", filePath: "/tmp/4.jpg", noul: 0.77 },
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

    const unauthRes = await fetch(`${server.url}/api/health`);
    expect(unauthRes.status).toBe(401);

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

    // Verify synchronous/broken binary path resolves ffprobe: false cleanly
    const brokenBinServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      apiKey: "valid-key",
      ffprobePath: "/nonexistent/bad-arch-ffprobe\0invalid"
    });
    activeServers.push(brokenBinServer);

    const brokenHealth = await fetch(`${brokenBinServer.url}/api/health`);
    expect(brokenHealth.status).toBe(200);
    expect(await brokenHealth.json()).toEqual({
      ready: false,
      checks: {
        apiKey: true,
        ffmpeg: true,
        ffprobe: false
      }
    });
  });

  it("uploads an MP4 movie, serves HTTP Range media, extracts measured timestamps, scores ordered Jev windows, reuses cached frames, returns disjoint matches + thumbnails, and exports trimmed MP4 clips", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-e2e-"));
    tempDirs.push(dataDir);

    const capturedRequests: Array<{
      url: string;
      headers: Record<string, string>;
      body: ReturnType<typeof buildSystemOneWindowRequest>;
    }> = [];

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

        const tmpJpg = path.join(dataDir, `verify_${frameItem.id}.jpg`);
        await fsp.writeFile(tmpJpg, Buffer.from(asset.data_base64, "base64"));

        if (isNegativeQuery) {
          answers[frameItem.id] = { type: "noul", noul: 0.01 };
        } else {
          const isRed = isFramePredominantlyRed(tmpJpg);
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

    // Reject tiny sampleStepSeconds on search request
    const tinyStepRes = await fetch(
      `${server.url}/api/movies/${uploadJson.movie.id}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "red", sampleStepSeconds: 0.0001 })
      }
    );
    expect(tinyStepRes.status).toBe(400);
    const tinyStepBody = (await tinyStepRes.json()) as { error: { code: string } };
    expect(tinyStepBody.error.code).toBe("INVALID_SAMPLE_STEP");

    const rangeRes = await fetch(`${server.url}${uploadJson.movie.mediaUrl}`, {
      headers: { Range: "bytes=0-127" }
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");
    expect(rangeRes.headers.get("content-range")).toMatch(/^bytes 0-127\/\d+$/);
    const rangeBytes = new Uint8Array(await rangeRes.arrayBuffer());
    expect(rangeBytes.byteLength).toBe(128);

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

    const completed = await pollSearchUntilTerminal(server.url, searchId);
    expect(completed.status).toBe("completed");
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

    const thumbRes = await fetch(`${server.url}${completed.results[0].thumbnailUrl}`);
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers.get("content-type")).toContain("image/jpeg");

    // Verify negative query reuses cached extracted frames and returns empty results
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
    expect(negCompleted.results).toEqual([]);

    // Verify POST /api/movies/:id/clips validation and H.264/AAC MP4 export with audio
    const badClipRes = await fetch(`${server.url}/api/movies/${uploadJson.movie.id}/clips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startSeconds: 5, endSeconds: 3 })
    });
    expect(badClipRes.status).toBe(400);
    const badClipJson = (await badClipRes.json()) as { error: { code: string } };
    expect(badClipJson.error.code).toBe("INVALID_CLIP_RANGE");

    const clipRes = await fetch(`${server.url}/api/movies/${uploadJson.movie.id}/clips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startSeconds: 2, endSeconds: 5 })
    });
    expect(clipRes.status).toBe(200);
    expect(clipRes.headers.get("content-type")).toContain("video/mp4");
    expect(clipRes.headers.get("content-disposition")).toContain("attachment;");
    expect(clipRes.headers.get("content-disposition")).toContain(".mp4");

    const clipBuffer = Buffer.from(await clipRes.arrayBuffer());
    const exportedClipPath = path.join(dataDir, "exported_clip.mp4");
    await fsp.writeFile(exportedClipPath, clipBuffer);

    const probedClip = await probeVideoFile(exportedClipPath);
    expect(probedClip.formatName).toContain("mp4");
    expect(probedClip.videoCodec).toBe("h264");
    expect(probedClip.hasAudio).toBe(true);
    expect(probedClip.audioCodec).toBe("aac");
    expect(probedClip.durationSeconds).toBeGreaterThanOrEqual(2.5);
    expect(probedClip.durationSeconds).toBeLessThanOrEqual(3.5);
  });

  it("prepares a real MKV (MPEG-4 + FLAC) and a multi-stream MKV (v0 blue 320x240/4s vs default v1 red 640x480/2s) consistently selecting 0:v:0", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-mkv-"));
    tempDirs.push(dataDir);

    const jevScorer = {
      async scoreFrameWindow(input: {
        query: string;
        frames: Array<{ id: string; filePath: string; timestampSeconds: number }>;
      }) {
        const scores: Record<string, number> = {};
        const wantsBlue = input.query.toLowerCase().includes("blue");
        for (const frame of input.frames) {
          const isRed = isFramePredominantlyRed(frame.filePath);
          if (wantsBlue) {
            scores[frame.id] = isRed ? 0.02 : 0.91;
          } else {
            scores[frame.id] = isRed ? 0.92 : 0.05;
          }
        }
        return scores;
      }
    };

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      jevScorer
    });
    activeServers.push(server);

    // 1. Single-stream MKV (MPEG-4 + FLAC)
    const mkvBytes = await fsp.readFile(syntheticMkvPath);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([mkvBytes], { type: "video/x-matroska" }),
      "visual-events.mkv"
    );

    const uploadRes = await fetch(`${server.url}/api/movies`, {
      method: "POST",
      body: formData
    });
    expect(uploadRes.status).toBe(201);
    const { movie } = (await uploadRes.json()) as {
      movie: {
        id: string;
        name: string;
        durationSeconds: number;
        width: number;
        height: number;
        mediaUrl: string;
      };
    };

    expect(movie.name).toBe("visual-events.mkv");
    expect(movie.durationSeconds).toBeCloseTo(6, 0);

    const rangeRes = await fetch(`${server.url}${movie.mediaUrl}`, {
      headers: { Range: "bytes=0-255" }
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-type")).toContain("video/mp4");

    const searchRes = await fetch(`${server.url}/api/movies/${movie.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "red flash" })
    });
    const { searchId } = (await searchRes.json()) as { searchId: string };
    const completed = await pollSearchUntilTerminal(server.url, searchId);
    expect(completed.status).toBe("completed");
    expect(completed.results).toHaveLength(1);
    expect(completed.results[0].startSeconds).toBe(2);
    expect(completed.results[0].endSeconds).toBe(3);

    // 2. Multi-stream MKV: v:0 is blue 320x240 4s, v:1 (default) is red 640x480 2s
    const multiBytes = await fsp.readFile(multiStreamMkvPath);
    const multiForm = new FormData();
    multiForm.append(
      "file",
      new Blob([multiBytes], { type: "video/x-matroska" }),
      "multi-stream.mkv"
    );

    const multiUploadRes = await fetch(`${server.url}/api/movies`, {
      method: "POST",
      body: multiForm
    });
    expect(multiUploadRes.status).toBe(201);
    const { movie: multiMovie } = (await multiUploadRes.json()) as {
      movie: {
        id: string;
        width: number;
        height: number;
        durationSeconds: number;
      };
    };

    expect(multiMovie.width).toBe(320);
    expect(multiMovie.height).toBe(240);
    expect(multiMovie.durationSeconds).toBeCloseTo(4, 0);

    // Searching for "red" on multi-stream MKV must return 0 matches because 0:v:0 is all blue
    const multiRedSearch = await fetch(
      `${server.url}/api/movies/${multiMovie.id}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "red stream" })
      }
    );
    const { searchId: multiRedId } = (await multiRedSearch.json()) as { searchId: string };
    const multiRedDone = await pollSearchUntilTerminal(server.url, multiRedId);
    expect(multiRedDone.status).toBe("completed");
    expect(multiRedDone.results).toEqual([]);

    // Searching for "blue" on multi-stream MKV matches the full 0..3s span of 0:v:0
    const multiBlueSearch = await fetch(
      `${server.url}/api/movies/${multiMovie.id}/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "blue stream" })
      }
    );
    const { searchId: multiBlueId } = (await multiBlueSearch.json()) as { searchId: string };
    const multiBlueDone = await pollSearchUntilTerminal(server.url, multiBlueId);
    expect(multiBlueDone.status).toBe("completed");
    expect(multiBlueDone.results).toHaveLength(1);
    expect(multiBlueDone.results[0].startSeconds).toBe(0);
    expect(multiBlueDone.results[0].endSeconds).toBe(3);
  });

  it("enforces maxUploadBytes, cleans up rejected uploads, and terminates slow ffprobe uploads on close()", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-limits-"));
    tempDirs.push(dataDir);

    // 1. Test maxUploadBytes rejection & temp cleanup
    const limitedServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      maxUploadBytes: 256
    });
    activeServers.push(limitedServer);

    const fileBytes = await fsp.readFile(syntheticMoviePath);
    const form = new FormData();
    form.append("file", new Blob([fileBytes], { type: "video/mp4" }), "too-big.mp4");

    const tooBigRes = await fetch(`${limitedServer.url}/api/movies`, {
      method: "POST",
      body: form
    });
    expect(tooBigRes.status).toBe(413);
    const tooBigBody = (await tooBigRes.json()) as { error: { code: string } };
    expect(tooBigBody.error.code).toBe("UPLOAD_TOO_LARGE");

    const leftoverTmp = await fsp.readdir(path.join(dataDir, "tmp"));
    expect(leftoverTmp).toEqual([]);

    await limitedServer.close();
    activeServers.pop();

    // 2. Test slow ffprobe upload gets killed and close() completes promptly (portable across Windows/macOS/Linux)
    const slowBinDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-slow-bin-"));
    tempDirs.push(slowBinDir);
    const markerFile = path.join(slowBinDir, "started.txt");
    const slowFfprobePath = path.join(slowBinDir, "slow-ffprobe.mjs");

    await fsp.writeFile(
      slowFfprobePath,
      `import fs from "node:fs";
if (process.argv[2] === "-version") {
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(markerFile)}, String(process.pid));
setTimeout(() => {}, 30000);
`,
      "utf8"
    );

    const slowServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      ffprobePath: slowFfprobePath
    });
    activeServers.push(slowServer);

    const slowForm = new FormData();
    slowForm.append("file", new Blob([fileBytes], { type: "video/mp4" }), "slow.mp4");

    const uploadPromise = fetch(`${slowServer.url}/api/movies`, {
      method: "POST",
      body: slowForm
    }).catch(() => null);

    // Wait for slow-ffprobe.mjs to start
    const waitDeadline = Date.now() + 5000;
    while (!fs.existsSync(markerFile) && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fs.existsSync(markerFile)).toBe(true);

    const closeStart = Date.now();
    await slowServer.close();
    activeServers.pop();
    const closeElapsedMs = Date.now() - closeStart;
    expect(closeElapsedMs).toBeLessThan(2000);

    await uploadPromise;
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

  it("keeps shared frame extraction alive for remaining concurrent searches when one search is cancelled, and closes active clip download streams promptly on close()", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-shared-extract-"));
    tempDirs.push(dataDir);

    const wrapperDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-ffmpeg-wrap-"));
    tempDirs.push(wrapperDir);
    const extractStartedFile = path.join(wrapperDir, "extract-started.txt");
    const slowFfmpegPath = path.join(wrapperDir, "slow-extract-ffmpeg.mjs");

    // Portable Node wrapper that delays frame extraction invocations (containing showinfo) by 600ms
    await fsp.writeFile(
      slowFfmpegPath,
      `import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.some((arg) => arg.includes("showinfo"))) {
  fs.writeFileSync(${JSON.stringify(extractStartedFile)}, "started");
  await new Promise((r) => setTimeout(r, 600));
}

const child = spawn("ffmpeg", args, { stdio: "inherit" });
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));
`,
      "utf8"
    );

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      ffmpegPath: slowFfmpegPath,
      jevScorer: {
        async scoreFrameWindow(input) {
          return Object.fromEntries(
            input.frames.map((f) => [f.id, f.timestampSeconds >= 2 ? 0.85 : 0.1])
          );
        }
      }
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

    // Start Search A and Search B concurrently so they share the in-flight frame extraction
    const [resA, resB] = await Promise.all([
      fetch(`${server.url}/api/movies/${movie.id}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "green scene A" })
      }),
      fetch(`${server.url}/api/movies/${movie.id}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "green scene B" })
      })
    ]);
    const { searchId: searchA } = (await resA.json()) as { searchId: string };
    const { searchId: searchB } = (await resB.json()) as { searchId: string };

    const waitDeadline = Date.now() + 5000;
    while (!fs.existsSync(extractStartedFile) && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(extractStartedFile)).toBe(true);

    // Cancel Search A while extraction is still running
    const cancelRes = await fetch(`${server.url}/api/searches/${searchA}`, {
      method: "DELETE"
    });
    expect(cancelRes.status).toBe(200);

    const [finalA, finalB] = await Promise.all([
      pollSearchUntilTerminal(server.url, searchA),
      pollSearchUntilTerminal(server.url, searchB)
    ]);

    expect(finalA.status).toBe("cancelled");
    expect(finalB.status).toBe("completed");
    expect(finalB.results).toHaveLength(1);
    expect(finalB.results[0].startSeconds).toBe(2);

    // Also test cancelling Search C (sole consumer at step 2s) and immediately retrying Search D at step 2s
    await fsp.unlink(extractStartedFile).catch(() => undefined);
    const resC = await fetch(`${server.url}/api/movies/${movie.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "green scene C", sampleStepSeconds: 2 })
    });
    const { searchId: searchC } = (await resC.json()) as { searchId: string };

    const waitDeadlineC = Date.now() + 5000;
    while (!fs.existsSync(extractStartedFile) && Date.now() < waitDeadlineC) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(extractStartedFile)).toBe(true);

    const cancelResC = await fetch(`${server.url}/api/searches/${searchC}`, {
      method: "DELETE"
    });
    expect(cancelResC.status).toBe(200);

    // Immediately launch Search D with the same (movieId, sampleStepSeconds: 2) before C's extraction cleanup settles
    const resD = await fetch(`${server.url}/api/movies/${movie.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "green scene D", sampleStepSeconds: 2 })
    });
    const { searchId: searchD } = (await resD.json()) as { searchId: string };

    const [finalC, finalD] = await Promise.all([
      pollSearchUntilTerminal(server.url, searchC),
      pollSearchUntilTerminal(server.url, searchD)
    ]);
    expect(finalC.status).toBe("cancelled");
    expect(finalD.status).toBe("completed");
    expect(finalD.results).toHaveLength(1);

    // Now test that an active clip download stream does not hang server.close()
    const clipRes = await fetch(`${server.url}/api/movies/${movie.id}/clips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startSeconds: 0,
        endSeconds: 2
      })
    });
    expect(clipRes.status).toBe(200);
    // Intentionally do not consume clipRes.body before calling close()
    const closeStart = Date.now();
    await server.close();
    activeServers.pop();
    const closeElapsedMs = Date.now() - closeStart;
    expect(closeElapsedMs).toBeLessThan(2000);
    await clipRes.body?.cancel().catch(() => undefined);
  });

  it("repairs damaged frame cache directories when a cached JPEG is missing and enforces both estimated and actual frame budgets", async () => {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-cache-repair-"));
    tempDirs.push(cacheDir);
    const framesOutDir = path.join(cacheDir, "frames_step_1");

    // 1. Initial extraction creates manifest.json + frame JPEGs
    const firstFrames = await extractSampledFrames({
      moviePath: syntheticMoviePath,
      outputDir: framesOutDir,
      sampleStepSeconds: 1,
      width: 320,
      height: 240,
      durationSeconds: 12
    });
    expect(firstFrames.length).toBeGreaterThanOrEqual(10);
    const deletedFramePath = firstFrames[1].filePath;
    expect(fs.existsSync(deletedFramePath)).toBe(true);

    // Delete a single cached JPEG while leaving manifest.json intact
    await fsp.unlink(deletedFramePath);
    expect(fs.existsSync(deletedFramePath)).toBe(false);
    expect(fs.existsSync(path.join(framesOutDir, "manifest.json"))).toBe(true);

    // Re-extracting must replace the damaged cache directory so all returned frame paths exist on disk
    const repairedFrames = await extractSampledFrames({
      moviePath: syntheticMoviePath,
      outputDir: framesOutDir,
      sampleStepSeconds: 1,
      width: 320,
      height: 240,
      durationSeconds: 12
    });
    expect(repairedFrames.length).toBe(firstFrames.length);
    for (const frame of repairedFrames) {
      expect(fs.existsSync(frame.filePath)).toBe(true);
    }

    // 2. Estimated frame budget: 0.05s sampling on a 2-hour movie (144,001 frames) is rejected before extraction
    expect(() => chooseSampleStepSeconds(7200, 0.05)).toThrow(/budget/i);

    await expect(
      extractSampledFrames({
        moviePath: syntheticMoviePath,
        outputDir: path.join(cacheDir, "over-estimated"),
        sampleStepSeconds: 0.05,
        width: 320,
        height: 240,
        durationSeconds: 7200
      })
    ).rejects.toMatchObject({
      code: "FRAME_BUDGET_EXCEEDED"
    });

    // 3. Actual frame budget: even if durationSeconds metadata is missing/under-reported (0.5s), actual extracted frames > maxFrames is rejected
    await expect(
      extractSampledFrames({
        moviePath: syntheticMoviePath,
        outputDir: path.join(cacheDir, "over-actual"),
        sampleStepSeconds: 1,
        width: 320,
        height: 240,
        durationSeconds: 0.5,
        maxFrames: 4
      })
    ).rejects.toMatchObject({
      code: "FRAME_BUDGET_EXCEEDED"
    });

    // 4. HTTP search endpoint returns 400 FRAME_BUDGET_EXCEEDED when requested step exceeds budget
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-budget-http-"));
    tempDirs.push(dataDir);
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      maxSampledFrames: 20
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

    // 12s movie at 0.05s step estimates 241 frames > maxSampledFrames (20)
    const budgetRes = await fetch(`${server.url}/api/movies/${movie.id}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "red scene",
        sampleStepSeconds: 0.05
      })
    });
    expect(budgetRes.status).toBe(400);
    const budgetBody = (await budgetRes.json()) as { error: { code: string } };
    expect(budgetBody.error.code).toBe("FRAME_BUDGET_EXCEEDED");
  });
  it("opens a movie larger than 2 GiB in place, serves its tail, searches and clips without copying the original", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-direct-large-"));
    tempDirs.push(dataDir);
    const source = path.join(dataDir, "large original.mp4");
    await fsp.copyFile(syntheticMoviePath, source);
    const originalBytes = await fsp.readFile(source);
    // A valid, sparse MP4 free box crosses the byte boundary without a multi-GB fixture.
    const handle = await fsp.open(source, "r+");
    await handle.write(Buffer.from([0, 0, 0, 0, 102, 114, 101, 101]), 0, 8, originalBytes.length);
    await handle.truncate(2 * 1024 ** 3 + 4096);
    await handle.close();
    const before = await fsp.stat(source);
    const server = await startServer({ port: 0, dataDir: path.join(dataDir, "app"), maxUploadBytes: 1,
      jevScorer: { async scoreFrameWindow(input) { return Object.fromEntries(input.frames.map(f => [f.id, .9])); } } });
    activeServers.push(server);
    const movie = await server.openMovie(source);
    expect(JSON.stringify(movie)).not.toContain(dataDir);
    expect(movie.durationSeconds).toBeCloseTo(12);
    expect(await fsp.readdir(path.join(dataDir, "app/movies", movie.id))).toEqual([]);
    expect((await fsp.stat(source)).ino).toBe(before.ino);
    expect((await fsp.stat(source)).size).toBe(before.size);
    const response = await fetch(`${server.url}${movie.mediaUrl}`, { headers: { Range: `bytes=${before.size - 16}-${before.size - 1}` } });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(16));
    // No HTTP endpoint may turn a supplied path into an opened local file.
    expect((await fetch(`${server.url}/api/movies/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: source }) })).status).toBe(404);
    const started = await fetch(`${server.url}/api/movies/${movie.id}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "red" }) });
    const result = await pollSearchUntilTerminal(server.url, (await started.json() as { searchId: string }).searchId);
    expect(result.status).toBe("completed");
    expect(result.processed).toBeGreaterThan(0);
    const clip = await fetch(`${server.url}/api/movies/${movie.id}/clips`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startSeconds: 2, endSeconds: 5 }) });
    expect(clip.status).toBe(200);
    const output = path.join(dataDir, "clip.mp4");
    await fsp.writeFile(output, Buffer.from(await clip.arrayBuffer()));
    expect((await probeVideoFile(output)).durationSeconds).toBeCloseTo(3, 1);
    await server.close(); activeServers.pop();
    expect((await fsp.stat(source)).size).toBe(before.size);
  });

  it("prepares a directly opened MKV and preserves originals when preparation is cancelled or fails", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-direct-mkv-")); tempDirs.push(dataDir);
    const original = await fsp.readFile(syntheticMkvPath);
    const server = await startServer({ port: 0, dataDir: path.join(dataDir, "app") }); activeServers.push(server);
    const progress: number[] = [];
    const movie = await server.openMovie(syntheticMkvPath, undefined, value => progress.push(value));
    expect(movie.durationSeconds).toBeCloseTo(6, 1);
    const playback = path.join(dataDir, "app/movies", movie.id, "playable.mp4");
    expect((await probeVideoFile(playback)).videoCodec).toBe("h264");
    expect(progress.length).toBeGreaterThan(0);
    expect(await fsp.readFile(syntheticMkvPath)).toEqual(original);
    const marker = path.join(dataDir, "preparing");
    const wrapper = path.join(dataDir, "slow.mjs");
    await fsp.writeFile(wrapper, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => {}, 30000);`);
    const slow = await startServer({ port: 0, dataDir: path.join(dataDir, "slow"), ffmpegPath: wrapper }); activeServers.push(slow);
    const abort = new AbortController();
    const opening = slow.openMovie(syntheticMkvPath, abort.signal).catch(error => error);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(fs.existsSync(marker)).toBe(true);
    abort.abort();
    expect((await opening).name).toBe("AbortError");
    expect(await fsp.readdir(path.join(dataDir, "slow/movies"))).toEqual([]);
    expect(await fsp.readFile(syntheticMkvPath)).toEqual(original);
    const invalid = path.join(dataDir, "invalid.mp4"); await fsp.writeFile(invalid, "original invalid file");
    await expect(server.openMovie(invalid)).rejects.toBeDefined();
    expect(await fsp.readFile(invalid, "utf8")).toBe("original invalid file");
  });

  it("publishes usable partial results, retains them on failure, and resumes only unfinished windows", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-resume-")); tempDirs.push(dataDir);
    const calls: number[] = []; let fail = true; let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const server = await startServer({ port: 0, dataDir, jevScorer: { async scoreFrameWindow(input) {
      const first = input.frames[0].index; calls.push(first);
      if (first === 4 && fail) { await held; fail = false; throw new Error("Temporary outage"); }
      return Object.fromEntries(input.frames.map(f => [f.id, f.index === 2 ? .9 : .1]));
    } } }); activeServers.push(server);
    const movie = await server.openMovie(syntheticMoviePath);
    const started = await fetch(`${server.url}/api/movies/${movie.id}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "red" }) });
    const { searchId } = await started.json() as { searchId: string };
    const deadline = Date.now() + 5000;
    while (!calls.includes(4) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const partial = await (await fetch(`${server.url}/api/searches/${searchId}`)).json() as SearchResponsePayload;
    expect(partial.status).toBe("searching"); expect(partial.processed).toBe(4); expect(partial.results).toHaveLength(1);
    expect((await fetch(`${server.url}${partial.results[0].thumbnailUrl}`)).status).toBe(200);
    release();
    const failed = await pollSearchUntilTerminal(server.url, searchId);
    expect(failed.status).toBe("failed"); expect(failed.results).toEqual(partial.results);
    expect((await fetch(`${server.url}/api/searches/${searchId}/resume`, { method: "POST" })).status).toBe(202);
    const completed = await pollSearchUntilTerminal(server.url, searchId);
    expect(completed.status).toBe("completed"); expect(completed.processed).toBe(completed.total);
    expect(calls.filter(index => index === 0)).toHaveLength(1);
    expect(calls.filter(index => index === 4)).toHaveLength(2);
    expect(completed.results).toEqual(partial.results);
    expect((await fetch(`${server.url}/api/searches/${searchId}/resume`, { method: "POST" })).status).toBe(409);
  });

  it("does not let an old cancelled request overwrite an immediately resumed search", async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-resume-race-")); tempDirs.push(dataDir);
    let calls = 0; let releaseOld!: () => void;
    const old = new Promise<void>(resolve => { releaseOld = resolve; });
    const server = await startServer({ port: 0, dataDir, jevScorer: { async scoreFrameWindow(input) {
      calls++;
      if (calls === 1) { await old; input.signal.throwIfAborted(); }
      return Object.fromEntries(input.frames.map(f => [f.id, .9]));
    } } }); activeServers.push(server);
    const movie = await server.openMovie(syntheticMoviePath);
    const { searchId } = await (await fetch(`${server.url}/api/movies/${movie.id}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "red" }) })).json() as { searchId: string };
    const deadline = Date.now() + 5000;
    while (!calls && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    await fetch(`${server.url}/api/searches/${searchId}`, { method: "DELETE" });
    await fetch(`${server.url}/api/searches/${searchId}/resume`, { method: "POST" });
    const completed = await pollSearchUntilTerminal(server.url, searchId);
    expect(completed.status).toBe("completed");
    releaseOld();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await pollSearchUntilTerminal(server.url, searchId)).status).toBe("completed");
  });

});


