import { spawn } from "node:child_process";
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
}

export async function checkBinaryAvailable(binary: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(binary, ["-version"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 4000);

    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
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

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    const onAbort = (): void => {
      child.kill("SIGKILL");
      const abortErr = new Error("Operation cancelled");
      abortErr.name = "AbortError";
      reject(abortErr);
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
      reject(err);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
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
  const videoStream = streams.find((s) => s.codec_type === "video");
  if (!videoStream) {
    throw new AppError("INVALID_MOVIE", "Uploaded file does not contain a video stream.", 400);
  }

  const audioStream = streams.find((s) => s.codec_type === "audio");

  const width = Number(videoStream.width);
  const height = Number(videoStream.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new AppError("INVALID_MOVIE", "Video stream has invalid width or height.", 400);
  }

  let durationSeconds = Number(videoStream.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = Number(probeJson.format?.duration);
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    // Fallback: inspect packet timestamps if container header lacks duration (common in MKV/WebM)
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
    hasAudio: Boolean(audioStream)
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
 * Ensures the movie is in a Chromium-playable H.264/AAC MP4 container:
 * - If already an MP4 container with H.264 (yuv420p) video and AAC (or no) audio, uses it directly.
 * - If video is already H.264 (yuv420p) inside MKV/MOV/etc., tries fast remuxing first (copying video, copying/encoding AAC audio).
 * - Otherwise transcodes to H.264 (yuv420p) + AAC MP4 with +faststart.
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

  if (isMp4Container && isCompatibleH264 && isCompatibleAudio) {
    return {
      playablePath: options.sourcePath,
      probed: options.probed
    };
  }

  try {
    if (isCompatibleH264) {
      // Fast remux path for MKV/MOV containing H.264 video
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
        // Fall through to full H.264/AAC transcode if container remux fails
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

/**
 * Exports an accurate H.264/AAC MP4 clip from `[startSeconds, endSeconds]`, preserving available audio.
 */
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

/**
 * TypeSafe Jev image API requires each dimension in [280, 1568]
 * and total pixels in [78_400, 2_458_624].
 */
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

export function chooseSampleStepSeconds(
  durationSeconds: number,
  requestedStepSeconds?: number
): number {
  if (
    typeof requestedStepSeconds === "number" &&
    Number.isFinite(requestedStepSeconds) &&
    requestedStepSeconds > 0
  ) {
    return roundTimestamp(requestedStepSeconds);
  }

  if (durationSeconds <= 2) {
    return 0.5;
  }
  if (durationSeconds <= 180) {
    return 1;
  }
  return Math.max(1, Math.ceil(durationSeconds / 150));
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

export async function extractSampledFrames(
  options: ExtractFramesOptions
): Promise<ExtractedFrame[]> {
  fs.mkdirSync(options.outputDir, { recursive: true });

  const targetDims = computeTargetFrameDimensions(options.width, options.height);
  const stepExpr = Number(options.sampleStepSeconds.toFixed(4));
  const filterChain = [
    `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${stepExpr})'`,
    "showinfo",
    `scale=${targetDims.width}:${targetDims.height}`
  ].join(",");

  const outputPattern = path.join(options.outputDir, "frame_%d.jpg");

  const { stderr } = await runProcess(
    options.ffmpegBin ?? "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      options.moviePath,
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
    .readdirSync(options.outputDir)
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

  const extracted: ExtractedFrame[] = [];
  for (const item of files) {
    const measuredTime = measuredTimestamps.get(item.index);
    if (measuredTime === undefined) {
      throw new AppError(
        "TIMESTAMP_MEASUREMENT_FAILED",
        `Failed to measure presentation timestamp for extracted frame_${item.index}.`,
        500
      );
    }
    const id = `frame_${item.index}`;
    extracted.push({
      id,
      index: item.index,
      timestampSeconds: measuredTime,
      fileName: item.fileName,
      filePath: path.join(options.outputDir, item.fileName)
    });
  }

  return extracted;
}
