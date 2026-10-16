export type SearchStatus =
  | "queued"
  | "extracting"
  | "searching"
  | "completed"
  | "cancelled"
  | "failed";

export interface SearchError {
  code: string;
  message: string;
}

export interface MovieMetadata {
  id: string;
  name: string;
  durationSeconds: number;
  width: number;
  height: number;
  mediaUrl: string;
}

export interface MovieRecord extends MovieMetadata {
  filePath: string;
  mimeType: string;
}

export interface SceneResult {
  id: string;
  startSeconds: number;
  endSeconds: number;
  peakTimestampSeconds: number;
  score: number;
  thumbnailUrl: string;
}

export interface SearchResponsePayload {
  id: string;
  movieId: string;
  query: string;
  status: SearchStatus;
  processed: number;
  total: number;
  sampleStepSeconds: number;
  results: SceneResult[];
  error?: SearchError;
}

export interface ExtractedFrame {
  id: string;
  index: number;
  timestampSeconds: number;
  filePath: string;
  fileName: string;
}

export interface ScoredFrame extends ExtractedFrame {
  noul: number;
}

export interface FrameWindowScoreInput {
  movieId: string;
  movieName: string;
  query: string;
  frames: ExtractedFrame[];
  signal: AbortSignal;
}

export interface JevScorer {
  scoreFrameWindow(input: FrameWindowScoreInput): Promise<Record<string, number>>;
}

export interface HealthResponse {
  ready: boolean;
  checks: {
    apiKey: boolean;
    ffmpeg: boolean;
    ffprobe: boolean;
  };
}
