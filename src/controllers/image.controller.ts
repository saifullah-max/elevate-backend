import { Request, Response } from "express";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { geminiService } from "../services/gemini.service";
import { supabaseStorage } from "../services/supabaseStorage.service";
import { loggingService } from "../services/logging.service";
import { logger } from "../utils/logger";
import {
  ImageProcessingError,
  ImageErrorCode,
  ErrorMessages,
  VALID_ROOM_TYPES,
  VALID_STAGING_STYLES,
  parseStorageError,
} from "../utils/imageErrors";
import { imageQueue } from "../queues/image.queue";
import { QUEUE_CONCURRENCY } from "../config/queue.config";
import prisma from "../dbConnection";
import { image_status } from "@prisma/client";
import { AuthUser } from "../types/auth";
import { addWatermark } from "../utils/watermark";
import {
  DEMO_LIMIT,
  getUnifiedDemoTracking,
  incrementUnifiedDemoUsage,
  linkGuestToUser,
  resolveDemoFingerprint
} from "../utils/demoTracking";

// TypeScript: declare global property for demo upload counts
declare global {
  // Use Record<string, number> for session/IP tracking
  var demoUploadCounts: Record<string, number> | undefined;
}

function getDeviceTypeFromUserAgent(userAgent: string | string[] | undefined): string | null {
  const ua = Array.isArray(userAgent) ? userAgent[0] : userAgent || "";
  if (!ua) return null;
  if (/mobile/i.test(ua)) return "mobile";
  if (/tablet/i.test(ua)) return "tablet";
  return "desktop";
}

