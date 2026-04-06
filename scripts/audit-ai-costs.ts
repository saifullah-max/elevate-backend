/// <reference types="node" />

/**
 * Prints effective AI cost-related settings (no API calls, no secrets).
 * Run: npx ts-node scripts/audit-ai-costs.ts
 */

function n(name: string, fallback: string): number {
  const v = process.env[name];
  const x = Number(v === undefined || v === "" ? fallback : v);
  return Number.isFinite(x) ? x : Number(fallback);
}

function s(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : String(v).trim();
}

console.log("=== Elevated Spaces — AI cost audit (resolved defaults) ===\n");

console.log("Gemini (staging + analysis — gemini.service):");
console.log("  MARK: set GEMINI_STAGING_MODEL=gemini-3-pro-image-preview to use Gemini 3 Pro image preview");
console.log(`  GEMINI_STAGING_MODEL = ${s("GEMINI_STAGING_MODEL", "gemini-2.5-flash-image")}`);
console.log(`  GEMINI_STAGING_MAX_RETRIES = ${n("GEMINI_STAGING_MAX_RETRIES", "1")}`);
console.log(`  GEMINI_MAX_VARIATIONS = ${n("GEMINI_MAX_VARIATIONS", "1")} (caps stageImageVariations)`);
console.log(`  GEMINI_STAGING_MAX_INPUT_EDGE = ${n("GEMINI_STAGING_MAX_INPUT_EDGE", "2048")} (0 = no downscale)`);
console.log(`  GEMINI_STAGING_RATE_LIMIT_PER_MINUTE = ${n("GEMINI_STAGING_RATE_LIMIT_PER_MINUTE", "10")}`);
console.log(`  GEMINI_ANALYSIS_MODEL = ${s("GEMINI_ANALYSIS_MODEL", "gemini-2.0-flash")}`);
console.log(`  GEMINI_ANALYSIS_MAX_IMAGE_EDGE = ${n("GEMINI_ANALYSIS_MAX_IMAGE_EDGE", "1024")}`);
console.log(`  GEMINI_ANALYSIS_MAX_RETRIES = ${n("GEMINI_ANALYSIS_MAX_RETRIES", "1")}`);

console.log("\nHTTP stream staging (generateImage):");
console.log(`  STAGE_STREAM_VARIATIONS = ${n("STAGE_STREAM_VARIATIONS", "1")} (requested variations per upload)`);

console.log("\nQueue batch worker:");
console.log(`  MULTI_STAGE_VARIATIONS = ${n("MULTI_STAGE_VARIATIONS", "1")}`);
console.log(`  MULTI_STAGE_MAX_ATTEMPTS = ${n("MULTI_STAGE_MAX_ATTEMPTS", "1")}`);

console.log("\nGemini batch staging (BatchGeminiService — if used):");
console.log(`  GEMINI_BATCH_IMAGE_MODEL = ${s("GEMINI_BATCH_IMAGE_MODEL", "gemini-2.5-flash-image")}`);
console.log("  Note: inline batch JSON duplicates full base64 image per variation → large payloads.");

console.log("\nDone.");
