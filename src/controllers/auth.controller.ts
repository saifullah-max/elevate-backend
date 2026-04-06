import { Request, Response } from "express";
import { ZodError } from "zod";
import { loginSchema, signupSchema } from "../utils/authSchemas";
import { loginService, signupService, updateProfileImageService, deleteProfileImageService } from "../services/auth.service";
import { oauthService } from "../services/oauth.service";
import { logger } from "../utils/logger";
import { OAuthResult } from "../types/auth";
import jwt from 'jsonwebtoken'
import prisma from "../dbConnection";
import { linkGuestToUser } from "../utils/demoTracking";

// FRONTEND_URL - prioritize env var (REQUIRED in production), default to localhost for development
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Warn if FRONTEND_URL is not set in production
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  console.warn('⚠️  WARNING: FRONTEND_URL environment variable is not set in production!');
}

// EMAIL/PASSWORD AUTH
export async function signup(req: Request, res: Response) {
  try {
    const data = signupSchema.parse(req.body);
    const fromDemoBonus = req.body.fromDemoBonus === true;
    const result = await signupService({ ...data, fromDemoBonus });
    
    // Link guest session to user after successful signup
    const deviceId = req.cookies?.device_id || req.headers["x-fingerprint"] as string;
    if (deviceId && result?.user?.id) {
      await linkGuestToUser(deviceId, result.user.id);
    }
    
    if (fromDemoBonus && result?.user?.id) {
      const userAgent = req.headers['user-agent'];
      const ua = Array.isArray(userAgent) ? userAgent[0] : userAgent || '';
      let deviceType: string | null = null;
      if (ua) {
        if (/mobile/i.test(ua)) deviceType = 'mobile';
        else if (/tablet/i.test(ua)) deviceType = 'tablet';
        else deviceType = 'desktop';
      }
      const language = req.headers['accept-language'] || null;
      const ip = req.ip || null;
      await prisma.analytics_event.create({
        data: {
          event_type: 'demo_bonus_granted',
          user_id: result.user.id,
          ip,
          language: typeof language === 'string' ? language.split(',')[0] : null,
          device_type: deviceType,
          location: ip,
          source: 'demo',
          timestamp: new Date(),
        },
      });
    }
    return res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation error", details: err.issues });
    }
    if (err && typeof err === "object" && "code" in err) {
      if ((err as any).code === "USER_EXISTS") {
        return res.status(409).json({ error: "User already exists" });
      }
    }
    return res.status(500).json({ error: "Internal server error", err });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const data = loginSchema.parse(req.body);
    const result = await loginService(data);
    
    // Link guest session to user after successful login
    const deviceId = req.cookies?.device_id || req.headers["x-fingerprint"] as string;
    if (deviceId && result.user?.id) {
      await linkGuestToUser(deviceId, result.user.id);
    }
    
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "Validation error", details: err.issues });
    }
    if (err && typeof err === "object" && "code" in err) {
      const errorCode = (err as any).code;
      if (errorCode === "INVALID_CREDENTIALS") {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      if (errorCode === "USE_OAUTH_LOGIN") {
        return res.status(400).json({
          error: "Please use social login for this account",
          code: "USE_OAUTH_LOGIN",
          provider: (err as any).provider,
        });
      }
    }
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function oauthCallback(req: Request, res: Response) {
  try {
    res.clearCookie("oauth_intent");
    res.clearCookie("oauth_agreements_accepted");
    res.clearCookie("oauth_error");

    if (!req.user) {
      logger("OAuth callback: req.user is missing");
      return res.redirect(`${FRONTEND_URL}/auth/callback?error=auth_failed`);
    }

    const user = req.user as Express.User & { _oauth?: OAuthResult };
    const authResult = (user as any)._oauth;

    if (!authResult) {
      logger(`OAuth callback: _oauth property missing. User object: ${JSON.stringify(user)}`);
      return res.redirect(`${FRONTEND_URL}/auth/callback?error=auth_failed`);
    }

    if (!authResult.token || !authResult.user) {
      logger(`OAuth callback: Invalid auth result structure: ${JSON.stringify(authResult)}`);
      return res.redirect(`${FRONTEND_URL}/auth/callback?error=auth_failed`);
    }

    logger(`OAuth callback success: userId=${authResult.user.id}, email=${authResult.user.email}, isNewUser=${authResult.isNewUser}`);

    // Link guest session to user after successful OAuth login
    const deviceId = req.cookies?.device_id || req.headers["x-fingerprint"] as string;
    if (deviceId && authResult.user.id) {
      await linkGuestToUser(deviceId, authResult.user.id);
    }

    // Now you have everything: token, isNewUser, avatarUrl, etc.
    // Always fetch the latest user from DB to get the latest role
    const latestUser = await oauthService.getUserById(authResult.user.id);

    const userRoles = await prisma.user_roles.findMany({
      where: { user_id: latestUser?.id },
      include: { role: true },
    });
    const roleNames = userRoles.map(ur => ur.role.name);
    const roleString = roleNames.join(",") || "USER";

    const params = new URLSearchParams({
      token: authResult.token,
      userId: authResult.user.id,
      email: authResult.user.email,
      name: authResult.user.name || "",
      provider: authResult.user.authProvider.toLowerCase(),
      isNewUser: authResult.isNewUser ? "true" : "false",
      role: roleString
    });

    if (authResult.user.avatarUrl) {
      params.append("avatarUrl", authResult.user.avatarUrl);
    }

    // Redirect to frontend callback page with token and user data
    return res.redirect(`${FRONTEND_URL}/auth/google/callback?${params.toString()}`);
  } catch (error) {
    logger(`OAuth callback error: ${error instanceof Error ? error.message : String(error)}`);
    return res.redirect(`${FRONTEND_URL}/auth/callback?error=server_error`);
  }
}


export async function oauthFailure(req: Request, res: Response) {
  const provider = req.query.provider || "unknown";
  const errorCode = typeof req.query.error === "string" ? req.query.error : "auth_failed";
  logger(`OAuth failure: provider=${provider}`);

  // Only return JSON for explicit programmatic/API requests.
  // Browser OAuth flows should always redirect back to frontend.
  const isExplicitApiRequest =
    req.query.format === "json" ||
    req.get("x-requested-with") === "XMLHttpRequest";

  if (isExplicitApiRequest) {
    return res.status(401).json({
      success: false,
      error: {
        code: "OAUTH_FAILED",
        message: `${String(provider).charAt(0).toUpperCase() + String(provider).slice(1)} authentication failed. Please try again.`,
        provider,
        reason: errorCode,
      },
    });
  }

  res.clearCookie("oauth_intent");
  res.clearCookie("oauth_agreements_accepted");
  res.cookie("oauth_error", errorCode, {
    httpOnly: false,
    sameSite: "lax",
    maxAge: 5 * 60 * 1000,
    path: "/",
  });

  const attempt = Date.now().toString();
  return res.redirect(`${FRONTEND_URL}/sign-in?error=${encodeURIComponent(errorCode)}&provider=${provider}&attempt=${attempt}`);
}

export async function getAvailableProviders(req: Request, res: Response) {
  const providers = oauthService.getProvidersStatus();
  return res.json({
    success: true,
    providers,
  });
}

export async function updateProfileImage(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    const file = req.file;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!file) {
      return res.status(400).json({ success: false, message: "Profile image file is required" });
    }

    const host = req.get("host") || "localhost:3003";
    const avatarUrl = `${req.protocol}://${host}/uploads/original/${file.filename}`;

    const result = await updateProfileImageService({ userId, avatarUrl });
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to update profile image",
    });
  }
}

export async function deleteProfileImage(req: Request, res: Response) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const result = await deleteProfileImageService({ userId });
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to delete profile image",
    });
  }
}