function toPublicImageUrl(rawPath: string, req: Request): string {
  if (!rawPath) return rawPath;
  if (/^https?:\/\//i.test(rawPath)) return rawPath;

  const normalized = rawPath.replace(/\\/g, "/");
  const uploadsMatch = normalized.match(/(?:^|\/)(uploads\/.+)$/i);
  if (uploadsMatch) {
    const host = req.get("host") || "localhost:3003";
    return `${req.protocol}://${host}/${uploadsMatch[1]}`;
  }

  if (normalized.startsWith("/")) {
    const host = req.get("host") || "localhost:3003";
    return `${req.protocol}://${host}${normalized}`;
  }

  return rawPath;
}

type MultiRunOriginalSummary = {
  originalIndex: number;
  originalFile: string;
  totalRows: number;
  completed: number;
  processing: number;
  failed: number;
};

function toMarkdownTable(headers: string[], rows: string[][]): string {
  const escape = (value: string) => String(value ?? "").replace(/\|/g, "\\|");
  const headerRow = `| ${headers.map(escape).join(" | ")} |`;
  const separatorRow = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyRows = rows.map((row) => `| ${row.map(escape).join(" | ")} |`);
  return [headerRow, separatorRow, ...bodyRows].join("\n");
}

async function appendMultiImageRunReport(params: {
  runId: string;
  userId: string;
  totalImages: number;
  expectedTotalVariants: number;
  streamedTotal: number;
  failedOrMissing: number;
  estimatedSeconds: number;
  startedAt: number;
  endedAt: number;
  rows: MultiRunOriginalSummary[];
}): Promise<void> {
  const logsDir = path.join(process.cwd(), "logs");
  const reportPath = path.join(logsDir, `multi-image-run-${params.runId}.md`);
  const elapsedSeconds = Math.max(0, Math.round((params.endedAt - params.startedAt) / 1000));

  const summaryTable = toMarkdownTable(
    ["Run ID", "User", "Images", "Expected Variants", "Streamed", "Failed/Missing", "ETA(s)", "Elapsed(s)", "Ended At"],
    [[
      params.runId,
      params.userId,
      String(params.totalImages),
      String(params.expectedTotalVariants),
      String(params.streamedTotal),
      String(params.failedOrMissing),
      String(params.estimatedSeconds),
      String(elapsedSeconds),
      new Date(params.endedAt).toISOString(),
    ]]
  );

  const perOriginalTable = toMarkdownTable(
    ["Original #", "Original File", "Rows", "Completed", "Processing", "Failed"],
    params.rows.map((row) => [
      String(row.originalIndex + 1),
      row.originalFile,
      String(row.totalRows),
      String(row.completed),
      String(row.processing),
      String(row.failed),
    ])
  );

  const content = `# Multi-Image Staging Run Report

**Run ID:** ${params.runId}  
**Generated:** ${new Date(params.endedAt).toISOString()}

## Summary

${summaryTable}

## Per-Original Breakdown

${perOriginalTable}
`;

  await fs.promises.mkdir(logsDir, { recursive: true });
  await fs.promises.writeFile(reportPath, content, "utf8");
}

/**
 * Restage a previously staged image with a new prompt (variation/edit)
 */
export async function restageImage(req: Request, res: Response): Promise<void> {
  let userId: string | null = null;
  let isAdmin = false;

  if (req.user && req.user.id) {
    userId = req.user.id;
    const verifyRole = await prisma.user_roles.findFirst({
      where: { user_id: userId },
      include: { role: true },
    });

    isAdmin = verifyRole?.role.name === "ADMIN";
  }

  try {
    const { stagedId, prompt, roomType = "living-room", stagingStyle = "modern", keepLocalFiles = false, removeFurniture = false } = req.body;

    // Determine if user is in demo mode (for watermarking, NOT for blocking)
    // Restaging is FREE and doesn't consume demo credits
    let isDemo = !userId;
    let hasPurchasedCredits = false;

    if (userId) {
      const personalCredits = await prisma.user_credit_balance.findUnique({
        where: { user_id: userId }
      });
      const hasPersonalCredits = personalCredits && personalCredits.balance > 0;

      const purchaseCount = await prisma.user_credit_purchase.count({
        where: {
          user_id: userId,
          status: 'completed',
        },
      });
      hasPurchasedCredits = purchaseCount > 0;

      // User is in demo mode if they have no personal credits and never purchased
      if (!hasPersonalCredits && !hasPurchasedCredits) {
        isDemo = true;
      } else {
        isDemo = false;
      }
    }

    // NO DEMO LIMIT CHECK FOR RESTAGING - It's free!
    // We only use isDemo to determine if we should add watermark

    if (!stagedId) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.NO_FILE_PROVIDED,
          message: "Missing staged image ID for restaging.",
        },
      });
      return;
    }
    // Download unwatermarked staged image from Supabase
    const stagedUrl = await supabaseStorage.getPublicStagedUrl(stagedId);
    if (!stagedUrl) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.FILE_READ_ERROR,
          message: "Could not find staged image in Supabase.",
        },
      });
      return;
    }
    // Download image to temp file (cross-platform)
    const tempPath = path.join(os.tmpdir(), stagedId);
    const response = await fetch(stagedUrl);
    const arrayBuffer = await response.arrayBuffer();
    await fs.promises.writeFile(tempPath, Buffer.from(arrayBuffer));
    // Validate room type
    if (!VALID_ROOM_TYPES.includes(roomType.toLowerCase())) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.INVALID_ROOM_TYPE,
          message: ErrorMessages[ImageErrorCode.INVALID_ROOM_TYPE],
          details: `Valid room types: ${VALID_ROOM_TYPES.join(", ")}`,
        },
      });
      return;
    }
    // Validate staging style
    if (!VALID_STAGING_STYLES.includes(stagingStyle.toLowerCase())) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.INVALID_STAGING_STYLE,
          message: ErrorMessages[ImageErrorCode.INVALID_STAGING_STYLE],
          details: `Valid styles: ${VALID_STAGING_STYLES.join(", ")}`,
        },
      });
      return;
    }
    // AI PROCESSING: Stage the image (variation)
    // (Single image for now, but future-proof for parallel if needed)
    let stagedImageBuffer: Buffer | null = null;
    try {
      // stagedImageBuffer = await geminiService.stageImage(
      //   tempPath,
      //   roomType.toLowerCase(),
      //   stagingStyle.toLowerCase(),
      //   prompt,
      //   removeFurniture
      // );
      stagedImageBuffer = await geminiService.stageImage(
        tempPath,
        roomType.toLowerCase(),
        stagingStyle.toLowerCase(),
        prompt
      );
    } catch (aiError) {
      if (aiError instanceof ImageProcessingError) {
        res.status(aiError.statusCode).json(aiError.toJSON());
      } else {
        res.status(500).json({
          success: false,
          error: {
            code: ImageErrorCode.AI_PROCESSING_FAILED,
            message: ErrorMessages[ImageErrorCode.AI_PROCESSING_FAILED],
            details: aiError instanceof Error ? aiError.message : undefined,
          },
        });
      }
      return;
    }
    // Verify staged image was created
    if (!stagedImageBuffer || stagedImageBuffer.length === 0) {
      res.status(500).json({
        success: false,
        error: {
          code: ImageErrorCode.AI_NO_IMAGE_GENERATED,
          message: ErrorMessages[ImageErrorCode.AI_NO_IMAGE_GENERATED],
        },
      });
      return;
    }
    // Add watermark only for demo users (guests without a paid plan)
    if (isDemo && stagedImageBuffer) {
      stagedImageBuffer = await addWatermark(stagedImageBuffer, "DEMO PREVIEW");
    }
    // STORAGE: Upload to Supabase
    let restagedUrl: string | null = null;
    let stagedFileName = '';
    try {
      stagedFileName = `restaged-${Date.now()}.png`;
      const result = await supabaseStorage.uploadStagedImageBuffer(
        stagedImageBuffer,
        stagedFileName,
        "image/png"
      );
      restagedUrl = result.stagedUrl;
    } catch (storageError) {
      const parsedError = parseStorageError(storageError);
      res.status(parsedError.statusCode).json(parsedError.toJSON());
      return;
    }
    if (!restagedUrl) {
      res.status(500).json({
        success: false,
        error: {
          code: ImageErrorCode.STORAGE_UPLOAD_FAILED,
          message: ErrorMessages[ImageErrorCode.STORAGE_UPLOAD_FAILED],
          details: "Failed to upload restaged image",
        },
      });
      return;
    }
    // CLEANUP: Remove temp file
    await fs.promises.unlink(tempPath);

    // NO CREDIT TRACKING FOR RESTAGING - It's free!
    // Restaging doesn't consume demo credits or increment usage counters

    // SUCCESS: Return the result
    res.status(200).json({
      success: true,
      message: "Restaged image generated successfully!",
      data: {
        stagedImageUrl: restagedUrl,
        stagedId: stagedFileName, // Always return the new staged file name for further restaging
        roomType,
        stagingStyle,
        prompt: prompt || null,
        storage: "supabase",
        isDemo, // Still return demo status for frontend
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: ImageErrorCode.UNKNOWN_ERROR,
        message: ErrorMessages[ImageErrorCode.UNKNOWN_ERROR],
        details: error instanceof Error ? error.message : undefined,
      },
    });
  }
}

/**
 * Get recent uploads from Supabase Storage
 */
