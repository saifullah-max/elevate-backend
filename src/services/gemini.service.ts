import { promises as fsPromises } from "fs";
import * as path from "path";
import sharp from "sharp";
import { logger } from "../utils/logger";
import { RateLimiter } from "../utils/rateLimiter";
import { DEFAULT_STAGING_PROMPT, STAGING_STYLE_PROMPTS } from "../utils/stagingPrompts";
import {
  ImageProcessingError,
  ImageErrorCode,
  ErrorMessages,
  parseGeminiError,
} from "../utils/imageErrors";

const GEMINI_STAGING_MAX_RETRIES = Number(process.env.GEMINI_STAGING_MAX_RETRIES || "1");
const GEMINI_RETRY_BASE_DELAY_MS = Number(process.env.GEMINI_RETRY_BASE_DELAY_MS || "300");
const GEMINI_RETRY_MAX_DELAY_MS = Number(process.env.GEMINI_RETRY_MAX_DELAY_MS || "1800");
const GEMINI_STAGING_RATE_LIMIT = Number(process.env.GEMINI_STAGING_RATE_LIMIT_PER_MINUTE || "10");
// MARK: Set GEMINI_STAGING_MODEL=gemini-3-pro-image-preview to use Gemini 3 Pro image preview.
const GEMINI_STAGING_MODEL = String(process.env.GEMINI_STAGING_MODEL).trim();
const GEMINI_STAGING_STRICT_STRUCTURE =
  String(process.env.GEMINI_STAGING_STRICT_STRUCTURE || "true").toLowerCase() === "true";
const GEMINI_STAGING_FORCE_VISIBLE =
  String(process.env.GEMINI_STAGING_FORCE_VISIBLE || "true").toLowerCase() === "true";
const GEMINI_STAGING_VERBOSE_LOGS =
  String(process.env.GEMINI_STAGING_VERBOSE_LOGS || "true").toLowerCase() === "true";
const GEMINI_MAX_VARIATIONS = Number(process.env.GEMINI_MAX_VARIATIONS || "1");
const GEMINI_STAGING_MAX_INPUT_EDGE = Number(process.env.GEMINI_STAGING_MAX_INPUT_EDGE || "2048");
const GEMINI_STAGING_JPEG_QUALITY = Number(process.env.GEMINI_STAGING_JPEG_QUALITY || "88");

const GEMINI_ANALYSIS_MODEL = String(process.env.GEMINI_ANALYSIS_MODEL || "gemini-2.0-flash").trim();
const GEMINI_ANALYSIS_MAX_IMAGE_EDGE = Number(process.env.GEMINI_ANALYSIS_MAX_IMAGE_EDGE || "1024");
const GEMINI_ANALYSIS_MAX_RETRIES = Number(process.env.GEMINI_ANALYSIS_MAX_RETRIES || "1");

const geminiStagingRateLimiter = new RateLimiter(GEMINI_STAGING_RATE_LIMIT, 60000);

type GeminiClientLike = {
  models: {
    generateContent: (request: any) => Promise<any>;
  };
};

async function downscaleForApi(
  input: Buffer,
  maxEdge: number,
  originalMime: string,
  jpegQuality: number
): Promise<{ buffer: Buffer; mimeType: string; didResize: boolean }> {
  if (maxEdge <= 0 || !input.length) {
    return { buffer: input, mimeType: originalMime, didResize: false };
  }

  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h || (w <= maxEdge && h <= maxEdge)) {
    return { buffer: input, mimeType: originalMime, didResize: false };
  }

  const q = Math.max(60, Math.min(100, jpegQuality));
  const out = await sharp(input)
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: q, mozjpeg: true })
    .toBuffer();

  return { buffer: out, mimeType: "image/jpeg", didResize: true };
}

class GeminiService {
  private geminiClient: GeminiClientLike | null = null;
  private geminiClientInitPromise: Promise<void> | null = null;
  private geminiApiKey: string;

