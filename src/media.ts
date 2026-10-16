import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "./env.js";
import { roundTimestamp } from "./scene-grouping.js";
import type { ExtractedFrame } from "./types.js";

export interface ProbedVideoInfo {
  durationSeconds: number;
  width: number;
  height: number;
  formatName: string;
  videoCodec: string;
  pixFmt: string;
  audioCodec: string | null;
  hasAudio: boolean;
  videoStreamCount: number;
}

function killChildProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Ignore if group already exited
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore if already exited
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export async function moveFileCrossDevice(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fsp.rename(sourcePath, targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EXDEV") {
      await fsp.copyFile(sourcePath, targetPath);
      await fsp.unlink(sourcePath);
      return;
    }
    throw err;
  }
}

export async function checkBinaryAvailable(binary: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    const child = spawn(binary, ["-version"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: process.platform !== "win32"
    });
    const timer = setTimeout(() => {
      killChildProcessTree(child);
      finish(false);
    }, 4000);

    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error("Operation cancelled");
      abortErr.name = "AbortError";
      reject(abortErr);
      return;
    }

    let settled = false;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    let stdout = "";
    let stderr = "";

    const onAbort = (): void => {
      killChildProcessTree(child);
      if (!settled) {
        settled = true;
        const abortErr = new Error("Operation cancelled");
        abortErr.name = "AbortError";
        reject(abortErr);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (settled) {
        return;
      }
      settled = true;
      if (signal?.aborted) {
        const abortErr = new Error("Operation cancelled");
        abortErr.name = "AbortError";
        reject(abortErr);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code}: ${stderr.slice(-600).trim() || "unknown error"}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function probeVideoFile(
  filePath: string,
  ffprobeBin = "ffprobe",
  signal?: AbortSignal
): Promise<ProbedVideoInfo> {
  let probeJson: {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      duration?: string | number;
    }>;
    format?: {
      format_name?: string;
      duration?: string | number;
    };
  };

  try {
    const { stdout } = await runProcess(
      ffprobeBin,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,codec_name,pix_fmt,width,height,duration:format=format_name,duration",
        "-of",
        "json",
        filePath
      ],
      signal
    );
    probeJson = JSON.parse(stdout);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    throw new AppError(
      "INVALID_MOVIE",
      "Uploaded file could not be inspected as a valid video file.",
      400
    );
  }

  const streams = probeJson.streams ?? [];
  const videoStreams = streams.filter((s) => s.codec_type === "video");
  const videoStream = videoStreams[0];
  if (!videoStream) {
    throw new AppError("INVALID_MOVIE", "Uploaded file does not contain a video stream.", 400);
  }

  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const audioStream = audioStreams[0];

  const width = Number(videoStream.width);
  const height = Number(videoStream.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new AppError("INVALID_MOVIE", "Video stream has invalid width or height.", 400);
  }

  let durationSeconds = Number(videoStream.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    // When multiple video streams exist, format.duration may reflect a different stream;
    // prefer packet timestamps of v:0 before falling back to format.duration.
    if (videoStreams.length === 1) {
      durationSeconds = Number(probeJson.format?.duration);
    }
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    try {
      const { stdout: packetOut } = await runProcess(
        ffprobeBin,
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "packet=pts_time,duration_time",
          "-of",
          "json",
          filePath
        ],
        signal
      );
      const packetData = JSON.parse(packetOut) as {
        packets?: Array<{ pts_time?: string; duration_time?: string }>;
      };
      let maxEnd = 0;
      for (const pkt of packetData.packets ?? []) {
        const pts = Number(pkt.pts_time);
        const dur = Number(pkt.duration_time);
        if (Number.isFinite(pts)) {
          const end = pts + (Number.isFinite(dur) && dur > 0 ? dur : 0);
          if (end > maxEnd) {
            maxEnd = end;
          }
        }
      }
      durationSeconds = maxEnd;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
    }
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = Number(probeJson.format?.duration);
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError(
      "INVALID_MOVIE",
      "Video file does not have a valid positive duration.",
      400
    );
  }

  return {
    durationSeconds: roundTimestamp(durationSeconds),
    width,
    height,
    formatName: (probeJson.format?.format_name ?? "").toLowerCase(),
    videoCodec: (videoStream.codec_name ?? "").toLowerCase(),
    pixFmt: (videoStream.pix_fmt ?? "").toLowerCase(),
    audioCodec: audioStream ? (audioStream.codec_name ?? "").toLowerCase() : null,
    hasAudio: Boolean(audioStream),
    videoStreamCount: videoStreams.length
  };
}

