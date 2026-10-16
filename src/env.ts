import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  apiKey: string;
  jevModel: string;
  jevApiBaseUrl: string;
  port: number;
  dataDir: string;
  windowSize: number;
  matchThreshold: number;
}

export function loadDotEnvFile(envFilePath = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(envFilePath)) {
    return;
  }
  const content = fs.readFileSync(envFilePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function resolveConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const apiKey = overrides.apiKey ?? process.env.TYPESAFE_API_KEY ?? "";
  const jevModel = (overrides.jevModel ?? process.env.JEV_MODEL ?? "jev-preview").trim() || "jev-preview";
  const jevApiBaseUrl = (
    overrides.jevApiBaseUrl ??
    process.env.TYPESAFE_API_BASE_URL ??
    "https://api.typesafe.ai"
  ).replace(/\/+$/, "");
  const parsedPort = Number(overrides.port ?? process.env.PORT ?? 3000);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
  const dataDir = overrides.dataDir ?? path.resolve(process.cwd(), ".data");
  const windowSize = overrides.windowSize ?? 4;
  const matchThreshold = overrides.matchThreshold ?? 0.5;

  return {
    apiKey,
    jevModel,
    jevApiBaseUrl,
    port,
    dataDir,
    windowSize,
    matchThreshold
  };
}

export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  let sanitized = message;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 4) {
      sanitized = sanitized.split(trimmed).join("[REDACTED]");
    }
  }
  return sanitized;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
