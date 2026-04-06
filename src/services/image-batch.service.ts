import { ImageStatus } from "../types/image.types";
import { geminiService } from "./gemini.service";
import { fallbackImageService } from "./fallbackImage.service";
import { logger } from "../utils/logger";
import prisma from "../dbConnection";
import { supabaseStorage } from "./supabaseStorage.service";

interface BatchStageJob {
    imageId: string;
    originalPath: string;
    roomType: string;
    stagingStyle: string;
    customPrompt?: string;
}

const VARIATIONS_PER_IMAGE = 3;
const FALLBACK_VARIANTS_PER_IMAGE = 2;
const MAX_ATTEMPTS_PER_VARIATION = Number(process.env.MULTI_STAGE_MAX_ATTEMPTS || "1");
const RETRY_BACKOFF_BASE_MS = Number(process.env.MULTI_STAGE_RETRY_BACKOFF_MS || "120");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isQuotaExhaustedError = (error: unknown): boolean => {
    const message = String(error || "").toLowerCase();
    return (
        message.includes("quota exceeded") ||
        message.includes("resource_exhausted") ||
        message.includes("generate_requests_per_model_per_day") ||
        message.includes("limit: 0")
    );
};

export async function processBatchImage(job: BatchStageJob): Promise<void> {
    const { imageId, originalPath, roomType, stagingStyle, customPrompt } = job;
    const jobStartTime = Date.now();
    const fileName = originalPath.split('/').pop() || originalPath.split('\\').pop() || 'unknown';
    logger(`[JOB][${imageId.slice(0, 8)}] START ${fileName.substring(0, 30)}`);

    try {
        const baseImage = await prisma.image.findUnique({ where: { id: imageId } });
        if (!baseImage) {
            logger(`[JOB][${imageId.slice(0, 8)}] ERROR: Image not found in database`);
            return;
        }

        await prisma.image.update({
            where: { id: imageId },
            data: { status: ImageStatus.PROCESSING },
        });

        let primaryVariant: Buffer | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_VARIATION; attempt++) {
            try {
                primaryVariant = await geminiService.stageImage(
                    originalPath,
                    roomType,
                    stagingStyle,
                    customPrompt
                );
                break;
            } catch (attemptError) {
                if (isQuotaExhaustedError(attemptError)) {
                    logger(`[JOB][${imageId.slice(0, 8)}] QUOTA EXHAUSTED`);
                    break;
                }

                if (attempt < MAX_ATTEMPTS_PER_VARIATION) {
                    await delay(RETRY_BACKOFF_BASE_MS * attempt);
                }
            }
        }

        if (!primaryVariant) {
            await prisma.image.update({
                where: { id: imageId },
                data: {
                    status: ImageStatus.FAILED,
                },
            });
            throw new Error(`Primary Gemini generation failed for image ${imageId}`);
        }

        let fallbackVariants: Buffer[] = [];
        try {
            fallbackVariants = await fallbackImageService.generateStyledVariants(
                originalPath,
                primaryVariant,
                roomType,
                stagingStyle,
                customPrompt
            );
        } catch (fallbackErr) {
            logger(`[JOB][${imageId.slice(0, 8)}] fallback generation warning: ${String(fallbackErr)}`);
            fallbackVariants = [];
        }

        const generatedVariations = [
            primaryVariant,
            ...fallbackVariants.slice(0, FALLBACK_VARIANTS_PER_IMAGE),
        ];

        const successfulVariants = await Promise.all(
            generatedVariations.map(async (stagedImageBuffer, variationIndex) => {
                const stagedFileName = `staged-${Date.now()}-${imageId}-${variationIndex}.png`;
                const stagedUrl = await supabaseStorage.uploadStagedFromBuffer(
                    stagedImageBuffer,
                    stagedFileName,
                    "image/png"
                );

                return {
                    variationIndex,
                    stagedUrl,
                };
            })
        );

        const completedCount = successfulVariants.length;

        if (completedCount > 0) {
            const [baseVariant, ...otherVariants] = successfulVariants;

            await prisma.image.update({
                where: { id: imageId },
                data: {
                    staged_image_url: baseVariant.stagedUrl,
                    room_type: roomType,
                    staging_style: stagingStyle,
                    prompt: customPrompt || null,
                    status: ImageStatus.PROCESSING,
                },
            });

            if (otherVariants.length > 0) {
                await prisma.image.createMany({
                    data: otherVariants.map((variant) => ({
                        user_id: baseImage.user_id,
                        guest_id: baseImage.guest_id,
                        project_id: baseImage.project_id,
                        original_image_url: baseImage.original_image_url,
                        staged_image_url: variant.stagedUrl,
                        watermarked_preview_url: null,
                        status: ImageStatus.COMPLETED,
                        is_demo: false,
                        room_type: roomType,
                        staging_style: stagingStyle,
                        prompt: customPrompt || null,
                        source: baseImage.source || "user",
                        revisions: 0,
                        max_revisions: baseImage.max_revisions || 3,
                    })),
                });
            }
        }

        if (completedCount === 0) {
            await prisma.image.update({
                where: { id: imageId },
                data: {
                    status: ImageStatus.FAILED,
                },
            });
            throw new Error(`All ${VARIATIONS_PER_IMAGE} variants failed for image ${imageId}`);
        }

        await prisma.image.update({
            where: { id: imageId },
            data: {
                status: ImageStatus.COMPLETED,
            },
        });

        const jobElapsed = Math.round((Date.now() - jobStartTime) / 1000);
        logger(`[JOB][${imageId.slice(0, 8)}] DONE ${completedCount}/${VARIATIONS_PER_IMAGE} in ${jobElapsed}s`);
    } catch (error) {
        const jobElapsed = Math.round((Date.now() - jobStartTime) / 1000);
        logger(`[JOB][${imageId.slice(0, 8)}] FAILED after ${jobElapsed}s`);

        await prisma.image.update({
            where: { id: imageId },
            data: {
                status: ImageStatus.FAILED,
            },
        });

        throw error;
    }
}