export async function getRecentUploads(req: Request, res: Response): Promise<void> {
  try {
    // Check if user is authenticated
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required to view your uploads.",
        },
      });
      return;
    }

    const userId = req.user.id;
    const { limit = 10 } = req.query;
    const maxLimit = Math.min(Number(limit), 50); // Cap at 50 groups
    const rawLimit = Math.min(maxLimit * 8, 400);

    // Fetch user's images from database
    const userImages = await prisma.image.findMany({
      where: {
        user_id: userId,
      },
      orderBy: {
        created_at: "desc",
      },
      take: rawLimit,
    });

    const grouped = new Map<string, any>();

    for (const img of userImages) {
      const originalUrl = toPublicImageUrl(img.original_image_url, req);
      const key = originalUrl;
      const originalFilename = originalUrl.split("/").pop() || "original";

      if (!grouped.has(key)) {
        grouped.set(key, {
          groupId: `${img.user_id || "user"}:${originalUrl}`,
          original: {
            filename: originalFilename,
            url: originalUrl,
            createdAt: img.created_at.toISOString(),
            status: img.status,
          },
          staged: null,
          stagedVariants: [],
          createdAt: img.created_at.toISOString(),
          statusSummary: {
            processing: 0,
            completed: 0,
            failed: 0,
          },
        });
      }

      const group = grouped.get(key);
      if (img.created_at < new Date(group.createdAt)) {
        group.createdAt = img.created_at.toISOString();
      }

      if (img.status === image_status.PROCESSING) group.statusSummary.processing += 1;
      if (img.status === image_status.COMPLETED) group.statusSummary.completed += 1;
      if (img.status === image_status.FAILED) group.statusSummary.failed += 1;

      if (img.staged_image_url) {
        const stagedUrl = toPublicImageUrl(img.staged_image_url, req);
        const stagedFilename = stagedUrl.split("/").pop() || "staged";
        group.stagedVariants.push({
          id: img.id,
          filename: stagedFilename,
          url: stagedUrl,
          createdAt: img.updated_at.toISOString(),
          status: img.status,
        });
      }
    }

    const uploads = Array.from(grouped.values())
      .map((group: any) => {
        group.stagedVariants.sort((a: any, b: any) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        group.staged = group.stagedVariants[0] || null;
        return group;
      })
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, maxLimit);

    res.status(200).json({
      success: true,
      data: {
        uploads,
        total: uploads.length,
        limit: maxLimit,
        storage: "database",
      },
    });
  } catch (error) {
    logger(`Error getting recent uploads: ${error}`);
    res.status(500).json({
      success: false,
      error: {
        code: ImageErrorCode.UNKNOWN_ERROR,
        message: "Failed to retrieve recent uploads. Please try again.",
        details: error instanceof Error ? error.message : undefined,
      },
    });
  }
}

