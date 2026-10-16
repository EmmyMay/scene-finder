import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./env.js";
import { roundTimestamp } from "./scene-grouping.js";
import type { ExtractedFrame } from "./types.js";

export interface ProbedVideoInfo {
  durationSeconds: number;
  width: number;
  height: number;
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
  ffprobeBin = "ffprobe"
): Promise<ProbedVideoInfo> {
  let probeJson: {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      duration?: string | number;
    }>;
    format?: {
      duration?: string | number;
    };
  };

  try {
    const { stdout } = await runProcess(ffprobeBin, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_type,width,height,duration:format=duration",
      "-of",
      "json",
      filePath
    ]);
    probeJson = JSON.parse(stdout);
  } catch {
    throw new AppError(
      "INVALID_MOVIE",
      "Uploaded file could not be inspected as a valid video file.",
      400
    );
  }

  const stream = probeJson.streams?.[0];
  if (!stream || stream.codec_type !== "video") {
    throw new AppError("INVALID_MOVIE", "Uploaded file does not contain a video stream.", 400);
  }

  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new AppError("INVALID_MOVIE", "Video stream has invalid width or height.", 400);
  }

  let durationSeconds = Number(stream.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = Number(probeJson.format?.duration);
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    // Fallback: inspect packet timestamps if container header lacks duration
    try {
      const { stdout: packetOut } = await runProcess(ffprobeBin, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time,duration_time",
        "-of",
        "json",
        filePath
      ]);
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
    } catch {
      // Ignore fallback error; checked below
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
    height
  };
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

  // Ensure even dimensions for encoder compatibility while staying inside [280, 1568]
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
  // Keep frame count reasonable for longer videos (~120-180 samples)
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
