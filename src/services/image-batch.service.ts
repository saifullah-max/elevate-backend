import { ImageStatus } from "../types/image.types";
import { geminiService } from "./gemini.service";
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

const VARIATIONS_PER_IMAGE = 5;
const MAX_ATTEMPTS_PER_VARIATION = 4;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function processBatchImage(job: BatchStageJob): Promise<void> {
    const { imageId, originalPath, roomType, stagingStyle, customPrompt } = job;

    try {
        const baseImage = await prisma.image.findUnique({ where: { id: imageId } });
        if (!baseImage) {
            logger(`Batch image ${imageId} not found`);
            return;
        }

        await prisma.image.update({
            where: { id: imageId },
            data: { status: ImageStatus.PROCESSING },
        });

        const variationTasks = Array.from({ length: VARIATIONS_PER_IMAGE }).map(async (_, variationIndex) => {
            const variationPrompt = customPrompt ? `${customPrompt} [variation ${variationIndex + 1}]` : undefined;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_VARIATION; attempt++) {
                try {
                    const stagedImageBuffer = await geminiService.stageImage(
                        originalPath,
                        roomType,
                        stagingStyle,
                        variationPrompt
                    );

                    const stagedFileName = `staged-${Date.now()}-${imageId}-${variationIndex}-${attempt}.png`;
                    const stagedUrl = await supabaseStorage.uploadStagedFromBuffer(
                        stagedImageBuffer,
                        stagedFileName,
                        "image/png"
                    );

                    return {
                        variationIndex,
                        stagedUrl,
                    };
                } catch (attemptError) {
                    logger(
                        `Image ${imageId} variation ${variationIndex + 1} attempt ${attempt}/${MAX_ATTEMPTS_PER_VARIATION} failed: ${attemptError}`
                    );

                    if (attempt < MAX_ATTEMPTS_PER_VARIATION) {
                        await delay(250 * attempt);
                    }
                }
            }

            logger(`Image ${imageId} variation ${variationIndex + 1} failed after retries`);
            return null;
        });

        const results = await Promise.all(variationTasks);
        const successfulVariants = results
            .filter((result): result is { variationIndex: number; stagedUrl: string } => Boolean(result?.stagedUrl))
            .sort((a, b) => a.variationIndex - b.variationIndex);

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
            throw new Error(`All ${VARIATIONS_PER_IMAGE} variations failed for image ${imageId}`);
        }

        await prisma.image.update({
            where: { id: imageId },
            data: {
                status: ImageStatus.COMPLETED,
            },
        });

        logger(`Image ${imageId} staged successfully with ${completedCount}/${VARIATIONS_PER_IMAGE} variations`);
    } catch (error) {
        logger(`Image ${imageId} failed staging: ${error}`);

        await prisma.image.update({
            where: { id: imageId },
            data: {
                status: ImageStatus.FAILED,
            },
        });

        throw error;
    }
}
