/**
 * Fallback Image Generation Configuration
 * Contains all hardcoded defaults and environment-based settings for the Replicate/fallback service
 */

// Support both generic FALLBACK_API_KEY and Replicate-specific keys.
export const FALLBACK_API_KEY =
  process.env.REPLICATE_API_TOKEN ||
  process.env.REPLICATE_API_KEY ||
  process.env.FALLBACK_API_KEY ||
  "";

export const FALLBACK_MODEL = "replicate";

export const FALLBACK_RATE_LIMIT = 20;

export const FALLBACK_VARIANT_CONCURRENCY = 2;

export const FALLBACK_VARIANT_COUNT = 2;

export const FALLBACK_MAX_PARALLEL_REQUESTS = 2;

export const FALLBACK_PRIMARY_MODEL = "black-forest-labs/flux-2-flex";

export const FALLBACK_BACKUP_MODEL = "black-forest-labs/flux-2-flex";

export const REPLICATE_WEBHOOK_ENABLED = true;

export const REPLICATE_WEBHOOK_EVENTS = ["start", "output", "logs", "completed"];

export const REPLICATE_WEBHOOK_AUTH_TOKEN = String(process.env.REPLICATE_WEBHOOK_AUTH_TOKEN || "").trim();

export const REPLICATE_GLOBAL_COOLDOWN_MIN_MS = 10000;

export const REPLICATE_GLOBAL_COOLDOWN_MAX_MS = 20000;

export const REPLICATE_RETRY_BASE_MS = 1200;
export const REPLICATE_CREATE_MIN_INTERVAL_MS = 1500;

// Optional: Tuning parameters for polling and retry strategies
export const FALLBACK_VARIANT_MAX_ATTEMPTS = 2;

export const REPLICATE_MAX_POLL_ATTEMPTS = 60;

export const REPLICATE_POLL_DELAY_MS = 1000;

// Seedream model-specific tuning parameters
export const SEEDREAM_SIZE = "2K";
export const SEEDREAM_ASPECT_RATIO = "match_input_image";
export const SEEDREAM_SEQUENTIAL_IMAGE_GENERATION = "disabled";
export const SEEDREAM_MAX_IMAGES = 1;
export const SEEDREAM_OUTPUT_FORMAT = "png";

// Flux 2 Flex model-specific tuning parameters
export const FLUX2FLEX_ASPECT_RATIO = "match_input_image";
export const FLUX2FLEX_RESOLUTION = "match_input_image";
export const FLUX2FLEX_OUTPUT_FORMAT = "png";
export const FLUX2FLEX_OUTPUT_QUALITY = 90;
export const FLUX2FLEX_STEPS = 24;
export const FLUX2FLEX_GUIDANCE = 4.5;
export const FLUX2FLEX_SAFETY_TOLERANCE = 2;
export const FLUX2FLEX_PROMPT_UPSAMPLING = true;
export const FLUX2FLEX_CUSTOM_WIDTH = 1024;
export const FLUX2FLEX_CUSTOM_HEIGHT = 1024;
