import { Router } from "express";
import passport from "../config/passport";
import { requireAuth } from "../middlewares/auth";
import { uploadImage } from "../middlewares/uploadImage";
import {
  login,
  signup,
  oauthCallback,
  oauthFailure,
  getAvailableProviders,
  updateProfileImage,
  deleteProfileImage,
} from "../controllers/auth.controller";
import { logger } from "../utils/logger";

const router = Router();

const encodeOAuthState = (payload: { intent: "signin" | "signup"; agreementsAccepted: boolean }) => {
  const intentPart = payload.intent === "signup" ? "signup" : "signin";
  const agreementsPart = payload.agreementsAccepted ? "1" : "0";
  return `${intentPart}.${agreementsPart}.${Date.now()}`;
};

const decodeOAuthState = (rawState: unknown): { intent: "signin" | "signup"; agreementsAccepted: boolean } | null => {
  if (typeof rawState !== "string" || !rawState) {
    return null;
  }

  const simpleParts = rawState.split(".");
  if (simpleParts.length >= 2) {
    const intent = simpleParts[0] === "signup" ? "signup" : simpleParts[0] === "signin" ? "signin" : null;
    const agreementsAccepted = simpleParts[1] === "1" ? true : simpleParts[1] === "0" ? false : null;

    if (intent && agreementsAccepted !== null) {
      return { intent, agreementsAccepted };
    }
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(rawState));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const intent = (parsed as any).intent === "signup" ? "signup" : "signin";
    const agreementsAccepted = (parsed as any).agreementsAccepted === true;
    return { intent, agreementsAccepted };
  } catch {
    try {
      const parsed = JSON.parse(Buffer.from(rawState, "base64url").toString("utf8"));
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const intent = (parsed as any).intent === "signup" ? "signup" : "signin";
      const agreementsAccepted = (parsed as any).agreementsAccepted === true;
      return { intent, agreementsAccepted };
    } catch {
      return null;
    }
  }
};

const getCookieFromHeader = (rawCookieHeader: unknown, name: string): string | null => {
  if (typeof rawCookieHeader !== "string" || !rawCookieHeader) {
    return null;
  }

  const pairs = rawCookieHeader.split(";");
  for (const pair of pairs) {
    const [key, ...valueParts] = pair.trim().split("=");
    if (key === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
};

router.post("/signup", signup);
router.post("/login", login);
router.patch("/profile-image", requireAuth, uploadImage, updateProfileImage);
router.delete("/profile-image", requireAuth, deleteProfileImage);

// Get available OAuth providers
router.get("/providers", getAvailableProviders);

// Google OAuth
router.get("/google", (req, res, next) => {
  const intent =
    req.query.intent === "signup" || req.query.signupIntent === "true"
      ? "signup"
      : "signin";
  const agreementsAccepted = req.query.agreementsAccepted === "true" || req.query.agreementsAccepted === "1";
  const state = encodeOAuthState({ intent, agreementsAccepted });

  res.cookie("oauth_intent", intent, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  res.cookie("oauth_agreements_accepted", agreementsAccepted ? "true" : "false", {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  const googleAuthOptions: any = {
    scope: ["profile", "email"],
    state,
  };

  passport.authenticate("google", googleAuthOptions)(req, res, next);
});
router.get("/google/callback", (req, res, next) => {
  passport.authenticate("google", { session: false }, (err, user, info) => {
    if (err) {
      logger(`Google OAuth error: ${err.message || err}`);
      const errorCode = (err as any)?.code;
      if (errorCode === "OAUTH_ACCOUNT_NOT_FOUND") {
        return res.redirect("/api/auth/failure?provider=google&error=oauth_account_not_found");
      }
      if (errorCode === "OAUTH_AGREEMENTS_REQUIRED") {
        return res.redirect("/api/auth/failure?provider=google&error=oauth_agreements_required");
      }
      return res.redirect("/api/auth/failure?provider=google");
    }

    const statePayload = decodeOAuthState(req.query.state);
    const cookieIntent = getCookieFromHeader(req.headers.cookie, "oauth_intent");
    const intentFromQuery =
      req.query.intent === "signup" || req.query.signupIntent === "true"
        ? "signup"
        : req.query.intent === "signin"
          ? "signin"
          : null;
    const intent = intentFromQuery || statePayload?.intent || (cookieIntent === "signup" ? "signup" : "signin");
    const infoCode = (info as any)?.code;
    if (infoCode === "OAUTH_ACCOUNT_NOT_FOUND") {
      return res.redirect("/api/auth/failure?provider=google&error=oauth_account_not_found");
    }
    if (infoCode === "OAUTH_AGREEMENTS_REQUIRED") {
      return res.redirect("/api/auth/failure?provider=google&error=oauth_agreements_required");
    }

    if (!user) {
      logger("Google OAuth: No user returned from strategy");
      if (intent === "signin") {
        return res.redirect("/api/auth/failure?provider=google&error=oauth_account_not_found");
      }
      return res.redirect("/api/auth/failure?provider=google&error=oauth_agreements_required");
    }

    // Ensure the _oauth property is preserved
    // The user object from passport strategy should have _oauth attached
    if (!(user as any)._oauth) {
      logger("Google OAuth: _oauth property missing from user object");
      return res.redirect("/api/auth/failure?provider=google");
    }

    // Attach the full OAuth result to req.user._oauth
    req.user = user as Express.User;
    next();
  })(req, res, next);
}, oauthCallback);


// Facebook OAuth
router.get("/facebook", passport.authenticate("facebook", { scope: ["email", "public_profile"] }));
router.get(
  "/facebook/callback",
  passport.authenticate("facebook", { session: false, failureRedirect: "/api/auth/failure?provider=facebook" }),
  oauthCallback
);

// Apple OAuth
router.post("/apple", passport.authenticate("apple", { scope: ["name", "email"] }));
router.post(
  "/apple/callback",
  passport.authenticate("apple", { session: false, failureRedirect: "/api/auth/failure?provider=apple" }),
  oauthCallback
);

// Unified OAuth failure handler
router.get("/failure", oauthFailure);

export default router;