export interface PreparePlayableMovieOptions {
  sourcePath: string;
  playableOutputPath: string;
  probed: ProbedVideoInfo;
  ffmpegBin?: string;
  ffprobeBin?: string;
  signal?: AbortSignal;
}

/**
 * Ensures the movie is in a Chromium-playable H.264/AAC MP4 container containing
 * strictly the primary video stream `0:v:0` (and `0:a:0?`).
 */
export async function preparePlayableMovie(
  options: PreparePlayableMovieOptions
): Promise<{ playablePath: string; probed: ProbedVideoInfo }> {
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  const ffprobeBin = options.ffprobeBin ?? "ffprobe";
  const ext = path.extname(options.sourcePath).toLowerCase();

  const isMp4Container =
    (ext === ".mp4" || ext === ".m4v") && options.probed.formatName.includes("mp4");
  const isCompatibleH264 =
    options.probed.videoCodec === "h264" &&
    (options.probed.pixFmt === "yuv420p" || options.probed.pixFmt === "yuvj420p");
  const isCompatibleAudio =
    !options.probed.hasAudio || options.probed.audioCodec === "aac";

  if (
    isMp4Container &&
    isCompatibleH264 &&
    isCompatibleAudio &&
    options.probed.videoStreamCount === 1
  ) {
    return {
      playablePath: options.sourcePath,
      probed: options.probed
    };
  }

  try {
    if (isCompatibleH264) {
      try {
        const audioArgs = !options.probed.hasAudio
          ? ["-an"]
          : options.probed.audioCodec === "aac"
            ? ["-map", "0:a:0?", "-c:a", "copy"]
            : ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k"];

        await runProcess(
          ffmpegBin,
          [
            "-hide_banner",
            "-nostdin",
            "-i",
            options.sourcePath,
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-disposition:v:0",
            "default",
            ...audioArgs,
            "-movflags",
            "+faststart",
            options.playableOutputPath,
            "-y"
          ],
          options.signal
        );

        const reprobed = await probeVideoFile(
          options.playableOutputPath,
          ffprobeBin,
          options.signal
        );
        return {
          playablePath: options.playableOutputPath,
          probed: reprobed
        };
      } catch (remuxErr) {
        if (remuxErr instanceof Error && remuxErr.name === "AbortError") {
          throw remuxErr;
        }
      }
    }

    const audioTranscodeArgs = options.probed.hasAudio
      ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k"]
      : ["-an"];

    await runProcess(
      ffmpegBin,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        options.sourcePath,
        "-map",
        "0:v:0",
        "-vf",
        "scale='trunc(iw/2)*2':'trunc(ih/2)*2'",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-disposition:v:0",
        "default",
        ...audioTranscodeArgs,
        "-movflags",
        "+faststart",
        options.playableOutputPath,
        "-y"
      ],
      options.signal
    );

    const reprobed = await probeVideoFile(
      options.playableOutputPath,
      ffprobeBin,
      options.signal
    );
    return {
      playablePath: options.playableOutputPath,
      probed: reprobed
    };
  } catch (err) {
    await fsp.unlink(options.playableOutputPath).catch(() => undefined);
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    throw new AppError(
      "MOVIE_PREPARATION_FAILED",
      "Failed to prepare video for browser playback.",
      422
    );
  }
}

