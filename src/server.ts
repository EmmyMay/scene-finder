import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { AppError, redactSecrets, resolveConfig } from "./env.js";
import { createTypeSafeJevScorer } from "./jev-client.js";
import {
  checkBinaryAvailable,
  chooseSampleStepSeconds,
  DEFAULT_MAX_SAMPLED_FRAMES,
  exportMovieClip,
  extractSampledFrames,
  moveFileCrossDevice,
  preparePlayableMovie,
  probeVideoFile
} from "./media.js";
import { groupFramesIntoScenes, roundTimestamp } from "./scene-grouping.js";
import type {
  ExtractedFrame,
  HealthResponse,
  JevScorer,
  MovieRecord,
  SceneResult,
  ScoredFrame,
  SearchError,
  SearchResponsePayload,
  SearchStatus
} from "./types.js";

export interface BackendServerOptions {
  host?: string;
  port?: number;
  apiKey?: string;
  getApiKey?: () => string | undefined;
  jevModel?: string;
  getJevModel?: () => string | undefined;
  jevApiBaseUrl?: string;
  apiToken?: string;
  dataDir?: string;
  publicDir?: string;
  ffmpegPath?: string;
  ffmpegBin?: string;
  ffprobePath?: string;
  ffprobeBin?: string;
  maxUploadBytes?: number;
  maxSampledFrames?: number;
  windowSize?: number;
  matchThreshold?: number;
  jevScorer?: JevScorer;
}

