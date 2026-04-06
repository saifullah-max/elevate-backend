import { Router } from "express";
import { generateImage, stageSingleImageWithFallback, getRecentUploads, analyzeImage, generateMultipleImages, restageImage } from "../controllers/image.controller";
import { uploadImage, uploadImages } from "../middlewares/uploadImage";
import { requireAuth, optionalAuth } from "../middlewares/auth";

const router = Router();

// Get recent uploads (local storage)
router.get("/recent", requireAuth, getRecentUploads);

// Generate/stage an image using AI
// Backward-compatible alias: keep /generate pointed to dual-model flow so older frontend builds still receive variants
router.post("/generate", optionalAuth, uploadImage, stageSingleImageWithFallback);

// NEW: Dual-model flow (Gemini + Replicate variants) - optimized for cost
router.post("/stage-with-variants", optionalAuth, uploadImage, stageSingleImageWithFallback);

// Restage a previously staged image (variation/edit)
router.post("/restage", optionalAuth, uploadImage, restageImage);

// Analyze an image to get room type and suggestions
router.post("/analyze", uploadImage, analyzeImage);

router.post("/multiple-generate", requireAuth ,uploadImages(15), generateMultipleImages);

export default router;