export async function generateImage(req: Request, res: Response): Promise<void> {
  let isAdmin = false;
  let userId: string | null = null;
  let teamId: string | null = req.body.teamId || null; // Get teamId from request body
  let projectId: string | null = req.body.projectId || null; // Get projectId from request body
  let teamMembership: any = null;
  let isTeamOwner = false;

  // Check if user is authenticated
  if (req.user && req.user.id) {
    userId = req.user.id;
    const verifyRole = await prisma.user_roles.findFirst({
      where: { user_id: userId },
      include: { role: true }
    })

    isAdmin = verifyRole?.role.name == "ADMIN" ? true : false;
  }

  // Validate teamId - only process if it's a non-empty string
  // Empty strings, "undefined", null, etc. should not be treated as valid teamIds
  if (!teamId || typeof teamId !== 'string' || teamId.trim() === '' || teamId === 'undefined' || teamId === 'null') {
    teamId = null;
  }

  // Validate projectId
  if (!projectId || typeof projectId !== 'string' || projectId.trim() === '' || projectId === 'undefined' || projectId === 'null') {
    projectId = null;
  }

  // If logged in and teamId provided, validate team access and credits
  if (userId && teamId) {
    // Check if user is team owner
    const team = await prisma.teams.findFirst({
      where: {
        id: teamId,
        owner_id: userId,
        deleted_at: null
      }
    });

    if (team) {
      isTeamOwner = true;
      // Check if owner has credits in team wallet
      if (team.wallet <= 0) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'Team has insufficient credits. Please purchase more credits.',
          },
        });
        return;
      }
    } else {
      // Check if user is team member with allocated credits
      teamMembership = await prisma.team_membership.findUnique({
        where: {
          team_id_user_id: {
            team_id: teamId,
            user_id: userId
          }
        },
        include: {
          team: true
        }
      });

      if (!teamMembership || teamMembership.team.deleted_at) {
        res.status(403).json({
          success: false,
          error: {
            code: 'TEAM_ACCESS_DENIED',
            message: 'You do not have access to this team.',
          },
        });
        return;
      }

      // Check if member has remaining credits
      const remainingCredits = teamMembership.allocated - teamMembership.used;
      if (remainingCredits <= 0) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'You have no remaining credits in this team. Please contact your team owner.',
          },
        });
        return;
      }
    }
  } else if (userId && !teamId) {
    // Logged in but no teamId provided - check personal credits first
    const personalCredits = await prisma.user_credit_balance.findUnique({
      where: { user_id: userId }
    });

    logger(`Personal credits check - userId: ${userId}, balance: ${personalCredits?.balance || 0}`);

    // If user has personal credits, they're not in demo mode
    // If they don't have credits, we'll check demo eligibility below
    const hasPersonalCredits = personalCredits && personalCredits.balance > 0;

    if (!hasPersonalCredits) {
      // No personal credits - check if they have purchased credits before
      const purchaseCount = await prisma.user_credit_purchase.count({
        where: {
          user_id: userId,
          status: 'completed',
        },
      });
      const hasPurchasedCredits = purchaseCount > 0;

      // If they've purchased credits before but ran out, show error
      // If they've never purchased credits, they can use demo credits
      if (hasPurchasedCredits) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'You have no remaining credits. Please purchase more credits to continue.',
          },
        });
        return;
      }
      // If they've never purchased, they fall through to demo credit logic below
    }
  }

  let inputImagePath: string | null = null;
  // Demo mode: guests OR logged-in users who haven't purchased credits
  let isDemo = !userId;
  let hasPurchasedCredits = false;

  // If logged in, check if they have purchased credits or personal credit balance
  if (userId) {
    const personalCredits = await prisma.user_credit_balance.findUnique({
      where: { user_id: userId }
    });
    const hasPersonalCredits = personalCredits && personalCredits.balance > 0;

    const purchaseCount = await prisma.user_credit_purchase.count({
      where: {
        user_id: userId,
        status: 'completed',
      },
    });
    hasPurchasedCredits = purchaseCount > 0;

    // User is NOT in demo mode if they have personal credits OR have purchased before
    // User IS in demo mode if they have never purchased and no personal credits
    if (!hasPersonalCredits && !hasPurchasedCredits) {
      isDemo = true;
    } else {
      isDemo = false;
    }
  }

  const fingerprint = resolveDemoFingerprint({
    cookieDeviceId: req.cookies?.device_id,
    headerFingerprint: req.headers['x-fingerprint'] as string | undefined,
    ip: req.ip,
  });
  let demoLimitReached = false;
  let blocked = false;
  let guestId = null;
  let unifiedCount = 0;

  // Use unified demo tracking if in demo mode
  if (isDemo) {
    const tracking = await getUnifiedDemoTracking(userId, fingerprint, req.ip || '');
    unifiedCount = tracking.unifiedCount;
    demoLimitReached = tracking.limitReached;
    blocked = tracking.blocked;
    guestId = tracking.guestTracking?.id || null;

    // Link guest session to user if not already linked
    if (userId) {
      await linkGuestToUser(fingerprint, userId);
    }
  }

  if (blocked && !isAdmin) {
    res.status(403).json({
      success: false,
      error: {
        code: 'DEMO_BLOCKED',
        message: 'Demo access blocked due to abuse. Please contact support or sign up.',
      },
    });
    return;
  }
  if (demoLimitReached && !isAdmin) {
    const message = userId
      ? 'Demo limit reached. Please purchase credits to continue. The limit resets on the 1st of each month.'
      : 'Demo limit reached. Please sign up or purchase credits to continue. The limit resets on the 1st of each month.';

    res.status(429).json({
      success: false,
      error: {
        code: 'DEMO_LIMIT_REACHED',
        message,
      },
    });
    return;
  }

  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.NO_FILE_PROVIDED,
          message: ErrorMessages[ImageErrorCode.NO_FILE_PROVIDED],
        },
      });
      return;
    }

    inputImagePath = req.file.path;

    // Track demo upload - increment unified usage count
    if (isDemo) {
      await incrementUnifiedDemoUsage(userId, guestId);
      unifiedCount += 1;

      // Analytics event logging for demo uploads
      const ip = req.ip || '';
      const language = req.headers['accept-language'] || null;
      const deviceType = getDeviceTypeFromUserAgent(req.headers['user-agent']);
      const location = ip;

      // Check if this is a repeat demo user (3+ resets)
      const resetEvents = await prisma.analytics_event.count({
        where: {
          event_type: 'demo_limit_reset',
          ip,
        },
      });
      const isRepeatDemoUser = resetEvents >= 2;

      await prisma.analytics_event.create({
        data: {
          event_type: isRepeatDemoUser ? 'repeat_demo_upload' : 'demo_upload',
          user_id: userId || null,
          ip,
          language: typeof language === 'string' ? language.split(',')[0] : null,
          device_type: deviceType,
          location,
          source: 'demo',
        },
      });
    }

    // Validate file exists and is readable
    if (!fs.existsSync(inputImagePath)) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.FILE_READ_ERROR,
          message: ErrorMessages[ImageErrorCode.FILE_READ_ERROR],
        },
      });
      return;
    }

    const stats = fs.statSync(inputImagePath);
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (stats.size > maxSize) {
      fs.unlinkSync(inputImagePath);
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.FILE_TOO_LARGE,
          message: ErrorMessages[ImageErrorCode.FILE_TOO_LARGE],
          details: `File size: ${(stats.size / 1024 / 1024).toFixed(2)}MB. Maximum: 10MB`,
        },
      });
      return;
    }

    // const {
    //   prompt,
    //   roomType = "living-room",
    //   stagingStyle = "modern",
    //   keepLocalFiles = false,
    //   removeFurniture = false,
    // } = req.body;
    const {
      prompt,
      roomType = "living-room",
      stagingStyle = "modern",
      keepLocalFiles = false
    } = req.body;

    // Validate room type
    if (!VALID_ROOM_TYPES.includes(roomType.toLowerCase())) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.INVALID_ROOM_TYPE,
          message: ErrorMessages[ImageErrorCode.INVALID_ROOM_TYPE],
          details: `Valid room types: ${VALID_ROOM_TYPES.join(", ")}`,
        },
      });
      return;
    }

    // Validate staging style
    if (!VALID_STAGING_STYLES.includes(stagingStyle.toLowerCase())) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.INVALID_STAGING_STYLE,
          message: ErrorMessages[ImageErrorCode.INVALID_STAGING_STYLE],
          details: `Valid styles: ${VALID_STAGING_STYLES.join(", ")}`,
        },
      });
      return;
    }

    logger(`Processing image: roomType=${roomType}, style=${stagingStyle}`);

    // ============================================
    // AI PROCESSING: Stage the image
    // (Retry logic with fallback models handled by geminiService)
    // Optimized: Returns Buffer directly, no disk write
    // ============================================
    // MULTI-VARIATION AI GENERATION
    // SSE streaming response
    const NUM_VARIATIONS = 5;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    let originalUrl = null;
    try {
      originalUrl = await supabaseStorage.uploadOriginal(inputImagePath);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Failed to upload original image' })}\n\n`);
      res.end();
      return;
    }

    if (!inputImagePath) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'No input image path' })}\n\n`);
      res.end();
      return;
    }
    let hasSuccessfulGeneration = false;
    try {
      const generatedVariations = await geminiService.stageImageVariations(
        inputImagePath as string,
        roomType.toLowerCase(),
        stagingStyle.toLowerCase(),
        NUM_VARIATIONS,
        prompt
      );

      for (let i = 0; i < generatedVariations.length; i++) {
        let unwatermarked = generatedVariations[i];
        let watermarked = unwatermarked;
        if (isDemo && watermarked) {
          watermarked = await addWatermark(watermarked, "DEMO PREVIEW");
        }

        const stagedFileName = `staged-${Date.now()}-${i}.png`;
        const unwatermarkedFileName = `staged-unwatermarked-${Date.now()}-${i}.png`;
        const stagedUrl = await supabaseStorage.uploadStagedFromBuffer(watermarked, stagedFileName, "image/png");
        await supabaseStorage.uploadStagedFromBuffer(unwatermarked, unwatermarkedFileName, "image/png");

        const imageRecord = await prisma.image.create({
          data: {
            user_id: userId,
            project_id: projectId,
            original_image_url: originalUrl || '',
            staged_image_url: stagedUrl,
            watermarked_preview_url: isDemo ? stagedUrl : null,
            status: 'COMPLETED',
            is_demo: isDemo,
            room_type: roomType,
            staging_style: stagingStyle,
            prompt: prompt || null,
            source: isDemo ? 'demo' : 'user',
          }
        });

        res.write(`event: image\ndata: ${JSON.stringify({
          stagedImageUrl: stagedUrl,
          stagedId: unwatermarkedFileName,
          imageId: imageRecord.id,
          index: i,
          isDemo,
          roomType,
          stagingStyle,
          prompt: prompt || null,
          storage: "supabase",
          demoCount: isDemo ? unifiedCount : undefined,
          demoLimit: isDemo ? DEMO_LIMIT : undefined,
        })}\n\n`);

        hasSuccessfulGeneration = true;
      }
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: 'Failed to generate or upload image', error: String(err) })}\n\n`);
    }

    // Deduct credits after successful generation (1 credit per image set)
    if (hasSuccessfulGeneration && userId && teamId) {
      try {
        if (isTeamOwner) {
          // Deduct from team wallet
          await prisma.teams.update({
            where: { id: teamId },
            data: { wallet: { decrement: 1 } }
          });
        } else if (teamMembership) {
          // Deduct from member's allocated credits
          await prisma.team_membership.update({
            where: { id: teamMembership.id },
            data: { used: { increment: 1 } }
          });

          // Log usage
          await prisma.team_usage.create({
            data: {
              membership_id: teamMembership.id,
              image_id: originalUrl || 'unknown',
              credits_used: 1,
              teamsId: teamId,
            }
          });
        }
      } catch (err) {
        logger(`Failed to deduct credits: ${err}`);
        // Don't fail the request, just log the error
      }
    } else if (hasSuccessfulGeneration && userId && !teamId) {
      // Deduct from personal credits
      try {
        await prisma.user_credit_balance.update({
          where: { user_id: userId },
          data: { balance: { decrement: 1 } }
        });
      } catch (err) {
        logger(`Failed to deduct personal credits: ${err}`);
        // Don't fail the request, just log the error
      }
    }

    // Signal completion
    res.write('event: done\ndata: {}\n\n');
    res.end();
  } catch (error) {
    // ============================================
    // CATCH-ALL: Handle unexpected errors
    // ============================================
    logger(`Unexpected error in generateImage: ${error}`);

    // Clean up any uploaded files on error
    if (inputImagePath && fs.existsSync(inputImagePath)) {
      try {
        fs.unlinkSync(inputImagePath);
      } catch (cleanupError) {
        logger(`Failed to cleanup input file: ${cleanupError}`);
      }
    }

    if (error instanceof ImageProcessingError) {
      res.status(error.statusCode).json(error.toJSON());
    } else {
      res.status(500).json({
        success: false,
        error: {
          code: ImageErrorCode.UNKNOWN_ERROR,
          message: ErrorMessages[ImageErrorCode.UNKNOWN_ERROR],
          details: error instanceof Error ? error.message : undefined,
        },
      });
    }
  }
}