export interface ExportMovieClipOptions {
  playableMoviePath: string;
  outputClipPath: string;
  startSeconds: number;
  endSeconds: number;
  ffmpegBin?: string;
  signal?: AbortSignal;
}

export async function exportMovieClip(options: ExportMovieClipOptions): Promise<void> {
  const ffmpegBin = options.ffmpegBin ?? "ffmpeg";
  try {
    await runProcess(
      ffmpegBin,
      [
        "-hide_banner",
        "-nostdin",
        "-ss",
        String(roundTimestamp(options.startSeconds)),
        "-to",
        String(roundTimestamp(options.endSeconds)),
        "-i",
        options.playableMoviePath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        options.outputClipPath,
        "-y"
      ],
      options.signal
    );
  } catch (err) {
    await fsp.unlink(options.outputClipPath).catch(() => undefined);
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    throw new AppError(
      "CLIP_EXPORT_FAILED",
      "Failed to export video clip for the requested time range.",
      500
    );
  }
}

export function computeTargetFrameDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  const MIN_SIDE = 280;
  const MAX_SIDE = 1568;

  let w = width;
  let h = height;

  const longest = Math.max(w, h);
  if (longest > MAX_SIDE) {
    const scale = MAX_SIDE / longest;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const shortest = Math.min(w, h);
  if (shortest < MIN_SIDE) {
    const scale = MIN_SIDE / shortest;
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  w = Math.max(MIN_SIDE, Math.min(MAX_SIDE, w));
  h = Math.max(MIN_SIDE, Math.min(MAX_SIDE, h));

  if (w % 2 !== 0) {
    w = w < MAX_SIDE ? w + 1 : w - 1;
  }
  if (h % 2 !== 0) {
    h = h < MAX_SIDE ? h + 1 : h - 1;
  }

  return { width: w, height: h };
}

/**
 * Selects a candid, consistent sampling interval (0.5s for <=2s clips, 1s for <=120s, 2s for longer movies)
 * and validates any caller-supplied `requestedStepSeconds` is finite and has a positive minimum after rounding.
 */
export function chooseSampleStepSeconds(
  durationSeconds: number,
  requestedStepSeconds?: unknown
): number {
  if (requestedStepSeconds !== undefined) {
    if (
      typeof requestedStepSeconds !== "number" ||
      !Number.isFinite(requestedStepSeconds) ||
      requestedStepSeconds <= 0
    ) {
      throw new AppError(
        "INVALID_SAMPLE_STEP",
        "sampleStepSeconds must be a finite positive number.",
        400
      );
    }
    const rounded = roundTimestamp(requestedStepSeconds);
    if (rounded < 0.05) {
      throw new AppError(
        "INVALID_SAMPLE_STEP",
        "sampleStepSeconds must be at least 0.05 seconds after rounding.",
        400
      );
    }
    return rounded;
  }

  if (durationSeconds <= 2) {
    return 0.5;
  }
  if (durationSeconds <= 120) {
    return 1;
  }
  return 2;
}

export function parseShowinfoTimestamps(stderr: string): Map<number, number> {
  const timestamps = new Map<number, number>();
  const regex =
    /\[Parsed_showinfo[^\]]*\]\s+n:\s*(\d+)\s+pts:\s*\S+\s+pts_time:\s*([+-]?\d+(?:\.\d+)?)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(stderr)) !== null) {
    const frameNumber = Number(match[1]);
    const ptsTime = Number(match[2]);
    if (Number.isInteger(frameNumber) && frameNumber >= 0 && Number.isFinite(ptsTime)) {
      timestamps.set(frameNumber, roundTimestamp(Math.max(0, ptsTime)));
    }
  }
  return timestamps;
}

export interface ExtractFramesOptions {
  moviePath: string;
  outputDir: string;
  sampleStepSeconds: number;
  width: number;
  height: number;
  ffmpegBin?: string;
  signal?: AbortSignal;
}

