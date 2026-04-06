import { logger } from "../utils/logger";
import { RateLimiter } from "../utils/rateLimiter";
import axios, { AxiosError } from "axios";
import {
  FALLBACK_MODEL,
  FALLBACK_API_KEY,
  FALLBACK_RATE_LIMIT,
  FALLBACK_VARIANT_CONCURRENCY,
  FALLBACK_VARIANT_COUNT,
  FALLBACK_MAX_PARALLEL_REQUESTS,
  FALLBACK_PRIMARY_MODEL,
  FALLBACK_BACKUP_MODEL,
  REPLICATE_WEBHOOK_ENABLED,
  REPLICATE_WEBHOOK_EVENTS,
  REPLICATE_WEBHOOK_AUTH_TOKEN,
  REPLICATE_GLOBAL_COOLDOWN_MIN_MS,
  REPLICATE_GLOBAL_COOLDOWN_MAX_MS,
  REPLICATE_RETRY_BASE_MS,
  REPLICATE_CREATE_MIN_INTERVAL_MS,
  FALLBACK_VARIANT_MAX_ATTEMPTS,
  REPLICATE_MAX_POLL_ATTEMPTS,
  REPLICATE_POLL_DELAY_MS,
  SEEDREAM_SIZE,
  SEEDREAM_ASPECT_RATIO,
  SEEDREAM_SEQUENTIAL_IMAGE_GENERATION,
  SEEDREAM_MAX_IMAGES,
  SEEDREAM_OUTPUT_FORMAT,
  FLUX2FLEX_ASPECT_RATIO,
  FLUX2FLEX_RESOLUTION,
  FLUX2FLEX_OUTPUT_FORMAT,
  FLUX2FLEX_OUTPUT_QUALITY,
  FLUX2FLEX_STEPS,
  FLUX2FLEX_GUIDANCE,
  FLUX2FLEX_SAFETY_TOLERANCE,
  FLUX2FLEX_PROMPT_UPSAMPLING,
  FLUX2FLEX_CUSTOM_WIDTH,
  FLUX2FLEX_CUSTOM_HEIGHT,
} from "../config/fallback.config";

type TraceHook = (step: string, details?: Record<string, unknown>) => Promise<void> | void;
type VariantReadyHook = (details: {
  index: number;
  variantId: string;
  style: string;
  modelSlug: string;
  buffer: Buffer;
}) => Promise<void> | void;

/**
 * Fallback Image Service - Uses Flux-pro or similar model
 * Generates 4 variants based on a primary staged image
 * Runs in parallel after primary Gemini image is generated
 */

let replicateGlobalCooldownUntilMs = 0;
let replicateNextCreateAllowedAtMs = 0;
let replicateCreateLock: Promise<void> = Promise.resolve();

const fallbackRateLimiter = new RateLimiter(FALLBACK_RATE_LIMIT, 60000);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSeedreamModel(modelSlug: string): boolean {
  return modelSlug.toLowerCase().includes("seedream-4.5");
}

function isFluxFlexModel(modelSlug: string): boolean {
  return modelSlug.toLowerCase().includes("flux-2-flex");
}

function toBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return String(value).toLowerCase() === "true";
}

