import { Router } from "express";
import passport from "../config/passport";
import {
  login,
  signup,
  oauthCallback,
  oauthFailure,
  getAvailableProviders,
} from "../controllers/auth.controller";
import { logger } from "../utils/logger";

const router = Router();

router.post("/signup", signup);
router.post("/login", login);

// Get available OAuth providers
router.get("/providers", getAvailableProviders);

// Google OAuth
router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));
router.get("/google/callback", (req, res, next) => {
  passport.authenticate("google", { session: false }, (err, user, info) => {
    if (err) {
      logger(`Google OAuth error: ${err.message || err}`);
      return res.redirect("/api/auth/failure?provider=google");
    }
    if (!user) {
      logger("Google OAuth: No user returned from strategy");
      return res.redirect("/api/auth/failure?provider=google");
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
