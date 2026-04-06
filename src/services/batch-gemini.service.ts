import { GoogleGenAI } from "@google/genai";
import { promises as fsPromises } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import {
  ImageProcessingError,
  ImageErrorCode,
  ErrorMessages,
  parseGeminiError,
} from "../utils/imageErrors";

const BATCH_POLL_INTERVAL_MS = Number(process.env.GEMINI_BATCH_POLL_INTERVAL_MS || "5000");
const BATCH_MAX_WAIT_MS = Number(process.env.GEMINI_BATCH_MAX_WAIT_MS || "120000");
const GEMINI_BATCH_IMAGE_MODEL = String(
  process.env.GEMINI_BATCH_IMAGE_MODEL || "gemini-2.5-flash-image"
).trim();

type BatchRequestLine = {
  key: string;
  request: any;
};

type BatchSubmission = {
  jobName: string;
  mode: "inline" | "file";
};

export class BatchGeminiService {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".heic": "image/heic",
      ".jfif": "image/jfif",
    };
    return mimeTypes[ext] || "image/jpeg";
  }

  private extractAllImagesFromResponse(response: any): Buffer[] {
    if (!response?.candidates?.length) {
      return [];
    }

    const images: Buffer[] = [];

    for (const candidate of response.candidates) {
      for (const part of candidate?.content?.parts || []) {
        if (part?.inlineData?.data) {
          images.push(Buffer.from(part.inlineData.data, "base64"));
        }
      }
    }

    return images;
  }

  private resolveResponsePayload(line: any): any {
    return (
      line?.response?.response ||
      line?.response?.body ||
      line?.response ||
      null
    );
  }

  private resolveResponseKey(line: any, fallbackIndex: number): string {
    return String(line?.key || line?.custom_id || `line-${fallbackIndex}`);
  }

  private async submitBatch(requestLines: BatchRequestLine[]): Promise<BatchSubmission> {
    const inlineRequests = requestLines.map((line) => line.request);
    const inlinePayloadSize = Buffer.byteLength(JSON.stringify(inlineRequests), "utf8");
    const canUseInline = inlinePayloadSize <= 18 * 1024 * 1024;

    if (canUseInline) {
      const inlineBatchJob = await this.client.batches.create({
        model: GEMINI_BATCH_IMAGE_MODEL,
        src: inlineRequests,
        config: {
          display_name: `staging-inline-${Date.now()}`,
        },
      } as any);

      if (!inlineBatchJob?.name) {
        throw new Error("Failed to create Gemini inline batch job.");
      }

      logger(`[GEMINI BATCH] Using inline batch mode (${Math.round(inlinePayloadSize / 1024)} KB payload)`);
      return {
        jobName: inlineBatchJob.name,
        mode: "inline",
      };
    }

    const jsonl = requestLines.map((line) => JSON.stringify(line)).join("\n");
    const tempDir = path.join(process.cwd(), "uploads", "batch-temp");
    await fsPromises.mkdir(tempDir, { recursive: true });

    const tempFilePath = path.join(tempDir, `gemini-staging-${Date.now()}.jsonl`);
    await fsPromises.writeFile(tempFilePath, jsonl, "utf8");

    try {
      const fileBuffer = await fsPromises.readFile(tempFilePath);
      const jsonlFile = new File([fileBuffer], path.basename(tempFilePath), {
        type: "application/x-jsonl",
      });

      const uploadedFile = await this.client.files.upload({
        file: jsonlFile,
      } as any);

      const batchJob = await this.client.batches.create({
        model: GEMINI_BATCH_IMAGE_MODEL,
        src: uploadedFile.name,
        config: {
          display_name: `staging-${Date.now()}`,
        },
      } as any);

      if (!batchJob?.name) {
        throw new Error("Failed to create Gemini batch job.");
      }

      logger(`[GEMINI BATCH] Using file batch mode (${Math.round(inlinePayloadSize / 1024)} KB payload)`);
      return {
        jobName: batchJob.name,
        mode: "file",
      };
    } finally {
      fsPromises.unlink(tempFilePath).catch(() => undefined);
    }
  }

  private normalizeBatchStateName(batch: any): string {
    return String(batch?.state?.name || batch?.state || "");
  }

  private isSucceededState(state: string): boolean {
    return state === "JOB_STATE_SUCCEEDED" || state === "SUCCEEDED" || state === "DONE";
  }

  private isFailedState(state: string): boolean {
    return (
      state === "JOB_STATE_FAILED" ||
      state === "FAILED" ||
      state === "JOB_STATE_CANCELLED" ||
      state === "CANCELLED" ||
      state === "JOB_STATE_EXPIRED" ||
      state === "EXPIRED"
    );
  }

  private extractDestinationFileName(batch: any): string | null {
    return (
      batch?.dest?.file_name ||
      batch?.dest?.fileName ||
      batch?.dest?.name ||
      null
    );
  }

  private async waitForBatchCompletion(jobName: string): Promise<any> {
    const startedAt = Date.now();
    let pollCount = 0;

    while (Date.now() - startedAt < BATCH_MAX_WAIT_MS) {
      pollCount++;
      const batch = await this.client.batches.get({ name: jobName } as any);
      const state = this.normalizeBatchStateName(batch);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

      logger(`[GEMINI BATCH] Poll #${pollCount} state=${state || "UNKNOWN"} elapsed=${elapsedSec}s`);

      if (this.isSucceededState(state)) {
        return batch;
      }

      if (this.isFailedState(state)) {
        throw new Error(
          `Gemini batch job failed with state: ${state}. Details: ${JSON.stringify(batch?.error || {})}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL_MS));
    }

    throw new ImageProcessingError(
      ImageErrorCode.AI_TIMEOUT,
      ErrorMessages[ImageErrorCode.AI_TIMEOUT],
      504,
      `Gemini batch job timed out after ${Math.round(BATCH_MAX_WAIT_MS / 1000)}s. Batch API is asynchronous and may take much longer under load.`
    );
  }

  private async fetchBatchResults(resultFileName: string): Promise<{
    byKey: Map<string, Buffer>;
    allImages: Buffer[];
  }> {
    const downloaded = await this.client.files.download({ name: resultFileName } as any);

    const contentBuffer = Buffer.isBuffer(downloaded)
      ? downloaded
      : Buffer.from(downloaded as any);

    const lines = contentBuffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const results = new Map<string, Buffer>();
    const allImages: Buffer[] = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed?.error) {
        logger(`[GEMINI BATCH] Request ${parsed.key || "unknown"} failed: ${JSON.stringify(parsed.error)}`);
        continue;
      }

      const key = this.resolveResponseKey(parsed, lineIdx);
      const responsePayload = this.resolveResponsePayload(parsed);
      const images = this.extractAllImagesFromResponse(responsePayload);

      if (images.length > 0) {
        results.set(key, images[0]);
        allImages.push(...images);
      }
    }

    return {
      byKey: results,
      allImages,
    };
  }

  private fetchInlineBatchResults(
    completedBatch: any,
    requestLines: BatchRequestLine[]
  ): {
    byKey: Map<string, Buffer>;
    allImages: Buffer[];
  } {
    const inlinedResponses =
      completedBatch?.dest?.inlined_responses ||
      completedBatch?.dest?.inlinedResponses ||
      [];

    const results = new Map<string, Buffer>();
    const allImages: Buffer[] = [];

    for (let idx = 0; idx < inlinedResponses.length; idx++) {
      const inlineResponse = inlinedResponses[idx];
      if (inlineResponse?.error) {
        logger(`[GEMINI BATCH] Inline request ${idx} failed: ${JSON.stringify(inlineResponse.error)}`);
        continue;
      }

      const payload = this.resolveResponsePayload(inlineResponse);
      const images = this.extractAllImagesFromResponse(payload);
      if (!images.length) {
        continue;
      }

      const key = requestLines[idx]?.key || `variation-${idx}`;
      results.set(key, images[0]);
      allImages.push(...images);
    }

    return {
      byKey: results,
      allImages,
    };
  }

  async generateStagedVariations(
    inputImagePath: string,
    prompts: string[]
  ): Promise<Buffer[]> {
    if (!prompts.length) {
      return [];
    }

    logger(`[GEMINI BATCH] Starting batch generation with ${prompts.length} prompts`);
    logger(`[GEMINI BATCH] Note: Batch API is async and may take longer than interactive calls under system load.`);

    const sourceImage = await fsPromises.readFile(inputImagePath);
    const mimeType = this.getMimeType(inputImagePath);
    const base64Image = sourceImage.toString("base64");

    const requestLines: BatchRequestLine[] = prompts.map((prompt, index) => ({
      key: `variation-${index}`,
      request: {
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: base64Image,
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          temperature: 0.7,
        },
      },
    }));

    try {
      const submission = await this.submitBatch(requestLines);
      logger(`[GEMINI BATCH] Batch submitted with name: ${submission.jobName} (mode=${submission.mode})`);

      const completedBatch = await this.waitForBatchCompletion(submission.jobName);

      const result = submission.mode === "inline"
        ? this.fetchInlineBatchResults(completedBatch, requestLines)
        : await (async () => {
            const resultFileName = this.extractDestinationFileName(completedBatch);
            if (!resultFileName) {
              throw new Error("Batch completed but no result file was provided.");
            }
            return this.fetchBatchResults(resultFileName);
          })();
      logger(`[GEMINI BATCH] Parsed ${result.byKey.size} keyed results and ${result.allImages.length} total image parts`);

      const ordered = requestLines
        .map((line) => result.byKey.get(line.key) || null)
        .filter((item): item is Buffer => Boolean(item));

      if (ordered.length < requestLines.length && result.allImages.length > ordered.length) {
        const seen = new Set(ordered.map((img) => img.toString("base64")));
        for (const image of result.allImages) {
          const fingerprint = image.toString("base64");
          if (!seen.has(fingerprint)) {
            ordered.push(image);
            seen.add(fingerprint);
          }
          if (ordered.length >= requestLines.length) {
            break;
          }
        }
      }

      if (ordered.length < requestLines.length) {
        throw new ImageProcessingError(
          ImageErrorCode.AI_NO_IMAGE_GENERATED,
          ErrorMessages[ImageErrorCode.AI_NO_IMAGE_GENERATED],
          502,
          `Gemini Batch API returned ${ordered.length}/${requestLines.length} staged images.`
        );
      }

      if (ordered.length === 0) {
        throw new ImageProcessingError(
          ImageErrorCode.AI_NO_IMAGE_GENERATED,
          ErrorMessages[ImageErrorCode.AI_NO_IMAGE_GENERATED],
          500,
          "Gemini Batch API did not return any staged images."
        );
      }

      return ordered;
    } catch (error) {
      logger(`[GEMINI BATCH] Error in batch generation: ${String(error)}`);
      throw error instanceof ImageProcessingError ? error : parseGeminiError(error);
    }
  }
}
