import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";

export interface SingleImageTrace {
  traceId: string;
  filePath: string;
  append: (step: string, details?: Record<string, unknown>) => Promise<void>;
}

function toRelativeLogPath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).replace(/\\/g, "/");
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("token") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("password") ||
    normalized.includes("secret")
  );
}

function sanitize(value: unknown, keyHint = ""): unknown {
  if (shouldRedactKey(keyHint)) {
    return "[REDACTED]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (value.length > 4000) {
      return `${value.slice(0, 4000)}...[truncated ${value.length - 4000} chars]`;
    }
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }

  const output: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sanitize(val, key);
  }
  return output;
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(sanitize(value), null, 2);
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) }, null, 2);
  }
}

export async function createSingleImageTrace(initialContext: Record<string, unknown>): Promise<SingleImageTrace> {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const traceId = `${timestamp}-${randomSuffix}`;

  const traceDir = path.join(process.cwd(), "logs", "single-image-staging");
  await fs.promises.mkdir(traceDir, { recursive: true });

  const filePath = path.join(traceDir, `single-image-stage-${traceId}.md`);
  const header = [
    "# Single Image Staging Trace",
    "",
    `- Trace ID: ${traceId}`,
    `- Created At: ${new Date().toISOString()}`,
    "",
    "## Initial Context",
    "```json",
    stringifySafe(initialContext),
    "```",
    "",
  ].join("\n");

  await fs.promises.writeFile(filePath, header, "utf8");
  logger(`[TRACE] Created single-image trace: ${toRelativeLogPath(filePath)}`);

  const append = async (step: string, details: Record<string, unknown> = {}): Promise<void> => {
    const block = [
      `## ${new Date().toISOString()} | ${step}`,
      "```json",
      stringifySafe(details),
      "```",
      "",
    ].join("\n");

    try {
      await fs.promises.appendFile(filePath, block, "utf8");
    } catch (error) {
      logger(`[TRACE] Failed to append trace block: ${String(error)}`);
    }
  };

  return { traceId, filePath, append };
}

export function getRelativeTracePath(filePath: string): string {
  return toRelativeLogPath(filePath);
}