function toNumberInRange(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const REPLICATE_REFERENCE_LOCK_PROMPT = [
  "You are editing a GEMINI-PROCESSED staging image, not creating a new scene.",
  "Use the provided image as the exact visual reference and preserve the same room geometry, camera angle, lens feel, lighting direction, window and door positions, ceiling details, floor pattern, wall color, and architectural layout.",
  "Keep the furniture placement, scale, styling density, and color temperature aligned with the reference image.",
  "Make only refined staging improvements that match the requested room type and staging style.",
  "Do not switch to a different aesthetic family, do not redesign the room, and do not introduce a contradictory layout.",
  "The result must feel like the same staged room, just polished and slightly reinterpreted.",
].join(" ");

function getReplicateInputForModel(modelSlug: string, prompt: string, base64Image: string): Record<string, unknown> {
  const imageUri = `data:image/jpeg;base64,${base64Image}`;

  if (isSeedreamModel(modelSlug)) {
    return {
      prompt,
      image_input: [imageUri],
      size: SEEDREAM_SIZE,
      aspect_ratio: SEEDREAM_ASPECT_RATIO,
      sequential_image_generation: SEEDREAM_SEQUENTIAL_IMAGE_GENERATION,
      max_images: toNumberInRange(String(SEEDREAM_MAX_IMAGES), 1, 1, 15),
      output_format: SEEDREAM_OUTPUT_FORMAT,
    };
  }

  if (isFluxFlexModel(modelSlug)) {
    const payload: Record<string, unknown> = {
      prompt,
      input_images: [imageUri],
      aspect_ratio: FLUX2FLEX_ASPECT_RATIO,
      resolution: FLUX2FLEX_RESOLUTION,
      output_format: FLUX2FLEX_OUTPUT_FORMAT,
      output_quality: toNumberInRange(String(FLUX2FLEX_OUTPUT_QUALITY), 90, 0, 100),
      steps: toNumberInRange(String(FLUX2FLEX_STEPS), 30, 1, 50),
      guidance: toNumberInRange(String(FLUX2FLEX_GUIDANCE), 4.5, 1.5, 10),
      safety_tolerance: toNumberInRange(String(FLUX2FLEX_SAFETY_TOLERANCE), 2, 1, 5),
      prompt_upsampling: FLUX2FLEX_PROMPT_UPSAMPLING,
    };

    if (String(FLUX2FLEX_ASPECT_RATIO) === "custom") {
      payload.width = toNumberInRange(String(FLUX2FLEX_CUSTOM_WIDTH), 1024, 256, 2048);
      payload.height = toNumberInRange(String(FLUX2FLEX_CUSTOM_HEIGHT), 1024, 256, 2048);
    }

    return payload;
  }

  return {
    prompt,
    image: imageUri,
  };
}

async function waitForGlobalCooldownIfNeeded(traceHook?: TraceHook, variantId?: string, attempt?: number): Promise<void> {
  const waitMs = replicateGlobalCooldownUntilMs - Date.now();
  if (waitMs <= 0) return;

  logger(`[FALLBACK/REPLICATE] GLOBAL_COOLDOWN active | waitMs=${waitMs}`);
  await traceHook?.("replicate.cooldown.wait", {
    variantId: variantId || null,
    attempt: attempt || null,
    waitMs,
  });
  await delay(waitMs);
}

async function activateGlobalCooldownOn429(error: AxiosError, traceHook?: TraceHook, variantId?: string, attempt?: number): Promise<number> {
  const retryAfterHeader = error?.response?.headers?.["retry-after"];
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
  const jitterRange = Math.max(0, REPLICATE_GLOBAL_COOLDOWN_MAX_MS - REPLICATE_GLOBAL_COOLDOWN_MIN_MS);
  const randomWindowMs = REPLICATE_GLOBAL_COOLDOWN_MIN_MS + Math.floor(Math.random() * (jitterRange + 1));
  const cooldownMs = Math.max(retryAfterMs, randomWindowMs);

  replicateGlobalCooldownUntilMs = Math.max(replicateGlobalCooldownUntilMs, Date.now() + cooldownMs);

  logger(`[FALLBACK/REPLICATE] GLOBAL_COOLDOWN set | cooldownMs=${cooldownMs} | retryAfter=${retryAfterHeader || "n/a"}`);
  await traceHook?.("replicate.cooldown.set", {
    variantId: variantId || null,
    attempt: attempt || null,
    cooldownMs,
    retryAfterHeader: retryAfterHeader || null,
  });

  return cooldownMs;
}

async function waitForReplicateCreateSlot(traceHook?: TraceHook, variantId?: string, attempt?: number): Promise<void> {
  let releaseLock: () => void = () => {};
  const previousLock = replicateCreateLock;
  replicateCreateLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  try {
    const now = Date.now();
    const waitMs = Math.max(0, replicateNextCreateAllowedAtMs - now);
    if (waitMs > 0) {
      await traceHook?.("replicate.create_slot.wait", {
        variantId: variantId || null,
        attempt: attempt || null,
        waitMs,
      });
      await delay(waitMs);
    }

    replicateNextCreateAllowedAtMs = Date.now() + REPLICATE_CREATE_MIN_INTERVAL_MS;
  } finally {
    releaseLock();
  }
}

logger(
  `[FALLBACK] Service initialized | provider=${FALLBACK_MODEL} | primary=${FALLBACK_PRIMARY_MODEL} | backup=${FALLBACK_BACKUP_MODEL} | concurrency=${FALLBACK_VARIANT_CONCURRENCY} | apiKeyPresent=${!!FALLBACK_API_KEY}`
);

function resolveReplicateWebhookUrl(): string | null {
  const explicitWebhookUrl = String(process.env.REPLICATE_WEBHOOK_URL || "").trim();
  const baseUrl = String(process.env.BASE_URL || "").trim();

  const rawUrl = explicitWebhookUrl || (baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/webhooks/replicate` : "");
  if (!rawUrl) {
    return null;
  }

  if (REPLICATE_WEBHOOK_AUTH_TOKEN) {
    const separator = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${separator}token=${encodeURIComponent(REPLICATE_WEBHOOK_AUTH_TOKEN)}`;
  }

  return rawUrl;
}

class FallbackImageService {
  constructor() {
    if (!FALLBACK_API_KEY) {
      logger(`[FALLBACK] Warning: FALLBACK_API_KEY not set, fallback variants will not be generated`);
    }
  }

  /**
   * Generate 4 styled variants from a base image.
   * Uses a small worker pool to avoid Replicate throttling.
   */
  async generateStyledVariants(
    inputImagePath: string,
    baseImageBuffer: Buffer,
    roomType: string,
    baseStyle: string,
    userPrompt?: string,
    traceHook?: TraceHook,
    onVariantReady?: VariantReadyHook
  ): Promise<Buffer[]> {
    if (!FALLBACK_API_KEY) {
      logger(`[FALLBACK] WARN: No API key configured, skipping variant generation`);
      return [];
    }

    const startTime = Date.now();
    logger(
      `[FALLBACK] START generateStyledVariants | provider=${FALLBACK_MODEL} | primary=${FALLBACK_PRIMARY_MODEL} | backup=${FALLBACK_BACKUP_MODEL} | roomType=${roomType} | baseStyle=${baseStyle}`
    );
    await traceHook?.("fallback.generateStyledVariants.start", {
      provider: FALLBACK_MODEL,
      roomType,
      baseStyle,
      variantCount: FALLBACK_VARIANT_COUNT,
      variantConcurrency: FALLBACK_VARIANT_CONCURRENCY,
      inputImagePath,
      baseImageBytes: baseImageBuffer.length,
    });

    const styleVariations = this.getStyleVariations(baseStyle).slice(0, FALLBACK_VARIANT_COUNT);
    const variants: Buffer[] = new Array(styleVariations.length);
    let nextIndex = 0;
    const workerCount = Math.min(FALLBACK_VARIANT_CONCURRENCY, FALLBACK_MAX_PARALLEL_REQUESTS, styleVariations.length);

    await traceHook?.("fallback.generateStyledVariants.workers", {
      configuredConcurrency: FALLBACK_VARIANT_CONCURRENCY,
      maxParallelRequests: FALLBACK_MAX_PARALLEL_REQUESTS,
      workerCount,
    });

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= styleVariations.length) {
          return;
        }

        const style = styleVariations[currentIndex];
        try {
          const variantResult = await this.generateSingleVariantWithRetry(
            baseImageBuffer,
            roomType,
            style,
            userPrompt,
            currentIndex,
            traceHook
          );

          variants[currentIndex] = variantResult.buffer;

          try {
            await onVariantReady?.({
              index: currentIndex,
              variantId: `v${currentIndex + 1}`,
              style,
              modelSlug: variantResult.modelSlug,
              buffer: variantResult.buffer,
            });
          } catch (streamError) {
            logger(`[FALLBACK] VARIANT_v${currentIndex + 1}_STREAM_ERROR | error=${String(streamError)}`);
            await traceHook?.("fallback.variant.stream.error", {
              variantIndex: currentIndex,
              variantId: `v${currentIndex + 1}`,
              style,
              modelSlug: variantResult.modelSlug,
              error: String(streamError),
            });
          }
        } catch (error) {
          logger(`[FALLBACK] VARIANT_v${currentIndex + 1}_SKIPPED | error=${String(error)}`);
          await traceHook?.("fallback.variant.skipped", {
            variantIndex: currentIndex,
            style,
            error: String(error),
          });
        }
      }
    });

    await Promise.all(workers);

    const completedVariants = variants.filter((variant): variant is Buffer => !!variant && variant.length > 0);
    const duration = Date.now() - startTime;
    logger(`[FALLBACK] COMPLETE generateStyledVariants | total=${completedVariants.length}/${styleVariations.length} | durationMs=${duration}`);
    await traceHook?.("fallback.generateStyledVariants.complete", {
      totalGenerated: completedVariants.length,
      targetVariants: styleVariations.length,
      durationMs: duration,
    });
    return completedVariants;
  }

  private async generateSingleVariantWithRetry(
    imageBuffer: Buffer,
    roomType: string,
    style: string,
    userPrompt?: string,
    index: number = 0,
    traceHook?: TraceHook
  ): Promise<{ buffer: Buffer; modelSlug: string }> {
    const variantId = `v${index + 1}`;
    const startTime = Date.now();

    logger(`[FALLBACK] VARIANT_${variantId}_START | provider=${FALLBACK_MODEL} | style=${style}`);
    await traceHook?.("fallback.variant.start", {
      variantId,
      style,
      roomType,
      provider: FALLBACK_MODEL,
    });

    const maxAttempts = FALLBACK_VARIANT_MAX_ATTEMPTS;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await waitForGlobalCooldownIfNeeded(traceHook, variantId, attempt);

        const limiterDelayMs = await fallbackRateLimiter.acquire(`variant-${variantId}-attempt-${attempt}`);
        await traceHook?.("fallback.variant.attempt", {
          variantId,
          attempt,
          maxAttempts,
          limiterDelayMs,
        });

        const variantResult = await this.generateSingleVariant(imageBuffer, roomType, style, userPrompt, index, traceHook, variantId, attempt);
        logger(`[FALLBACK] VARIANT_${variantId}_SUCCESS | provider=${FALLBACK_MODEL} | model=${variantResult.modelSlug} | bytes=${variantResult.buffer.length} | durationMs=${Date.now() - startTime} | attempts=${attempt}`);
        await traceHook?.("fallback.variant.success", {
          variantId,
          attempt,
          modelSlug: variantResult.modelSlug,
          bytes: variantResult.buffer.length,
          durationMs: Date.now() - startTime,
        });
        return variantResult;
      } catch (error) {
        lastError = error;
        const axiosErr = error as AxiosError;
        const status = axiosErr?.response?.status;
        logger(`[FALLBACK] VARIANT_${variantId}_ATTEMPT_${attempt}_ERROR | status=${status} | error=${String(error)}`);
        await traceHook?.("fallback.variant.error", {
          variantId,
          attempt,
          status,
          message: axiosErr?.message || String(error),
          responseData: axiosErr?.response?.data,
          responseHeaders: axiosErr?.response?.headers,
        });

        if (status === 429 && attempt < maxAttempts) {
          const cooldownMs = await activateGlobalCooldownOn429(axiosErr, traceHook, variantId, attempt);
          const backoffMs = Math.max(REPLICATE_RETRY_BASE_MS * attempt, cooldownMs);
          logger(`[FALLBACK] VARIANT_${variantId}_BACKOFF_429 | delayMs=${backoffMs}`);
          await traceHook?.("fallback.variant.backoff", {
            variantId,
            attempt,
            status,
            retryAfterHeader: axiosErr?.response?.headers?.["retry-after"] || null,
            computedDelayMs: backoffMs,
            strategy: "429 -> global cooldown + delayed retry",
          });
          await delay(backoffMs);
          continue;
        }

        if (status && status >= 500 && attempt < maxAttempts) {
          const backoffMs = Math.max(REPLICATE_RETRY_BASE_MS * attempt, 1200 * attempt);
          await traceHook?.("fallback.variant.backoff", {
            variantId,
            attempt,
            status,
            computedDelayMs: backoffMs,
            strategy: "5xx -> delayed retry",
          });
          await delay(backoffMs);
          continue;
        }

        break;
      }
    }

    logger(`[FALLBACK] VARIANT_${variantId}_ERROR | provider=${FALLBACK_MODEL} | error=${String(lastError)} | durationMs=${Date.now() - startTime}`);
    await traceHook?.("fallback.variant.failed", {
      variantId,
      style,
      durationMs: Date.now() - startTime,
      error: String(lastError),
    });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Generate a single variant with specific styling
   */
  private async generateSingleVariant(
    imageBuffer: Buffer,
    roomType: string,
    style: string,
    userPrompt?: string,
    variantIndex: number = 0,
    traceHook?: TraceHook,
    variantId: string = `v${variantIndex + 1}`,
    attempt: number = 1
  ): Promise<{ buffer: Buffer; modelSlug: string }> {
    const base64Image = imageBuffer.toString("base64");
    const concisePrompt = this.buildVariantPrompt(roomType, style, userPrompt);

    // Primary model first, backup second.
    const modelOrder = variantIndex < 2
      ? [FALLBACK_PRIMARY_MODEL, FALLBACK_BACKUP_MODEL]
      : [FALLBACK_BACKUP_MODEL, FALLBACK_PRIMARY_MODEL];

    const modelSlug = modelOrder[(attempt - 1) % modelOrder.length];

    await traceHook?.("fallback.model.attempt", {
      variantId,
      attempt,
      modelSlug,
      style,
      strategy: "single-model-per-attempt",
    });

    try {
      const buffer = await this.callReplicateApi(modelSlug, base64Image, concisePrompt, traceHook, variantId, attempt);
      return {
        buffer,
        modelSlug,
      };
    } catch (error) {
      logger(`[FALLBACK] model attempt failed | model=${modelSlug} | variantStyle=${style} | error=${String(error)}`);
      await traceHook?.("fallback.model.error", {
        variantId,
        attempt,
        modelSlug,
        style,
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Call Replicate API for image generation
   */
  private async callReplicateApi(
    modelSlug: string,
    base64Image: string,
    prompt: string,
    traceHook?: TraceHook,
    variantId: string = "v1",
    attempt: number = 1
  ): Promise<Buffer> {
    const normalizedModel = this.normalizeReplicateModelSlug(modelSlug);
    const apiUrl = `https://api.replicate.com/v1/models/${normalizedModel}/predictions`;
    const webhookUrl = resolveReplicateWebhookUrl();

    try {
      logger(`[FALLBACK/REPLICATE] REQUEST start | model=${modelSlug} | apiUrl=${apiUrl}`);
      if (REPLICATE_WEBHOOK_ENABLED && !webhookUrl) {
        logger(`[FALLBACK/REPLICATE] Webhook enabled but URL unavailable. Set REPLICATE_WEBHOOK_URL or BASE_URL.`);
      }
      await traceHook?.("replicate.request.create.start", {
        variantId,
        attempt,
        modelSlug,
        apiUrl,
        modelFamily: isSeedreamModel(modelSlug)
          ? "seedream-4.5"
          : isFluxFlexModel(modelSlug)
            ? "flux-2-flex"
            : "generic",
        promptLength: prompt.length,
        base64ImageLength: base64Image.length,
        webhookEnabled: REPLICATE_WEBHOOK_ENABLED,
        webhookUrl,
        webhookEvents: REPLICATE_WEBHOOK_EVENTS,
      });

      const createPayload: Record<string, unknown> = {
        input: getReplicateInputForModel(modelSlug, prompt, base64Image),
      };

      if (REPLICATE_WEBHOOK_ENABLED && webhookUrl) {
        createPayload.webhook = webhookUrl;
        createPayload.webhook_events_filter = REPLICATE_WEBHOOK_EVENTS;
      }

      await waitForReplicateCreateSlot(traceHook, variantId, attempt);

      // Create prediction
      const createResponse = await axios.post(
        apiUrl,
        createPayload,
        {
          headers: {
            Authorization: `Token ${FALLBACK_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 60000,
        }
      );

      await traceHook?.("replicate.request.create.success", {
        variantId,
        attempt,
        modelSlug,
        status: createResponse.status,
        predictionId: createResponse.data?.id || null,
        rateLimitHeaders: {
          limit: createResponse.headers?.["x-ratelimit-limit"],
          remaining: createResponse.headers?.["x-ratelimit-remaining"],
          reset: createResponse.headers?.["x-ratelimit-reset"],
          retryAfter: createResponse.headers?.["retry-after"],
        },
      });

      const predictionId = createResponse.data?.id;
      if (!predictionId) {
        throw new Error("No prediction ID returned from Replicate");
      }

      logger(`[FALLBACK/REPLICATE] POLLING start | model=${modelSlug} | predictionId=${predictionId}`);

      // Poll for completion
      let prediction = createResponse.data;
      let attempts = 0;
      const maxAttempts = REPLICATE_MAX_POLL_ATTEMPTS;
      const pollDelayMs = REPLICATE_POLL_DELAY_MS;
      const pollUrl = prediction?.urls?.get || `https://api.replicate.com/v1/predictions/${predictionId}`;

      while (prediction.status !== "succeeded" && prediction.status !== "failed" && attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        const pollResponse = await axios.get(pollUrl, {
          headers: {
            Authorization: `Token ${FALLBACK_API_KEY}`,
          },
          timeout: 30000,
        });
        prediction = pollResponse.data;
        attempts++;
        if (attempts % 5 === 0) {
          logger(`[FALLBACK/REPLICATE] POLLING status=${prediction.status} | model=${modelSlug} | attempt=${attempts}`);
          await traceHook?.("replicate.request.poll.status", {
            variantId,
            attempt,
            modelSlug,
            pollAttempt: attempts,
            status: prediction.status,
          });
        }
      }

      if (prediction.status === "failed") {
        throw new Error(`Replicate prediction failed: ${prediction.error}`);
      }

      const imageUrl = this.extractReplicateOutputUrl(prediction);
      if (!imageUrl) {
        throw new Error("No output URL from Replicate");
      }

      logger(`[FALLBACK/REPLICATE] OUTPUT_READY | model=${modelSlug} | predictionId=${predictionId}`);
      const imageResponse = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      const buffer = Buffer.from(imageResponse.data);
      logger(`[FALLBACK/REPLICATE] SUCCESS | model=${modelSlug} | bytes=${buffer.length}`);
      await traceHook?.("replicate.request.output.success", {
        variantId,
        attempt,
        modelSlug,
        imageBytes: buffer.length,
      });
      return buffer;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger(`[FALLBACK/REPLICATE] ERROR | model=${modelSlug} | message=${axiosError.message} | status=${axiosError.response?.status}`);
      await traceHook?.("replicate.request.error", {
        variantId,
        attempt,
        modelSlug,
        message: axiosError.message,
        status: axiosError.response?.status || null,
        statusText: axiosError.response?.statusText || null,
        responseHeaders: axiosError.response?.headers,
        responseData: axiosError.response?.data,
        cause:
          axiosError.response?.status === 429
            ? "Rate limited by Replicate or model-level quota. Check retry-after and x-ratelimit headers."
            : "Non-429 request failure.",
      });
      throw error;
    }
  }

  private normalizeReplicateModelSlug(modelSlug: string): string {
    const trimmed = String(modelSlug || "").trim();
    if (!trimmed) {
      throw new Error("Missing Replicate model slug");
    }

    return trimmed.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  }

  private extractReplicateOutputUrl(prediction: any): string | null {
    if (!prediction) {
      return null;
    }

    const output = prediction.output;
    if (typeof output === "string") {
      return output;
    }

    if (Array.isArray(output)) {
      const first = output.find((item) => typeof item === "string" && item.trim().length > 0);
      if (first) return first;
    }

    if (output && typeof output === "object") {
      const values = Object.values(output).filter((value) => typeof value === "string") as string[];
      if (values.length > 0) {
        return values[0];
      }
    }

    return null;
  }

  /**
   * Get 4 style variations to apply to variants
   */
  private getStyleVariations(baseStyle: string): string[] {
    const styleMap: Record<string, string[]> = {
      modern: ["minimalist", "industrial", "scandinavian", "contemporary"],
      minimalist: ["modern", "zen", "transitional", "contemporary"],
      scandinavian: ["modern", "coastal", "farmhouse", "transitional"],
      industrial: ["modern", "loft", "contemporary", "minimalist"],
      traditional: ["transitional", "formal", "classic", "eclectic"],
      contemporary: ["modern", "minimalist", "industrial", "eclectic"],
      luxury: ["modern", "traditional", "contemporary", "transitional"],
      farmhouse: ["rustic", "coastal", "transitional", "eclectic"],
      coastal: ["bohemian", "transitional", "farmhouse", "eclectic"],
      bohemian: ["eclectic", "maximalist", "artistic", "global"],
      "mid-century": ["modern", "vintage", "eclectic", "transitional"],
    };

    return styleMap[baseStyle?.toLowerCase()] || ["modern", "minimalist", "contemporary", "industrial"];
  }

  /**
   * Build concise prompt for variant styling
   */
  private buildVariantPrompt(roomType: string, style: string, userPrompt?: string): string {
    const promptParts = [
      REPLICATE_REFERENCE_LOCK_PROMPT,
      `Target room type: ${roomType}.`,
      `Target styling: ${style}.`,
      "Preserve the Gemini-staged look, composition, and realism as closely as possible.",
      userPrompt ? `User prompt override/addition: ${userPrompt}` : "",
      "If the user prompt conflicts with the reference-preservation rules, keep the reference image structure and apply the user request only where it does not break the staged scene consistency.",
    ].filter(Boolean);

    return promptParts.join(" ").slice(0, 900);
  }
}

export const fallbackImageService = new FallbackImageService();