export async function analyzeImage(req: Request, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: {
          code: ImageErrorCode.NO_FILE_PROVIDED,
          message: ErrorMessages[ImageErrorCode.NO_FILE_PROVIDED],
        },
      });
      return;
    }

    const inputImagePath = req.file.path;

    try {
      const analysis = await geminiService.analyzeImage(inputImagePath);

      res.status(200).json({
        success: true,
        message: "Image analyzed successfully",
        data: {
          analysis,
          validRoomTypes: VALID_ROOM_TYPES,
          validStyles: VALID_STAGING_STYLES,
        },
      });
    } catch (aiError) {
      if (aiError instanceof ImageProcessingError) {
        res.status(aiError.statusCode).json(aiError.toJSON());
      } else {
        res.status(500).json({
          success: false,
          error: {
            code: ImageErrorCode.AI_PROCESSING_FAILED,
            message: "Failed to analyze the image. Please try again.",
            details: aiError instanceof Error ? aiError.message : undefined,
          },
        });
      }
    } finally {
      // Clean up uploaded file
      if (fs.existsSync(inputImagePath)) {
        fs.unlinkSync(inputImagePath);
      }
    }
  } catch (error) {
    logger(`Error analyzing image: ${error}`);
    res.status(500).json({
      success: false,
      error: {
        code: ImageErrorCode.UNKNOWN_ERROR,
        message: ErrorMessages[ImageErrorCode.UNKNOWN_ERROR],
        details: error instanceof Error ? error.message : undefined,
      },
    });
  }
}