  constructor() {
    this.geminiApiKey = process.env.GEMINI_API_KEY || "";
    if (!this.geminiApiKey) {
      throw new Error("GEMINI_API_KEY is not set in environment variables");
    }
  }

  private async ensureGeminiClient(): Promise<GeminiClientLike> {
    if (this.geminiClient) {
      return this.geminiClient;
    }

    if (!this.geminiClientInitPromise) {
      this.geminiClientInitPromise = (async () => {
        const genAiModule = await import("@google/genai");
        this.geminiClient = new genAiModule.GoogleGenAI({ apiKey: this.geminiApiKey });
      })();
    }

    await this.geminiClientInitPromise;
    if (!this.geminiClient) {
      throw new Error("Failed to initialize Gemini client");
    }

    return this.geminiClient;
  }

  private buildStagingPrompt(roomType: string, stagingStyle: string, prompt?: string): string {
    const groundingRules = GEMINI_STAGING_STRICT_STRUCTURE
      ? "Use the PROVIDED IMAGE as the only source scene. STRICTLY preserve architecture and composition: identical room geometry, camera angle, ceiling design, ceiling lights, LED/light holders, wall colors/paint, windows, doors, floor tile/marble pattern, and lighting direction. Do NOT alter layout of fixed structural elements. Do NOT generate a new room."
      : "Use the PROVIDED IMAGE as the source scene. Keep the same room geometry, camera angle, walls, windows, doors, and floor layout. Do not generate a new room. Return one realistic staged image that preserves architecture.";

    const furnishingDirective =
      "Apply complete, listing-ready staging by changing only movable decor/furniture: sofa/chairs/tables/bedside pieces/rugs/curtains/art accessories/plants. You may restyle furniture arrangement and decor composition, but keep structural architecture untouched. The result must look clearly staged and premium while realistic, not like a minor touch-up.";

    const visibleChangeDirective = GEMINI_STAGING_FORCE_VISIBLE
      ? "Ensure visible upgrade: add or replace a substantial set of furniture and decor (not 1-2 tiny changes). Keep pathways usable and scale realistic for the room."
      : "";

    let stagingPrompt: string;

    if (prompt) {
      const doNotRemove =
        "Do not remove existing paintings or wall art unless explicitly requested. Improve furnishings and decor while preserving structural elements.";
      stagingPrompt = `${doNotRemove}\n${furnishingDirective}\n${visibleChangeDirective}\n${prompt}`;
    } else if (STAGING_STYLE_PROMPTS[stagingStyle?.toLowerCase()]) {
      stagingPrompt = `${furnishingDirective}\n${visibleChangeDirective}\n${STAGING_STYLE_PROMPTS[stagingStyle.toLowerCase()](roomType)}`;
    } else {
      stagingPrompt = `${furnishingDirective}\n${visibleChangeDirective}\n${DEFAULT_STAGING_PROMPT(roomType, stagingStyle)}`;
    }

    return `${groundingRules}\n\n${stagingPrompt}\n\nReturn one photorealistic staged output with high detail and clean materials.`;
  }

  private calculateDelay(attempt: number): number {
    const exponentialDelay = GEMINI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 400;
    return Math.min(exponentialDelay + jitter, GEMINI_RETRY_MAX_DELAY_MS);
  }

