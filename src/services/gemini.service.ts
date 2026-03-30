import { GoogleGenAI } from "@google/genai";
import { promises as fsPromises } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { RateLimiter } from "../utils/rateLimiter";
import { DEFAULT_STAGING_PROMPT, STAGING_STYLE_PROMPTS } from "../utils/stagingPrompts";
import {
  ImageProcessingError,
  ImageErrorCode,
  ErrorMessages,
  parseGeminiError,
} from "../utils/imageErrors";

const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || "1");
const BASE_DELAY_MS = Number(process.env.GEMINI_RETRY_BASE_DELAY_MS || "300");
const MAX_DELAY_MS = Number(process.env.GEMINI_RETRY_MAX_DELAY_MS || "1200");
const SINGLE_CALL_FAILURE_COOLDOWN_MS = Number(
  process.env.GEMINI_SINGLE_CALL_FAILURE_COOLDOWN_MS || "3600000"
);
const SINGLE_CALL_MODE = String(process.env.GEMINI_SINGLE_CALL_MODE || "auto").toLowerCase(); // auto | always | never

// Gemini API rate limiter: 18 requests/minute (safety buffer below 20/min limit)
const GEMINI_RATE_LIMIT = Number(process.env.GEMINI_RATE_LIMIT_PER_MINUTE || "18");
const geminiRateLimiter = new RateLimiter(GEMINI_RATE_LIMIT, 60000);

function isQuotaExhaustedMessage(message: string): boolean {
  const normalized = (message || "").toLowerCase();
  return (
    normalized.includes("quota exceeded") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("generate_requests_per_model_per_day") ||
    normalized.includes("limit: 0")
  );
}