export interface RunningBackendServer {
  app: express.Express;
  server: http.Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface InternalSearchJob {
  id: string;
  movieId: string;
  query: string;
  status: SearchStatus;
  processed: number;
  total: number;
  sampleStepSeconds: number;
  results: SceneResult[];
  error?: SearchError;
  framesDir: string;
  abortController: AbortController;
}

function safeTimingEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function sanitizeAttachmentStem(name: string): string {
  const base = path.basename(name, path.extname(name));
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "scene";
}

export function createApp(options: BackendServerOptions = {}): {
  app: express.Express;
  cancelAllSearches(): void;
  waitForActiveOperations(): Promise<void>;
} {
  const baseConfig = resolveConfig({
    apiKey: options.apiKey,
    jevModel: options.jevModel,
    jevApiBaseUrl: options.jevApiBaseUrl,
    port: options.port,
    dataDir: options.dataDir,
    windowSize: options.windowSize,
    matchThreshold: options.matchThreshold
  });

  const getCurrentApiKey = (): string => {
    if (options.getApiKey) {
      return (options.getApiKey() ?? "").trim();
    }
    if (options.apiKey !== undefined) {
      return options.apiKey.trim();
    }
    return (process.env.TYPESAFE_API_KEY ?? "").trim();
  };

  const getCurrentModel = (): string => {
    if (options.getJevModel) {
      const m = options.getJevModel()?.trim();
      if (m) {
        return m;
      }
    }
    if (options.jevModel !== undefined && options.jevModel.trim()) {
      return options.jevModel.trim();
    }
    return (process.env.JEV_MODEL ?? baseConfig.jevModel ?? "jev-preview").trim() || "jev-preview";
  };

  const ffmpegBin = options.ffmpegPath ?? options.ffmpegBin ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobeBin =
    options.ffprobePath ?? options.ffprobeBin ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const publicDir = options.publicDir ?? path.resolve(process.cwd(), "public");
  const apiToken = options.apiToken?.trim() || "";
  const parsedMaxUpload = Number(
    options.maxUploadBytes ?? process.env.MAX_UPLOAD_BYTES ?? 2 * 1024 * 1024 * 1024
  );
  const maxUploadBytes =
    Number.isFinite(parsedMaxUpload) && parsedMaxUpload > 0
      ? Math.floor(parsedMaxUpload)
      : 2 * 1024 * 1024 * 1024;
  const parsedMaxFrames = Number(
    options.maxSampledFrames ?? process.env.MAX_SAMPLED_FRAMES ?? DEFAULT_MAX_SAMPLED_FRAMES
  );
  const maxSampledFrames =
    Number.isFinite(parsedMaxFrames) && parsedMaxFrames >= 1
      ? Math.floor(parsedMaxFrames)
      : DEFAULT_MAX_SAMPLED_FRAMES;

  const uploadsTmpDir = path.join(baseConfig.dataDir, "tmp");
  const clipsTmpDir = path.join(baseConfig.dataDir, "clips");
  const moviesBaseDir = path.join(baseConfig.dataDir, "movies");
  const searchesBaseDir = path.join(baseConfig.dataDir, "searches");
  fs.mkdirSync(uploadsTmpDir, { recursive: true });
  fs.mkdirSync(clipsTmpDir, { recursive: true });
  fs.mkdirSync(moviesBaseDir, { recursive: true });
  fs.mkdirSync(searchesBaseDir, { recursive: true });

  const jevScorer: JevScorer =
    options.jevScorer ??
    createTypeSafeJevScorer({
      apiKey: getCurrentApiKey,
      model: getCurrentModel,
      apiBaseUrl: baseConfig.jevApiBaseUrl
    });

  interface SharedExtractionEntry {
    abortController: AbortController;
    consumers: Set<AbortSignal>;
    promise: Promise<ExtractedFrame[]>;
  }

  const movies = new Map<string, MovieRecord>();
  const searches = new Map<string, InternalSearchJob>();
  const activePrepareControllers = new Set<AbortController>();
  const activeClipControllers = new Set<AbortController>();
  const activeStreams = new Set<fs.ReadStream>();
  const inFlightOperations = new Set<Promise<unknown>>();
  const frameExtractionLocks = new Map<string, SharedExtractionEntry>();

  function trackOperation<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => {
      inFlightOperations.delete(tracked);
    });
    inFlightOperations.add(tracked);
    return promise;
  }

  function trackReadStream(stream: fs.ReadStream): fs.ReadStream {
    activeStreams.add(stream);
    const cleanup = (): void => {
      activeStreams.delete(stream);
    };
    stream.once("close", cleanup);
    stream.once("end", cleanup);
    stream.once("error", cleanup);
    return stream;
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(uploadsTmpDir, { recursive: true });
        cb(null, uploadsTmpDir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || "") || ".bin";
        const tempName = `upload_${crypto.randomUUID()}${ext}`;
        (req as Request & { _tempUploadPath?: string })._tempUploadPath = path.join(
          uploadsTmpDir,
          tempName
        );
        cb(null, tempName);
      }
    }),
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 5,
      parts: 6,
      fieldSize: 16 * 1024
    }
  });

  const app = express();
  app.disable("x-powered-by");

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!apiToken) {
      next();
      return;
    }
    const provided = req.get("X-Scene-Finder-Token") ?? "";
    if (!provided || !safeTimingEqual(apiToken, provided)) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid X-Scene-Finder-Token header."
        }
      });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  // GET /api/health
  app.get("/api/health", async (_req: Request, res: Response) => {
    const [ffmpegOk, ffprobeOk] = await Promise.all([
      checkBinaryAvailable(ffmpegBin).catch(() => false),
      checkBinaryAvailable(ffprobeBin).catch(() => false)
    ]);
    const apiKeyOk = Boolean(options.jevScorer) || getCurrentApiKey().length > 0;
    const payload: HealthResponse = {
      ready: apiKeyOk && ffmpegOk && ffprobeOk,
      checks: {
        apiKey: apiKeyOk,
        ffmpeg: ffmpegOk,
        ffprobe: ffprobeOk
      }
    };
    res.status(200).json(payload);
  });

  // POST /api/movies
  app.post("/api/movies", (req: Request, res: Response, next: NextFunction) => {
    for (const prevController of activePrepareControllers) {
      prevController.abort();
    }
    activePrepareControllers.clear();

    const prepAbortController = new AbortController();
    activePrepareControllers.add(prepAbortController);

    const onDisconnect = (): void => {
      if (!res.writableEnded) {
        prepAbortController.abort();
      }
    };
    req.on("aborted", onDisconnect);
    res.on("close", onDisconnect);

    upload.single("file")(req, res, (uploadErr: unknown) => {
      void trackOperation(
        (async () => {
          const tempUploadPath =
            req.file?.path ?? (req as Request & { _tempUploadPath?: string })._tempUploadPath;

          const cleanupController = (): void => {
            req.removeListener("aborted", onDisconnect);
            res.removeListener("close", onDisconnect);
            activePrepareControllers.delete(prepAbortController);
          };

          if (uploadErr) {
            cleanupController();
            if (tempUploadPath) {
              await fsp.unlink(tempUploadPath).catch(() => undefined);
            }
            if (prepAbortController.signal.aborted) {
              return;
            }
            const multerCode = (uploadErr as { code?: string } | undefined)?.code;
            if (multerCode === "LIMIT_FILE_SIZE") {
              res.status(413).json({
                error: {
                  code: "UPLOAD_TOO_LARGE",
                  message: `Uploaded file exceeds maximum allowed size of ${maxUploadBytes} bytes.`
                }
              });
              return;
            }
            const msg =
              uploadErr instanceof Error ? uploadErr.message : "Failed to parse multipart upload.";
            res.status(400).json({
              error: {
                code: "INVALID_UPLOAD",
                message: redactSecrets(msg, [getCurrentApiKey(), apiToken])
              }
            });
            return;
          }

          const file = req.file;
          if (!file) {
            cleanupController();
            if (tempUploadPath) {
              await fsp.unlink(tempUploadPath).catch(() => undefined);
            }
            if (prepAbortController.signal.aborted) {
              return;
            }
            res.status(400).json({
              error: {
                code: "MISSING_FILE",
                message: "Multipart field 'file' is required."
              }
            });
            return;
          }

          const movieId = `mov_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const movieDir = path.join(moviesBaseDir, movieId);

          try {
            const initialProbed = await probeVideoFile(
              file.path,
              ffprobeBin,
              prepAbortController.signal
            );

            await fsp.mkdir(movieDir, { recursive: true });
            const originalName = path.basename(file.originalname || "movie.mp4");
            const ext = path.extname(originalName) || ".mp4";
            const sourcePath = path.join(movieDir, `source${ext}`);
            await moveFileCrossDevice(file.path, sourcePath);

            const playableTargetPath = path.join(movieDir, "playable.mp4");
            const prepared = await preparePlayableMovie({
              sourcePath,
              playableOutputPath: playableTargetPath,
              probed: initialProbed,
              ffmpegBin,
              ffprobeBin,
              signal: prepAbortController.signal
            });

            cleanupController();
            if (prepAbortController.signal.aborted) {
              await fsp.rm(movieDir, { recursive: true, force: true }).catch(() => undefined);
              return;
            }

            const record: MovieRecord = {
              id: movieId,
              name: originalName,
              durationSeconds: prepared.probed.durationSeconds,
              width: prepared.probed.width,
              height: prepared.probed.height,
              mediaUrl: `/api/movies/${movieId}/media`,
              sourceFilePath: sourcePath,
              filePath: prepared.playablePath,
              mimeType: "video/mp4",
              hasAudio: prepared.probed.hasAudio
            };

            movies.set(movieId, record);

            res.status(201).json({
              movie: {
                id: record.id,
                name: record.name,
                durationSeconds: record.durationSeconds,
                width: record.width,
                height: record.height,
                mediaUrl: record.mediaUrl
              }
            });
          } catch (err) {
            cleanupController();
            await fsp.unlink(file.path).catch(() => undefined);
            await fsp.rm(movieDir, { recursive: true, force: true }).catch(() => undefined);

            if (
              prepAbortController.signal.aborted ||
              (err instanceof Error && err.name === "AbortError")
            ) {
              if (!res.headersSent && !res.writableEnded) {
                res.status(499).json({
                  error: {
                    code: "UPLOAD_CANCELLED",
                    message: "Movie upload or playback preparation was cancelled."
                  }
                });
              }
              return;
            }
            next(err);
          }
        })()
      );
    });
  });

  // GET /api/movies/:id/media
  app.get("/api/movies/:id/media", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const movieId = String(req.params.id ?? "");
      const movie = movies.get(movieId);
      if (!movie || !fs.existsSync(movie.filePath)) {
        res.status(404).json({
          error: {
            code: "MOVIE_NOT_FOUND",
            message: "Movie not found."
          }
        });
        return;
      }

      const stat = await fsp.stat(movie.filePath);
      const fileSize = stat.size;
      const rangeHeader = req.headers.range;

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", movie.mimeType);

      if (!rangeHeader) {
        res.setHeader("Content-Length", String(fileSize));
        res.status(200);
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        const stream = trackReadStream(fs.createReadStream(movie.filePath));
        req.once("close", () => stream.destroy());
        stream.on("error", (err) => {
          if (!res.headersSent) {
            next(err);
          }
        });
        stream.pipe(res);
        return;
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match || (match[1] === "" && match[2] === "")) {
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        res.status(416).end();
        return;
      }

      let start: number;
      let end: number;

      if (match[1] === "") {
        const suffixLength = Number(match[2]);
        if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
          res.setHeader("Content-Range", `bytes */${fileSize}`);
          res.status(416).end();
          return;
        }
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
      } else {
        start = Number(match[1]);
        end = match[2] !== "" ? Number(match[2]) : fileSize - 1;
      }

      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        start >= fileSize ||
        start > end
      ) {
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        res.status(416).end();
        return;
      }

      end = Math.min(end, fileSize - 1);
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", String(chunkSize));

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const stream = trackReadStream(fs.createReadStream(movie.filePath, { start, end }));
      req.once("close", () => stream.destroy());
      stream.on("error", (err) => {
        if (!res.headersSent) {
          next(err);
        }
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/movies/:id/clips
  app.post("/api/movies/:id/clips", (req: Request, res: Response, next: NextFunction) => {
    void trackOperation(
      (async () => {
        const movieId = String(req.params.id ?? "");
        const movie = movies.get(movieId);
        if (!movie || !fs.existsSync(movie.filePath)) {
          res.status(404).json({
            error: {
              code: "MOVIE_NOT_FOUND",
              message: "Movie not found."
            }
          });
          return;
        }

        const startSeconds = req.body?.startSeconds;
        const endSeconds = req.body?.endSeconds;

        if (
          typeof startSeconds !== "number" ||
          !Number.isFinite(startSeconds) ||
          typeof endSeconds !== "number" ||
          !Number.isFinite(endSeconds) ||
          startSeconds < 0 ||
          startSeconds >= endSeconds ||
          endSeconds > movie.durationSeconds
        ) {
          res.status(400).json({
            error: {
              code: "INVALID_CLIP_RANGE",
              message: `Clip range must satisfy 0 <= startSeconds < endSeconds <= ${movie.durationSeconds}.`
            }
          });
          return;
        }

        const clipAbortController = new AbortController();
        activeClipControllers.add(clipAbortController);
        const outputClipPath = path.join(clipsTmpDir, `clip_${crypto.randomUUID()}.mp4`);

        const onDisconnect = (): void => {
          if (!res.writableEnded) {
            clipAbortController.abort();
          }
        };
        req.on("aborted", onDisconnect);
        res.on("close", onDisconnect);

        const cleanupClip = async (): Promise<void> => {
          req.removeListener("aborted", onDisconnect);
          res.removeListener("close", onDisconnect);
          activeClipControllers.delete(clipAbortController);
          await fsp.unlink(outputClipPath).catch(() => undefined);
        };

        try {
          await exportMovieClip({
            playableMoviePath: movie.filePath,
            outputClipPath,
            startSeconds,
            endSeconds,
            ffmpegBin,
            signal: clipAbortController.signal
          });

          if (clipAbortController.signal.aborted) {
            await cleanupClip();
            return;
          }

          const stat = await fsp.stat(outputClipPath);
          const stem = sanitizeAttachmentStem(movie.name);
          const startLabel = roundTimestamp(startSeconds).toFixed(2).replace(/\.?0+$/, "");
          const endLabel = roundTimestamp(endSeconds).toFixed(2).replace(/\.?0+$/, "");
          const downloadFileName = `${stem}-${startLabel}s-${endLabel}s.mp4`;

          res.status(200);
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Content-Disposition", `attachment; filename="${downloadFileName}"`);
          res.setHeader("Content-Length", String(stat.size));

          await new Promise<void>((resolve, reject) => {
            const stream = trackReadStream(fs.createReadStream(outputClipPath));
            const onAbortClip = (): void => {
              stream.destroy();
              if (!res.writableEnded) {
                res.destroy();
              }
              resolve();
            };
            clipAbortController.signal.addEventListener("abort", onAbortClip, { once: true });
            req.once("close", () => {
              stream.destroy();
              resolve();
            });
            stream.once("error", (err) => {
              clipAbortController.signal.removeEventListener("abort", onAbortClip);
              if (clipAbortController.signal.aborted) {
                resolve();
                return;
              }
              reject(err);
            });
            stream.once("close", () => {
              clipAbortController.signal.removeEventListener("abort", onAbortClip);
              resolve();
            });
            res.once("close", () => {
              clipAbortController.signal.removeEventListener("abort", onAbortClip);
              stream.destroy();
              resolve();
            });
            res.once("finish", () => {
              clipAbortController.signal.removeEventListener("abort", onAbortClip);
              resolve();
            });
            stream.pipe(res);
          });

          await cleanupClip();
        } catch (err) {
          await cleanupClip();
          if (
            clipAbortController.signal.aborted ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            return;
          }
          next(err);
        }
      })()
    );
  });

  // POST /api/movies/:id/search
  app.post("/api/movies/:id/search", (req: Request, res: Response, next: NextFunction) => {
    try {
      const movieId = String(req.params.id ?? "");
      const movie = movies.get(movieId);
      if (!movie) {
        res.status(404).json({
          error: {
            code: "MOVIE_NOT_FOUND",
            message: "Movie not found."
          }
        });
        return;
      }

      const rawQuery = req.body?.query;
      if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
        res.status(400).json({
          error: {
            code: "INVALID_QUERY",
            message: "A non-empty scene description query is required."
          }
        });
        return;
      }

      const query = rawQuery.trim();
      const sampleStepSeconds = chooseSampleStepSeconds(
        movie.durationSeconds,
        req.body?.sampleStepSeconds,
        maxSampledFrames
      );

      const searchId = `srch_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      // Reuse extracted frames per (movieId, sampleStepSeconds)
      const framesDir = path.join(
        moviesBaseDir,
        movie.id,
        `frames_step_${String(sampleStepSeconds).replace(".", "_")}`
      );
      const abortController = new AbortController();

      const job: InternalSearchJob = {
        id: searchId,
        movieId: movie.id,
        query,
        status: "queued",
        processed: 0,
        total: 0,
        sampleStepSeconds,
        results: [],
        framesDir,
        abortController
      };

      searches.set(searchId, job);

      void trackOperation(runSearchPipeline(job, movie));

      res.status(202).json({ searchId });
    } catch (err) {
      next(err);
    }
  });

  async function extractFramesWithCacheReuse(
    job: InternalSearchJob,
    movie: MovieRecord
  ): Promise<ExtractedFrame[]> {
    const consumerSignal = job.abortController.signal;
    if (consumerSignal.aborted) {
      const abortErr = new Error("Operation cancelled");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    const cacheKey = `${movie.id}:${job.sampleStepSeconds}`;
    let entry = frameExtractionLocks.get(cacheKey);
    if (entry && entry.abortController.signal.aborted) {
      frameExtractionLocks.delete(cacheKey);
      entry = undefined;
    }

    if (!entry) {
      const sharedAbortController = new AbortController();
      const consumers = new Set<AbortSignal>();
      let createdEntry: SharedExtractionEntry | undefined;
      const promise = extractSampledFrames({
        moviePath: movie.filePath,
        outputDir: job.framesDir,
        sampleStepSeconds: job.sampleStepSeconds,
        width: movie.width,
        height: movie.height,
        durationSeconds: movie.durationSeconds,
        maxFrames: maxSampledFrames,
        ffmpegBin,
        signal: sharedAbortController.signal
      }).finally(() => {
        if (frameExtractionLocks.get(cacheKey) === createdEntry) {
          frameExtractionLocks.delete(cacheKey);
        }
      });

      createdEntry = {
        abortController: sharedAbortController,
        consumers,
        promise
      };
      entry = createdEntry;
      frameExtractionLocks.set(cacheKey, createdEntry);
    }

    const currentEntry = entry;
    currentEntry.consumers.add(consumerSignal);

    return new Promise<ExtractedFrame[]>((resolve, reject) => {
      const onConsumerAbort = (): void => {
        currentEntry.consumers.delete(consumerSignal);
        if (currentEntry.consumers.size === 0) {
          if (frameExtractionLocks.get(cacheKey) === currentEntry) {
            frameExtractionLocks.delete(cacheKey);
          }
          currentEntry.abortController.abort();
        }
        const abortErr = new Error("Operation cancelled");
        abortErr.name = "AbortError";
        reject(abortErr);
      };

      consumerSignal.addEventListener("abort", onConsumerAbort, { once: true });

      currentEntry.promise.then(
        (frames) => {
          consumerSignal.removeEventListener("abort", onConsumerAbort);
          currentEntry.consumers.delete(consumerSignal);
          if (consumerSignal.aborted) {
            const abortErr = new Error("Operation cancelled");
            abortErr.name = "AbortError";
            reject(abortErr);
            return;
          }
          resolve(frames);
        },
        (err) => {
          consumerSignal.removeEventListener("abort", onConsumerAbort);
          currentEntry.consumers.delete(consumerSignal);
          reject(err);
        }
      );
    });
  }

  async function runSearchPipeline(job: InternalSearchJob, movie: MovieRecord): Promise<void> {
    const { signal } = job.abortController;
    const isCancelled = (): boolean => signal.aborted || job.status === "cancelled";

    try {
      if (isCancelled()) {
        job.status = "cancelled";
        return;
      }

      if (!options.jevScorer && getCurrentApiKey().length === 0) {
        throw new AppError(
          "MISSING_API_KEY",
          "TYPESAFE_API_KEY is not configured. Add your Jev API key before searching.",
          503
        );
      }

      job.status = "extracting";

      const extractedFrames = await extractFramesWithCacheReuse(job, movie);

      if (isCancelled()) {
        job.status = "cancelled";
        return;
      }

      if (extractedFrames.length === 0) {
        throw new AppError(
          "FRAME_EXTRACTION_EMPTY",
          "No video frames could be extracted from the supplied movie.",
          422
        );
      }

      job.total = extractedFrames.length;
      job.processed = 0;
      job.status = "searching";

      const windowSize = Math.max(1, baseConfig.windowSize);
      const scoredFrames: ScoredFrame[] = [];

      for (let i = 0; i < extractedFrames.length; i += windowSize) {
        if (isCancelled()) {
          job.status = "cancelled";
          return;
        }

        const windowFrames = extractedFrames.slice(i, i + windowSize);
        const windowScores = await jevScorer.scoreFrameWindow({
          movieId: movie.id,
          movieName: movie.name,
          query: job.query,
          frames: windowFrames,
          signal
        });

        if (isCancelled()) {
          job.status = "cancelled";
          return;
        }

        for (const frame of windowFrames) {
          const score = windowScores[frame.id];
          if (typeof score !== "number" || !Number.isFinite(score)) {
            throw new AppError(
              "JEV_INVALID_RESPONSE",
              `Missing valid Noul score for frame '${frame.id}'.`,
              502
            );
          }
          scoredFrames.push({
            ...frame,
            noul: score
          });
        }

        job.processed = scoredFrames.length;
        job.results = groupFramesIntoScenes(scoredFrames, {
          sampleStepSeconds: job.sampleStepSeconds,
          searchId: job.id,
          threshold: baseConfig.matchThreshold
        });
      }

      if (isCancelled()) {
        job.status = "cancelled";
        return;
      }

      job.status = "completed";
    } catch (err) {
      if (isCancelled() || (err instanceof Error && err.name === "AbortError")) {
        job.status = "cancelled";
        return;
      }

      const code = err instanceof AppError ? err.code : "SEARCH_FAILED";
      const rawMessage =
        err instanceof Error ? err.message : "An unexpected error occurred during scene search.";
      job.status = "failed";
      job.error = {
        code,
        message: redactSecrets(rawMessage, [getCurrentApiKey(), apiToken])
      };
    }
  }

  // GET /api/searches/:searchId
  app.get("/api/searches/:searchId", (req: Request, res: Response) => {
    const searchId = String(req.params.searchId ?? "");
    const job = searches.get(searchId);
    if (!job) {
      res.status(404).json({
        error: {
          code: "SEARCH_NOT_FOUND",
          message: "Search not found."
        }
      });
      return;
    }

    const payload: SearchResponsePayload = {
      id: job.id,
      movieId: job.movieId,
      query: job.query,
      status: job.status,
      processed: job.processed,
      total: job.total,
      sampleStepSeconds: job.sampleStepSeconds,
      results: job.results
    };

    if (job.error) {
      payload.error = job.error;
    }

    res.status(200).json(payload);
  });

  // DELETE /api/searches/:searchId
  app.delete("/api/searches/:searchId", (req: Request, res: Response) => {
    const searchId = String(req.params.searchId ?? "");
    const job = searches.get(searchId);
    if (!job) {
      res.status(404).json({
        error: {
          code: "SEARCH_NOT_FOUND",
          message: "Search not found."
        }
      });
      return;
    }

    if (
      job.status === "queued" ||
      job.status === "extracting" ||
      job.status === "searching"
    ) {
      job.status = "cancelled";
      job.abortController.abort();
    }

    res.status(200).json({ ok: true });
  });

  // GET /api/searches/:searchId/thumbnails/:frameFile
  app.get(
    "/api/searches/:searchId/thumbnails/:frameFile",
    (req: Request, res: Response, next: NextFunction) => {
      const searchId = String(req.params.searchId ?? "");
      const frameFile = String(req.params.frameFile ?? "");
      const job = searches.get(searchId);
      if (!job) {
        res.status(404).json({
          error: {
            code: "SEARCH_NOT_FOUND",
            message: "Search not found."
          }
        });
        return;
      }

      if (!/^frame_\d+\.jpg$/.test(frameFile)) {
        res.status(400).json({
          error: {
            code: "INVALID_THUMBNAIL",
            message: "Invalid thumbnail filename."
          }
        });
        return;
      }

      const filePath = path.join(job.framesDir, frameFile);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({
          error: {
            code: "THUMBNAIL_NOT_FOUND",
            message: "Thumbnail file not found."
          }
        });
        return;
      }

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      const stream = trackReadStream(fs.createReadStream(filePath));
      req.once("close", () => stream.destroy());
      stream.on("error", (err) => {
        if (!res.headersSent) {
          next(err);
        }
      });
      stream.pipe(res);
    }
  );

  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = err instanceof AppError ? err.statusCode : 500;
    const code = err instanceof AppError ? err.code : "INTERNAL_ERROR";
    const rawMessage = err instanceof Error ? err.message : "Internal server error.";
    res.status(statusCode).json({
      error: {
        code,
        message: redactSecrets(rawMessage, [getCurrentApiKey(), apiToken])
      }
    });
  });

  const cancelAllSearches = (): void => {
    for (const job of searches.values()) {
      if (
        job.status === "queued" ||
        job.status === "extracting" ||
        job.status === "searching"
      ) {
        job.status = "cancelled";
        job.abortController.abort();
      }
    }
    for (const entry of frameExtractionLocks.values()) {
      entry.abortController.abort();
    }
    frameExtractionLocks.clear();
    for (const ctrl of activePrepareControllers) {
      ctrl.abort();
    }
    activePrepareControllers.clear();
    for (const ctrl of activeClipControllers) {
      ctrl.abort();
    }
    activeClipControllers.clear();
    for (const stream of activeStreams) {
      stream.destroy();
    }
    activeStreams.clear();
  };

  const waitForActiveOperations = async (): Promise<void> => {
    if (inFlightOperations.size === 0) {
      return;
    }
    await Promise.allSettled([...inFlightOperations]);
  };

  return { app, cancelAllSearches, waitForActiveOperations };
}

export async function startServer(
  options: BackendServerOptions = {}
): Promise<RunningBackendServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort =
    options.port !== undefined ? options.port : Number(process.env.PORT ?? 3000) || 3000;

  const { app, cancelAllSearches, waitForActiveOperations } = createApp(options);
  const server = http.createServer(app);
  const sockets = new Set<Socket>();

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const boundPort = address.port;
  const boundHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${boundHost}:${boundPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    cancelAllSearches();

    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();

    await waitForActiveOperations();

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  };

  return {
    app,
    server,
    host: boundHost,
    port: boundPort,
    url,
    close
  };
}
