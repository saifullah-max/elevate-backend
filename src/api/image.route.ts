import { Router } from "express";
import { generateImage, getRecentUploads, analyzeImage, generateMultipleImages, restageImage } from "../controllers/image.controller";
import { uploadImage, uploadImages } from "../middlewares/uploadImage";
import { requireAuth, optionalAuth } from "../middlewares/auth";

const router = Router();

// Get recent uploads (local storage)
router.get("/recent", requireAuth, getRecentUploads);

// Generate/stage an image using AI
router.post("/generate", optionalAuth, uploadImage, generateImage);
// Restage a previously staged image (variation/edit)
router.post("/restage", uploadImage, restageImage);

// Analyze an image to get room type and suggestions
router.post("/analyze", uploadImage, analyzeImage);

router.post("/multiple-generate", requireAuth ,uploadImages(30), generateMultipleImages);

export default router;