  private shortRequestId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  private truncate(text: string, max: number): string {
    if (!text) {
      return "";
    }
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  private isRetryableError(error: any): boolean {
    if (error instanceof ImageProcessingError) {
      const nonRetryableCodes = [ImageErrorCode.AI_CONTENT_BLOCKED, ImageErrorCode.AI_QUOTA_EXCEEDED];
      return !nonRetryableCodes.includes(error.code);
    }

    const errorMessage = error?.message?.toLowerCase() || "";
    const errorStatus = error?.status || error?.code;

    if (errorStatus === 429 || (errorStatus >= 500 && errorStatus < 600)) {
      return true;
    }

    return (
      errorMessage.includes("timeout") ||
      errorMessage.includes("deadline") ||
      errorMessage.includes("unavailable")
    );
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    options?: { maxAttempts?: number; logTag?: string }
  ): Promise<T> {
    let lastError: any = null;
    const attempts = Math.max(1, options?.maxAttempts ?? GEMINI_STAGING_MAX_RETRIES);
    const logTag = options?.logTag ?? "[GEMINI]";

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger(`${logTag} ${operationName} attempt ${attempt}/${attempts} failed: ${errorMsg.substring(0, 140)}`);

        if (!this.isRetryableError(error)) {
          throw error instanceof ImageProcessingError ? error : parseGeminiError(error);
        }

        if (attempt < attempts) {
          const delay = this.calculateDelay(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError instanceof ImageProcessingError ? lastError : parseGeminiError(lastError);
  }

  private extractFirstImageBuffer(response: { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>; data?: string }): Buffer | null {
    const data = response.data;
    if (data) {
      try {
        return Buffer.from(data, "base64");
      } catch {
        /* fall through */
      }
    }

    const parts = response.candidates?.[0]?.content?.parts;
    if (parts) {
      for (const part of parts) {
        const b64 = part.inlineData?.data;
        if (b64) {
          return Buffer.from(b64, "base64");
        }
      }
    }

    return null;
  }

  private async requestOneStagedImage(
    inputImagePath: string,
    roomType: string,
    stagingStyle: string,
    prompt?: string
  ): Promise<Buffer> {
    const requestId = this.shortRequestId();
    const startedAt = Date.now();

    const rawBuffer = await fsPromises.readFile(inputImagePath);
    const pathMime = this.getMimeType(inputImagePath);
    const scaled = await downscaleForApi(
      rawBuffer,
      GEMINI_STAGING_MAX_INPUT_EDGE,
      pathMime,
      GEMINI_STAGING_JPEG_QUALITY
    );
    const imageBuffer = scaled.buffer;
    const mimeType = scaled.mimeType;

    if (scaled.didResize) {
      logger(
        `[GEMINI][${requestId}] STAGING_INPUT_DOWNSCALE maxEdge=${GEMINI_STAGING_MAX_INPUT_EDGE} rawBytes=${rawBuffer.length} sendBytes=${imageBuffer.length} mime=${mimeType}`
      );
    }

    const stagingPrompt = this.buildStagingPrompt(roomType, stagingStyle, prompt);
    const base64Image = imageBuffer.toString("base64");

    await geminiStagingRateLimiter.acquire("gemini-stage-image");

    logger(
      `[GEMINI][${requestId}] STAGING_REQUEST model=${GEMINI_STAGING_MODEL} roomType=${roomType} style=${stagingStyle} imageBytes=${imageBuffer.length} mime=${mimeType}`
    );
    if (GEMINI_STAGING_VERBOSE_LOGS) {
      logger(
        `[GEMINI][${requestId}] STAGING_PROMPT_PREVIEW ${this.truncate(stagingPrompt.replace(/\s+/g, " "), 260)}`
      );
    }

    const geminiClient = await this.ensureGeminiClient();
    const response = await geminiClient.models.generateContent({
      model: GEMINI_STAGING_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: stagingPrompt },
          ],
        },
      ],
      config: {
        responseModalities: ["IMAGE"],
        temperature: 0.4,
      },
    });

    const elapsedMs = Date.now() - startedAt;
    logger(`[GEMINI][${requestId}] STAGING_RESPONSE durationMs=${elapsedMs}`);

    const out = this.extractFirstImageBuffer(response);
    if (!out?.length) {
      throw new ImageProcessingError(
        ImageErrorCode.AI_NO_IMAGE_GENERATED,
        ErrorMessages[ImageErrorCode.AI_NO_IMAGE_GENERATED],
        502,
        "Gemini returned no image in the response."
      );
    }