interface CachedFramesManifest {
  sampleStepSeconds: number;
  frames: Array<{
    id: string;
    index: number;
    timestampSeconds: number;
    fileName: string;
  }>;
}

export async function extractSampledFrames(
  options: ExtractFramesOptions
): Promise<ExtractedFrame[]> {
  const manifestPath = path.join(options.outputDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = await fsp.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as CachedFramesManifest;
      if (
        parsed.sampleStepSeconds === options.sampleStepSeconds &&
        Array.isArray(parsed.frames) &&
        parsed.frames.length > 0
      ) {
        const resolved: ExtractedFrame[] = [];
        let allExist = true;
        for (const item of parsed.frames) {
          const filePath = path.join(options.outputDir, item.fileName);
          if (!fs.existsSync(filePath)) {
            allExist = false;
            break;
          }
          resolved.push({
            id: item.id,
            index: item.index,
            timestampSeconds: item.timestampSeconds,
            fileName: item.fileName,
            filePath
          });
        }
        if (allExist) {
          return resolved;
        }
      }
    } catch {
      // Re-extract if cache manifest is unreadable
    }
  }

  const tempExtractDir = `${options.outputDir}.tmp_${crypto.randomUUID().slice(0, 8)}`;
  await fsp.mkdir(tempExtractDir, { recursive: true });

  try {
    const targetDims = computeTargetFrameDimensions(options.width, options.height);
    const stepExpr = Number(options.sampleStepSeconds.toFixed(4));
    const filterChain = [
      `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${stepExpr})'`,
      "showinfo",
      `scale=${targetDims.width}:${targetDims.height}`
    ].join(",");

    const outputPattern = path.join(tempExtractDir, "frame_%d.jpg");

    const { stderr } = await runProcess(
      options.ffmpegBin ?? "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        options.moviePath,
        "-map",
        "0:v:0",
        "-vf",
        filterChain,
        "-fps_mode",
        "vfr",
        "-start_number",
        "0",
        "-q:v",
        "2",
        outputPattern,
        "-y"
      ],
      options.signal
    );

    const measuredTimestamps = parseShowinfoTimestamps(stderr);

    const files = fs
      .readdirSync(tempExtractDir)
      .filter((f) => /^frame_\d+\.jpg$/.test(f))
      .map((fileName) => {
        const match = /^frame_(\d+)\.jpg$/.exec(fileName);
        return {
          fileName,
          index: match ? Number(match[1]) : -1
        };
      })
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index);

    const manifestFrames: CachedFramesManifest["frames"] = [];
    for (const item of files) {
      const measuredTime = measuredTimestamps.get(item.index);
      if (measuredTime === undefined) {
        throw new AppError(
          "TIMESTAMP_MEASUREMENT_FAILED",
          `Failed to measure presentation timestamp for extracted frame_${item.index}.`,
          500
        );
      }
      manifestFrames.push({
        id: `frame_${item.index}`,
        index: item.index,
        timestampSeconds: measuredTime,
        fileName: item.fileName
      });
    }

    const manifest: CachedFramesManifest = {
      sampleStepSeconds: options.sampleStepSeconds,
      frames: manifestFrames
    };
    await fsp.writeFile(
      path.join(tempExtractDir, "manifest.json"),
      JSON.stringify(manifest),
      "utf8"
    );

    await fsp.mkdir(path.dirname(options.outputDir), { recursive: true });
    if (!fs.existsSync(manifestPath)) {
      await fsp.rm(options.outputDir, { recursive: true, force: true }).catch(() => undefined);
      await moveFileCrossDevice(tempExtractDir, options.outputDir);
    } else {
      await fsp.rm(tempExtractDir, { recursive: true, force: true }).catch(() => undefined);
    }

    return manifestFrames.map((item) => ({
      ...item,
      filePath: path.join(options.outputDir, item.fileName)
    }));
  } catch (err) {
    await fsp.rm(tempExtractDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