class GeminiService {
  private apiKey: string;
  private client: GoogleGenAI;
  private singleCallFailureUntil = 0;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is not set in environment variables");
    }

    // Initialize Gemini client
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
  }

  private extractImagesFromResponse(response: any, maxImages: number): Buffer[] {
    const extracted: Buffer[] = [];
    const seen = new Set<string>();

    for (const candidate of response?.candidates || []) {
      for (const part of candidate?.content?.parts || []) {
        if (!part?.inlineData?.data) {
          continue;
        }

        if (part?.thought === true) {
          continue;
        }

        const fingerprint = String(part.inlineData.data);
        if (seen.has(fingerprint)) {
          continue;
        }

        seen.add(fingerprint);
        extracted.push(Buffer.from(part.inlineData.data, "base64"));

        if (extracted.length >= maxImages) {
          return extracted;
        }
      }
    }

    return extracted;
  }

  private shouldAttemptSingleCall(variationCount: number): boolean {
    if (variationCount <= 1) {
      return false;
    }

    if (SINGLE_CALL_MODE === "never") {
      return false;
    }

    if (SINGLE_CALL_MODE === "always") {
      return true;
    }

    return Date.now() >= this.singleCallFailureUntil;
  }

  private noteSingleCallFailure(reason: string): void {
    if (SINGLE_CALL_MODE !== "auto") {
      return;
    }

    this.singleCallFailureUntil = Date.now() + SINGLE_CALL_FAILURE_COOLDOWN_MS;
    logger(
      `[GEMINI] Single-call multi-variation disabled for ${Math.round(
        SINGLE_CALL_FAILURE_COOLDOWN_MS / 1000
      )}s due to ${reason}`
    );
  }

  private buildStagingPrompt(
    roomType: string,
    stagingStyle: string,
    prompt?: string,
    variationCount: number = 1
  ): string {
    const groundingRules =
      "Use the PROVIDED IMAGE as the only source scene. Keep the exact same room geometry, camera angle, walls, windows, doors, floor, and lighting direction. Do not generate a new or unrelated room. Return exactly ONE full-frame staged image. Do NOT create a collage, split-screen, multi-panel, contact sheet, or multiple views in one image.";

    let stagingPrompt: string;

    if (prompt) {
      const doNotRemove =
        "ABSOLUTELY DO NOT REMOVE, HIDE, OR ALTER ANY EXISTING PAINTINGS, WALL ART, OR DECORATIVE ITEMS. THIS IS CRITICAL. ONLY ADD OR IMPROVE, NEVER REMOVE. DO NOT REMOVE ANYTHING FROM THE ORIGINAL IMAGE UNLESS I EXPLICITLY SAY SO.";
      const lowerPrompt = prompt.toLowerCase();
      const userRequestsRemoval = /remove|delete|empty|clear|no decor|no painting|no wall art/.test(lowerPrompt);
      if (userRequestsRemoval) {
        stagingPrompt = prompt;
      } else {
        stagingPrompt = `${doNotRemove}\n${prompt}\n${doNotRemove}`;
      }
    } else if (STAGING_STYLE_PROMPTS[stagingStyle?.toLowerCase()]) {
      stagingPrompt = STAGING_STYLE_PROMPTS[stagingStyle.toLowerCase()](roomType);
    } else {
      stagingPrompt = DEFAULT_STAGING_PROMPT(roomType, stagingStyle);
    }

    if (variationCount > 1) {
      return `${groundingRules}\n\n${stagingPrompt}\n\nGenerate ${variationCount} distinct staged variations in one response. Each variation must keep the same architecture and camera perspective, while varying furniture layout, decor accents, and styling details.`;
    }

    return `${groundingRules}\n\n${stagingPrompt}`;
  }

  private async generateStagedImages(
    inputImagePath: string,
    roomType: string,
    stagingStyle: string,
    prompt?: string,
    variationCount: number = 1,
    removeFurniture?: boolean
  ): Promise<Buffer[]> {
    const safeVariationCount = Math.max(1, Math.min(variationCount, 8));
    const imageBuffer = await fsPromises.readFile(inputImagePath);
    const mimeType = this.getMimeType(inputImagePath);
    const base64Image = imageBuffer.toString("base64");

    const stagingPrompt = this.buildStagingPrompt(roomType, stagingStyle, prompt, safeVariationCount);
    const singleCallPrompt = `${stagingPrompt}\n\nReturn exactly ${safeVariationCount} final staged IMAGE outputs in this single response. Each output must be one full-frame image only (no collage or split). Keep the original architecture unchanged.`;

    return this.executeWithRetry(async () => {
      const generated: Buffer[] = [];
      const seen = new Set<string>();
      let geminiCallCount = 0;
      let usedSingleCallOnly = false;

      if (this.shouldAttemptSingleCall(safeVariationCount)) {
        try {
          await geminiRateLimiter.acquire(`stageImage-${safeVariationCount}-single`);
          logger(`[GEMINI] Starting single-call staging generation with ${safeVariationCount} variations`);
          geminiCallCount += 1;

          const response = await this.client.models.generateContent({
            model: "gemini-3-pro-image-preview",
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
                  {
                    text: singleCallPrompt,
                  },
                ],
              },
            ],
            config: {
              responseModalities: ["IMAGE"],
              temperature: 0.7,
            },
          } as any);

          const images = this.extractImagesFromResponse(response, safeVariationCount);
          if (images.length >= safeVariationCount) {
            for (const image of images.slice(0, safeVariationCount)) {
              const fp = image.toString("base64");
              if (!seen.has(fp)) {
                generated.push(image);
                seen.add(fp);
              }
            }
            usedSingleCallOnly = generated.length >= safeVariationCount;
          } else if (images.length > 0) {
            logger(`[GEMINI] Single-call returned partial output (${images.length}/${safeVariationCount}); discarding partial set and regenerating all variations individually.`);
            this.noteSingleCallFailure(`partial output ${images.length}/${safeVariationCount}`);
          }
        } catch (error) {
          this.noteSingleCallFailure("single-call error");
          logger(`[GEMINI] Single-call multi-image attempt failed, falling back to per-variation calls: ${String(error)}`);
        }
      } else {
        logger(`[GEMINI] Skipping single-call multi-variation attempt (mode=${SINGLE_CALL_MODE}) and generating per-variation directly.`);
      }

      if (!usedSingleCallOnly && generated.length < safeVariationCount) {
        if (generated.length > 0) {
          generated.length = 0;
          seen.clear();
        }
        logger(`[GEMINI] Generating ${safeVariationCount - generated.length} remaining variations with per-variation calls (still one billed job)`);
      }

      for (let index = generated.length; index < safeVariationCount; index++) {
        await geminiRateLimiter.acquire(`stageImage-${safeVariationCount}-v${index + 1}`);
        geminiCallCount += 1;

        const variationPrompt = prompt
          ? `${prompt}\n\nCreate variation ${index + 1} of ${safeVariationCount}. Keep architecture unchanged and make this variation visually distinct from previous ones.`
          : `Create variation ${index + 1} of ${safeVariationCount} for this ${roomType} in ${stagingStyle} style. Keep architecture unchanged and make this variation visually distinct from previous ones.`;

        const perVariationPrompt = this.buildStagingPrompt(roomType, stagingStyle, variationPrompt, 1);

        const variationResponse = await this.client.models.generateContent({
          model: "gemini-3-pro-image-preview",
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
                {
                  text: perVariationPrompt,
                },
              ],
            },
          ],
          config: {
            responseModalities: ["IMAGE"],
            temperature: 0.75,
          },
        } as any);

        const nextImage = this.extractImagesFromResponse(variationResponse, 1)[0];
        if (!nextImage) {
          continue;
        }

        const fingerprint = nextImage.toString("base64");
        if (!seen.has(fingerprint)) {
          generated.push(nextImage);
          seen.add(fingerprint);
        }
      }

      if (generated.length < safeVariationCount) {
        logger(`[GEMINI] API call count for this job: ${geminiCallCount} (single-call success: ${usedSingleCallOnly})`);
        throw new ImageProcessingError(
          ImageErrorCode.AI_NO_IMAGE_GENERATED,
          ErrorMessages[ImageErrorCode.AI_NO_IMAGE_GENERATED],
          502,
          `Gemini returned ${generated.length}/${safeVariationCount} staged images after fallback generation.`
        );
      }

      logger(`[GEMINI] API call count for this job: ${geminiCallCount} (single-call success: ${usedSingleCallOnly})`);
      logger(`[GEMINI] Staging generation succeeded with ${generated.length} images`);
      return generated.slice(0, safeVariationCount);
    }, "generateStagedImages");
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 500;
    return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: any): boolean {
    if (error instanceof ImageProcessingError) {
      const nonRetryableCodes = [
        ImageErrorCode.AI_CONTENT_BLOCKED,
        ImageErrorCode.AI_QUOTA_EXCEEDED,
      ];
      return !nonRetryableCodes.includes(error.code);
    }

    const errorMessage = error?.message?.toLowerCase() || "";
    const errorStatus = error?.status || error?.code;

    if (isQuotaExhaustedMessage(errorMessage)) {
      return false;
    }

    // Rate limits, server errors, timeouts - retryable
    if (errorStatus === 429 || (errorStatus >= 500 && errorStatus < 600)) {
      return true;
    }
    if (errorMessage.includes("timeout") || errorMessage.includes("deadline")) {
      return true;
    }
    if (errorMessage.includes("unavailable") || errorMessage.includes("503")) {
      return true;
    }

    return false;
  }

  /**
   * Execute operation with retry logic
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    let lastError: any = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);
        
        // Check for daily quota exhaustion
        const isDailyQuota = errorMsg.toLowerCase().includes('per_day') || errorMsg.toLowerCase().includes('per day');
        
        if (isDailyQuota) {
          logger(`[GEMINI] DAILY QUOTA EXHAUSTED - Please wait 24 hours or upgrade API plan`);
          throw error instanceof ImageProcessingError ? error : parseGeminiError(error);
        }

        logger(`[GEMINI] Attempt ${attempt}/${MAX_RETRIES} failed: ${errorMsg.substring(0, 100)}...`);

        if (!this.isRetryableError(error)) {
          throw error instanceof ImageProcessingError ? error : parseGeminiError(error);
        }

        if (attempt < MAX_RETRIES) {
          const delay = this.calculateDelay(attempt);
          logger(`[GEMINI] Retrying in ${Math.round(delay / 1000)}s...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError instanceof ImageProcessingError ? lastError : parseGeminiError(lastError);
  }


  // Proper class method: stageImage
  async stageImage(
    inputImagePath: string,
    roomType: string,
    stagingStyle: string,
    prompt?: string,
    removeFurniture?: boolean
  ): Promise<Buffer> {
    const images = await this.generateStagedImages(
      inputImagePath,
      roomType,
      stagingStyle,
      prompt,
      1,
      removeFurniture
    );
    return images[0];
  }

  async stageImageVariations(
    inputImagePath: string,
    roomType: string,
    stagingStyle: string,
    variationCount: number,
    prompt?: string,
    removeFurniture?: boolean
  ): Promise<Buffer[]> {
    return this.generateStagedImages(
      inputImagePath,
      roomType,
      stagingStyle,
      prompt,
      variationCount,
      removeFurniture
    );
  }


  /**
   * Analyze image to understand room characteristics
   * Uses text response mode for analysis
   */
  async analyzeImage(imagePath: string): Promise<any> {
    // Use async file read for better performance
    const imageBuffer = await fsPromises.readFile(imagePath);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = this.getMimeType(imagePath);

    return this.executeWithRetry(async () => {
      logger(`Analyzing image: ${imagePath}`);

      let analysisText = "";

      const stream = await this.client.models.generateContentStream({
        model: "gemini-3-pro-image-preview",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64Image,
                },
              },
              {
                text: `Analyze this interior/property image and provide JSON response with:
              {
                "roomType": "bedroom/kitchen/living-room/etc",
                "features": ["array", "of", "features"],
                "suggestedStyles": ["modern", "scandinavian", "traditional"],
                "currentCondition": "empty/furnished/needs-staging",
                "recommendations": "staging recommendations"
              }
              
              Only respond with valid JSON, no other text.`,
              },
            ],
          },
        ],
        config: {
          responseModalities: ["TEXT"],
          temperature: 0.7,
        },
      });

      for await (const chunk of stream) {
        if (chunk.candidates) {
          for (const candidate of chunk.candidates) {
            if (candidate.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  analysisText += part.text;
                }
              }
            }
          }
        }
      }

      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

      logger(`Image analysis complete: ${JSON.stringify(analysis)}`);
      return analysis;
    }, "analyzeImage");
  }

  /**
   * Get MIME type from file extension
   */
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