    logger(`[GEMINI][${requestId}] STAGING_IMAGE bytes=${out.length}`);
    return out;
  }

  async stageImage(
    inputImagePath: string,
    roomType: string,
    stagingStyle: string,
    prompt?: string,
    _removeFurniture?: boolean
  ): Promise<Buffer> {
    logger(
      `[GEMINI] STAGE_IMAGE_START roomType=${roomType} style=${stagingStyle} path=${path.basename(inputImagePath)} customPrompt=${
        prompt ? "yes" : "no"
      }`
    );
    return this.executeWithRetry(
      () => this.requestOneStagedImage(inputImagePath, roomType, stagingStyle, prompt),
      "stageImage"
    );
  }

  async stageImageVariations(
    inputImagePath: string,
    roomType: string,
    stagingStyle: string,
    variationCount: number,
    prompt?: string,
    _removeFurniture?: boolean
  ): Promise<Buffer[]> {
    const requested = Math.max(1, Number(variationCount) || 1);
    const capped = Math.max(1, Math.min(requested, GEMINI_MAX_VARIATIONS));

    logger(`[GEMINI] STAGE_VARIATIONS_START requested=${requested} capped=${capped} roomType=${roomType} style=${stagingStyle}`);

    if (requested > capped) {
      logger(`[GEMINI] Capping requested variations ${requested} -> ${capped} (GEMINI_MAX_VARIATIONS)`);
    }

    const images: Buffer[] = [];
    for (let index = 0; index < capped; index++) {
      const variationPrompt =
        capped > 1
          ? `${prompt || ""}\nVariation ${index + 1} of ${capped}: keep architecture fixed and vary decor/furniture subtly.`
          : prompt;

      const image = await this.executeWithRetry(
        () => this.requestOneStagedImage(inputImagePath, roomType, stagingStyle, variationPrompt),
        `stageImageVariations#${index + 1}`
      );
      images.push(image);
      logger(`[GEMINI] STAGE_VARIATIONS_PROGRESS completed=${images.length}/${capped}`);
    }

    logger(`[GEMINI] STAGE_VARIATIONS_DONE total=${images.length}`);
    return images;
  }

  async analyzeImage(imagePath: string): Promise<any> {
    const rawBuffer = await fsPromises.readFile(imagePath);
    const pathMime = this.getMimeType(imagePath);
    const scaled = await downscaleForApi(
      rawBuffer,
      GEMINI_ANALYSIS_MAX_IMAGE_EDGE,
      pathMime,
      GEMINI_STAGING_JPEG_QUALITY
    );
    const imageBuffer = scaled.buffer;
    const mimeType = scaled.mimeType;

    if (scaled.didResize) {
      logger(
        `[GEMINI] analyzeImage downscaled for tokens maxEdge=${GEMINI_ANALYSIS_MAX_IMAGE_EDGE} rawBytes=${rawBuffer.length} sendBytes=${imageBuffer.length}`
      );
    }

    const analysisPrompt =
      "Analyze this interior/property image. Reply with ONLY valid JSON, no markdown:\n" +
      '{"roomType":"bedroom|kitchen|living-room|etc","features":["string"],"suggestedStyles":["modern","scandinavian","traditional"],"currentCondition":"empty|furnished|needs-staging","recommendations":"short staging tips"}';

    return this.executeWithRetry(
      async () => {
        const base64Image = imageBuffer.toString("base64");
        const geminiClient = await this.ensureGeminiClient();
        const response = await geminiClient.models.generateContent({
          model: GEMINI_ANALYSIS_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType, data: base64Image } },
                { text: analysisPrompt },
              ],
            },
          ],
          config: {
            temperature: 0.2,
          },
        });

        const analysisText = response.text ?? "";
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
      },
      "analyzeImage",
      { maxAttempts: GEMINI_ANALYSIS_MAX_RETRIES, logTag: "[GEMINI]" }
    );
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: { [key: string]: string } = {
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
}

export const geminiService = new GeminiService();