export async function generateMultipleImages(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.files || !Array.isArray(req.files)) {
    res.status(400).json({
      success: false,
      error: {
        code: ImageErrorCode.NO_FILE_PROVIDED,
        message: ErrorMessages[ImageErrorCode.NO_FILE_PROVIDED],
      },
    });
    return;
  }

  if (!req.user) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  const VARIATIONS_PER_IMAGE = 5;
  const wantsStream =
    req.query.stream === "1" ||
    (typeof req.headers.accept === "string" && req.headers.accept.includes("text/event-stream"));

  const userId = req.user.id;
  
  // Support both single style (for all images) and per-image styles
  const { roomType = "living-room", stagingStyle = "modern", prompt } = req.body;
  
  // Parse per-image styles if provided as JSON strings
  let roomTypesList: string[] = [];
  let stagingStylesList: string[] = [];
  
  try {
    if (req.body.roomTypes && typeof req.body.roomTypes === 'string') {
      roomTypesList = JSON.parse(req.body.roomTypes);
    } else if (Array.isArray(req.body.roomTypes)) {
      roomTypesList = req.body.roomTypes;
    }
  } catch (e) {
    logger(`Failed to parse roomTypes: ${e}`);
  }
  
  try {
    if (req.body.stagingStyles && typeof req.body.stagingStyles === 'string') {
      stagingStylesList = JSON.parse(req.body.stagingStyles);
    } else if (Array.isArray(req.body.stagingStyles)) {
      stagingStylesList = req.body.stagingStyles;
    }
  } catch (e) {
    logger(`Failed to parse stagingStyles: ${e}`);
  }
  
  // Use per-image settings if provided, otherwise use single values for all
  roomTypesList = roomTypesList.length > 0 ? roomTypesList : Array(req.files?.length || 1).fill(roomType);
  stagingStylesList = stagingStylesList.length > 0 ? stagingStylesList : Array(req.files?.length || 1).fill(stagingStyle);
  
  let teamId: string | null = req.body.teamId || null;
  let projectId: string | null = req.body.projectId || null;

  const files = req.files as Express.Multer.File[];
  const creditsRequired = files.length;
  const MAX_MULTI_STAGE_IMAGES = 15;

  if (!creditsRequired) {
    res.status(400).json({
      success: false,
      error: {
        code: ImageErrorCode.NO_FILE_PROVIDED,
        message: ErrorMessages[ImageErrorCode.NO_FILE_PROVIDED],
      },
    });
    return;
  }

  if (creditsRequired > MAX_MULTI_STAGE_IMAGES) {
    res.status(400).json({
      success: false,
      error: {
        code: "MAX_IMAGES_EXCEEDED",
        message: `You can stage up to ${MAX_MULTI_STAGE_IMAGES} images at once. Please reduce your selection size.`,
      },
    });
    return;
  }

  if (!teamId || typeof teamId !== "string" || teamId.trim() === "" || teamId === "undefined" || teamId === "null") {
    teamId = null;
  }

  if (!projectId || typeof projectId !== "string" || projectId.trim() === "" || projectId === "undefined" || projectId === "null") {
    projectId = null;
  }

  let originalsWithUrls: Array<{ file: Express.Multer.File; originalUrl: string }> = [];
  try {
    originalsWithUrls = await Promise.all(
      files.map(async (file) => {
        const originalUrl = await supabaseStorage.uploadOriginal(file.path);
        return { file, originalUrl };
      })
    );
  } catch (uploadError) {
    res.status(500).json({
      success: false,
      error: {
        code: ImageErrorCode.STORAGE_UPLOAD_FAILED,
        message: "Failed to upload original images for multi-stage request.",
        details: uploadError instanceof Error ? uploadError.message : undefined,
      },
    });
    return;
  }

  let teamMembership: any = null;
  let isTeamOwner = false;

  if (teamId) {
    const team = await prisma.teams.findFirst({
      where: {
        id: teamId,
        owner_id: userId,
        deleted_at: null,
      },
    });

    if (team) {
      isTeamOwner = true;
      if (Number(team.wallet) < creditsRequired) {
        res.status(403).json({
          success: false,
          error: {
            code: "INSUFFICIENT_CREDITS",
            message: `Team has insufficient credits. Staging ${creditsRequired} images requires ${creditsRequired} credits.`,
          },
        });
        return;
      }
    } else {
      teamMembership = await prisma.team_membership.findUnique({
        where: {
          team_id_user_id: {
            team_id: teamId,
            user_id: userId,
          },
        },
        include: {
          team: true,
        },
      });

      if (!teamMembership || teamMembership.team.deleted_at) {
        res.status(403).json({
          success: false,
          error: {
            code: "TEAM_ACCESS_DENIED",
            message: "You do not have access to this team.",
          },
        });
        return;
      }

      const remainingCredits = Number(teamMembership.allocated) - Number(teamMembership.used);
      if (remainingCredits < creditsRequired) {
        res.status(403).json({
          success: false,
          error: {
            code: "INSUFFICIENT_CREDITS",
            message: `You have ${remainingCredits} remaining team credits, but staging ${creditsRequired} images requires ${creditsRequired} credits.`,
          },
        });
        return;
      }
    }
  } else {
    const personalCredits = await prisma.user_credit_balance.findUnique({
      where: { user_id: userId },
    });
    const personalBalance = Number(personalCredits?.balance || 0);
    if (personalBalance < creditsRequired) {
      res.status(403).json({
        success: false,
        error: {
          code: "INSUFFICIENT_CREDITS",
          message: `You have ${personalBalance} personal credits, but staging ${creditsRequired} images requires ${creditsRequired} credits.`,
        },
      });
      return;
    }
  }

  // Create DB records and deduct credits atomically
  const images = await prisma.$transaction(async (tx) => {
    const createdImages = await Promise.all(
      originalsWithUrls.map(({ originalUrl }, index) =>
        tx.image.create({
          data: {
            user_id: userId,
            project_id: projectId,
            original_image_url: originalUrl,
            status: image_status.PROCESSING,
            room_type: roomTypesList[index] || roomType,
            staging_style: stagingStylesList[index] || stagingStyle,
            prompt: prompt || null,
            source: "user",
            is_demo: false,
          },
        })
      )
    );

    if (teamId) {
      if (isTeamOwner) {
        await tx.teams.update({
          where: { id: teamId },
          data: { wallet: { decrement: creditsRequired } },
        });
      } else if (teamMembership) {
        await tx.team_membership.update({
          where: { id: teamMembership.id },
          data: { used: { increment: creditsRequired } },
        });

        if (createdImages.length > 0) {
          await tx.team_usage.createMany({
            data: createdImages.map((image) => ({
              membership_id: teamMembership.id,
              image_id: image.id,
              credits_used: 1,
              teamsId: teamId as string,
            })),
          });
        }
      }
    } else {
      await tx.user_credit_balance.update({
        where: { user_id: userId },
        data: { balance: { decrement: creditsRequired } },
      });
    }

    return createdImages;
  });

  // Push jobs to queue
  imageQueue.reset();
  images.forEach((image, index) => {
    imageQueue.add({
      imageId: image.id,
      originalPath: originalsWithUrls[index].file.path,
      roomType: roomTypesList[index] || roomType,
      stagingStyle: stagingStylesList[index] || stagingStyle,
      customPrompt: prompt,
    });
  });
  const queueStatus = imageQueue.getStatus();
  logger(`[MULTI-STAGE] Enqueued ${images.length} jobs: ${JSON.stringify(queueStatus)}`);

  if (!wantsStream) {
    res.status(202).json({
      success: true,
      message: "Images uploaded successfully. Staging started.",
      data: {
        total: images.length,
        imageIds: images.map((img) => img.id),
        creditsUsed: creditsRequired,
        creditScope: teamId ? "team" : "personal",
      },
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  const originalUrls = images.map((img) => img.original_image_url);
  const sentImageIds = new Set<string>();
  const expectedTotalVariants = creditsRequired * VARIATIONS_PER_IMAGE;
  const waves = Math.ceil(creditsRequired / Math.max(1, QUEUE_CONCURRENCY));
  const estimatedSeconds = Math.max(
    20,
    Math.ceil(waves * 22)
  );
  const runStartedAt = Date.now();
  const runId = `ms-${runStartedAt}-${userId.slice(0, 8)}`;

  logger(
    `[MULTI-STAGE][${runId}] START user=${userId} images=${images.length} expectedVariants=${expectedTotalVariants} queueConcurrency=${QUEUE_CONCURRENCY} est=${estimatedSeconds}s`
  );

  res.write(
    `event: accepted\ndata: ${JSON.stringify({
      totalImages: images.length,
      expectedVariantsPerImage: VARIATIONS_PER_IMAGE,
      expectedTotalVariants,
      estimatedSeconds,
      creditsUsed: creditsRequired,
      imageIds: images.map((img) => img.id),
    })}\n\n`
  );

  let monitorCheckCount = 0;
  const interval = setInterval(async () => {
    try {
      const rows = await prisma.image.findMany({
        where: {
          user_id: userId,
          original_image_url: { in: originalUrls },
        },
        orderBy: { created_at: "asc" },
      });

      const byOriginal = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byOriginal.get(row.original_image_url) || [];
        list.push(row);
        byOriginal.set(row.original_image_url, list);
      }

      let newlyStreamed = 0;
      for (let originalIndex = 0; originalIndex < originalUrls.length; originalIndex++) {
        const originalUrl = originalUrls[originalIndex];
        const list = (byOriginal.get(originalUrl) || []).sort(
          (a, b) => a.created_at.getTime() - b.created_at.getTime()
        );

        const completedRows = list.filter(
          (row) => row.status === image_status.COMPLETED && Boolean(row.staged_image_url)
        );

        for (const [variationIndex, row] of completedRows.entries()) {
          if (!sentImageIds.has(row.id)) {
            sentImageIds.add(row.id);
            newlyStreamed++;
            const stagedImageUrl = row.staged_image_url as string;
            const stagedId = stagedImageUrl.split("/").pop() || row.id;

            logger(
              `[MULTI-STAGE][${runId}] PROGRESS ${originalIndex + 1}/${originalUrls.length} => ${sentImageIds.size}/${expectedTotalVariants} total`
            );

            res.write(
              `event: image\ndata: ${JSON.stringify({
                imageId: row.id,
                originalIndex,
                variationIndex,
                stagedImageUrl,
                stagedId,
                roomType,
                stagingStyle,
                prompt: prompt || null,
                storage: "supabase",
              })}\n\n`
            );
          }
        }
      }

      const baseRows = rows.filter((row) => images.some((img) => img.id === row.id));
      const hasProcessingBase = baseRows.some((row) => row.status === image_status.PROCESSING);
      const queueStatus = imageQueue.getStatus();
      
      const baseStatusCounts = {
        processing: baseRows.filter((r) => r.status === image_status.PROCESSING).length,
        completed: baseRows.filter((r) => r.status === image_status.COMPLETED).length,
        failed: baseRows.filter((r) => r.status === image_status.FAILED).length,
      };
      
      // Only log monitor status every 5 checks or when progress changes
      if (monitorCheckCount % 5 === 0 || newlyStreamed > 0) {
        logger(
          `[MULTI-STAGE][${runId}] Monitor: streamed=${sentImageIds.size}/${expectedTotalVariants} base=[P:${baseStatusCounts.processing} C:${baseStatusCounts.completed} F:${baseStatusCounts.failed}] queue=[Q:${queueStatus.queued} R:${queueStatus.running}]`
        );
      }
      monitorCheckCount++;

      // Only end stream when: (1) no base images are processing AND (2) queue is idle
      const shouldEndStream = !hasProcessingBase && queueStatus.isIdle;

      if (shouldEndStream) {
        logger(
          `[MULTI-STAGE][${runId}] TERMINATING queue=${JSON.stringify(queueStatus)} baseProcessing=${hasProcessingBase}`
        );

        clearInterval(interval);
        const failedOrMissing = Math.max(0, expectedTotalVariants - sentImageIds.size);

        const perOriginalSummary: MultiRunOriginalSummary[] = originalUrls.map((originalUrl, originalIndex) => {
          const list = byOriginal.get(originalUrl) || [];
          return {
            originalIndex,
            originalFile: originalUrl.split("/").pop() || originalUrl,
            totalRows: list.length,
            completed: list.filter((row) => row.status === image_status.COMPLETED).length,
            processing: list.filter((row) => row.status === image_status.PROCESSING).length,
            failed: list.filter((row) => row.status === image_status.FAILED).length,
          };
        });

        const runEndedAt = Date.now();
        const elapsedSeconds = Math.max(0, Math.round((runEndedAt - runStartedAt) / 1000));

        logger(
          `[MULTI-STAGE][${runId}] DONE streamed=${sentImageIds.size}/${expectedTotalVariants} failedOrMissing=${failedOrMissing} elapsed=${elapsedSeconds}s`
        );
        console.table(
          perOriginalSummary.map((row) => ({
            original: row.originalIndex + 1,
            file: row.originalFile,
            rows: row.totalRows,
            completed: row.completed,
            processing: row.processing,
            failed: row.failed,
          }))
        );

        // Log to MongoDB
        const quotaExhausted = failedOrMissing > 0 && sentImageIds.size > 0;
        const completedVariants = sentImageIds.size;
        const failedVariants = failedOrMissing;
        const status = completedVariants === expectedTotalVariants ? 'completed' : (completedVariants > 0 ? 'partial' : 'failed');

        loggingService.logMultiImageRun({
          runId,
          userId,
          userEmail: req.user?.email,
          teamId: teamId || undefined,
          totalImages: images.length,
          expectedVariants: expectedTotalVariants,
          completedVariants,
          failedVariants,
          roomType,
          stagingStyle,
          prompt: prompt || undefined,
          creditsUsed: creditsRequired,
          queueConcurrency: QUEUE_CONCURRENCY,
          rateLimit: '18/min',
          estimatedSeconds,
          elapsedSeconds,
          status,
          images: perOriginalSummary.map(summary => ({
            originalFile: summary.originalFile,
            totalVariations: summary.totalRows,
            completed: summary.completed,
            failed: summary.failed,
          })),
          quotaExhausted,
        });

        appendMultiImageRunReport({
          runId,
          userId,
          totalImages: images.length,
          expectedTotalVariants,
          streamedTotal: sentImageIds.size,
          failedOrMissing,
          estimatedSeconds,
          startedAt: runStartedAt,
          endedAt: runEndedAt,
          rows: perOriginalSummary,
        }).catch((reportErr: any) => {
          logger(`[MULTI-STAGE][${runId}] REPORT_WRITE_FAILED ${reportErr}`);
        });

        res.write(
          `event: done\ndata: ${JSON.stringify({
            totalStreamed: sentImageIds.size,
            expectedTotalVariants,
            failedOrMissing,
          })}\n\n`
        );
        res.end();
      }
    } catch (streamErr) {
      clearInterval(interval);
      logger(
        `[MULTI-STAGE][${runId}] STREAM_ERROR ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`
      );
      res.write(
        `event: error\ndata: ${JSON.stringify({
          message: "Failed while streaming multi-image progress",
          details: streamErr instanceof Error ? streamErr.message : String(streamErr),
        })}\n\n`
      );
      res.end();
    }
  }, 700);

  req.on("close", () => {
    clearInterval(interval);
  });
}