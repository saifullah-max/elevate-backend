import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import { promises as fsPromises } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { DEFAULT_STAGING_PROMPT, STAGING_STYLE_PROMPTS } from "../utils/stagingPrompts";
import {
  ImageProcessingError,
  ImageErrorCode,
  ErrorMessages,
  parseGeminiError,
} from "../utils/imageErrors";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5000;

class GeminiService {
  private apiKey: string;
  private client: GoogleGenAI;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is not set in environment variables");
    }

    // Initialize Gemini client
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
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
        logger(`${operationName}: Attempt ${attempt}/${MAX_RETRIES}`);
        return await operation();
      } catch (error) {
        lastError = error;
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger(`${operationName}: Attempt ${attempt} failed: ${errorMsg}`);

        if (!this.isRetryableError(error)) {
          logger(`${operationName}: Non-retryable error, stopping`);
          throw error instanceof ImageProcessingError ? error : parseGeminiError(error);
        }

        if (attempt < MAX_RETRIES) {
          const delay = this.calculateDelay(attempt);
          logger(`${operationName}: Waiting ${Math.round(delay)}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger(`${operationName}: All ${MAX_RETRIES} attempts failed`);
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
    // Use async file read for better performance
    const imageBuffer = await fsPromises.readFile(inputImagePath);
    // Optimize: Check image size and compress if needed (max 4MB for Gemini)
    const maxSize = 4 * 1024 * 1024; // 4MB
    let optimizedBuffer = imageBuffer;
    if (imageBuffer.length > maxSize) {
      logger(`Image size ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB exceeds 4MB, optimizing...`);
      // For now, we'll use the original, but you could add image compression here
      // Consider using sharp or jimp to resize/compress if needed
    }
    const base64Image = optimizedBuffer.toString("base64");
    const mimeType = this.getMimeType(inputImagePath);

    // Compose a more detailed prompt for Gemini
    let stagingPrompt: string;
    // if (removeFurniture) {
    //   // Remove furniture prompt (dedicated, no staging style or user prompt)
    //   stagingPrompt = `Remove all movable furniture and decor from the room, leaving only the fixed architectural features (walls, windows, doors, ceiling, floor, lighting, etc). Do not change the layout, wall color, wall structure, ceiling, LED lights position, window/door positions, or any fixed architectural features. The room's structure and permanent features must remain exactly as in the original image.`;
    // } else 
    if (prompt) {
      // Strongly reinforce "do not remove" at start and end unless user prompt explicitly requests removal
      const doNotRemove =
        "ABSOLUTELY DO NOT REMOVE, HIDE, OR ALTER ANY EXISTING PAINTINGS, WALL ART, OR DECORATIVE ITEMS. THIS IS CRITICAL. ONLY ADD OR IMPROVE, NEVER REMOVE. DO NOT REMOVE ANYTHING FROM THE ORIGINAL IMAGE UNLESS I EXPLICITLY SAY SO.";
      // If the prompt contains 'remove' or 'delete' or 'empty' (case-insensitive), do not add the doNotRemove guard
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

    return this.executeWithRetry(async () => {
      const startTime = Date.now();
      logger(
        `Staging image: ${inputImagePath}, Room: ${roomType}, Style: ${stagingStyle}`
      );

      let stagedImageData: Buffer | null = null;

      try {
        const response = await this.client.models.generateContent({
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
                { text: stagingPrompt },
              ],
            },
          ],
          config: {
            responseModalities: ["IMAGE"],
            temperature: 0.7,
          },
        });

        // Extract image from response
        if (response.candidates && response.candidates.length > 0) {
          for (const candidate of response.candidates) {
            if (candidate.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.inlineData?.data) {
                  stagedImageData = Buffer.from(part.inlineData.data, "base64");
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        logger(`Gemini image generation error: ${err}`);
        throw err;
      }

      if (!stagedImageData) {
        throw new ImageProcessingError(
          ImageErrorCode.AI_NO_IMAGE_GENERATED,
          ErrorMessages[ImageErrorCode.AI_NO_IMAGE_GENERATED],
          500
        );
      }

      logger(`Staged image generated successfully for: ${inputImagePath}`);
      return stagedImageData;
    }, "stageImage");
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