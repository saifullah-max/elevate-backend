import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";
import AppleStrategy from "passport-apple";
import { Strategy as JWTStrategy, ExtractJwt } from "passport-jwt";
import { oauthService } from "../services/oauth.service";
import { getOAuthConfig, OAuthUserProfile } from "./oauth.config";
import { logger } from "../utils/logger";

const parseOAuthState = (rawState: unknown): { intent: "signin" | "signup"; agreementsAccepted: boolean } | null => {
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

// JWT STRATEGY
const jwtSecret = process.env.JWT_SECRET;
if (jwtSecret) {
  passport.use(
    new JWTStrategy(
      {
        jwtFromRequest: (req) => {
          const authHeader = req.headers.authorization;
          logger(`[JWT Extract] Auth header: ${authHeader ? authHeader.substring(0, 50) + '...' : 'none'}`);
          const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
          logger(`[JWT Extract] Extracted token: ${token ? token.substring(0, 20) + '...' : 'failed'}`);
          return token;
        },
        secretOrKey: jwtSecret,
      },
      async (jwtPayload: any, done: (error: any, user?: any) => void) => {
        try {
          logger(`[JWT Strategy] Callback invoked with payload: ${JSON.stringify(jwtPayload)}`);
          
          // The JWT payload contains the user information (use userId or id)
          const user = {
            id: jwtPayload.userId || jwtPayload.id,
            role: jwtPayload.role,
          };

          logger(`[JWT Strategy] User authenticated successfully. userId=${user.id}, role=${user.role}`);
          return done(null, user);
        } catch (error) {
          logger(`[JWT Strategy] Error: ${error instanceof Error ? error.message : String(error)}`);
          return done(error as Error);
        }
      }
    )
  );
  logger("[Passport] JWT strategy configured with secret length: " + jwtSecret.length);
} else {
  logger("[Passport] JWT not configured (missing JWT_SECRET)");
}

// GOOGLE STRATEGY
const googleConfig = getOAuthConfig("google");
if (googleConfig) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: googleConfig.clientID,
        clientSecret: googleConfig.clientSecret,
        callbackURL: googleConfig.callbackURL,
        scope: googleConfig.scope,
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          logger(`Google OAuth strategy: Received profile for email=${profile.emails?.[0]?.value}, id=${profile.id}`);

          const statePayload = parseOAuthState(req.query.state);
          const cookieIntent = getCookieFromHeader(req.headers.cookie, "oauth_intent");
          const cookieAgreementsAccepted = getCookieFromHeader(req.headers.cookie, "oauth_agreements_accepted") === "true";
          const intentFromQuery =
            req.query.intent === "signup" || req.query.signupIntent === "true"
              ? "signup"
              : req.query.intent === "signin"
                ? "signin"
                : null;
          const oauthIntent = intentFromQuery || statePayload?.intent || (cookieIntent === "signup" ? "signup" : "signin");
          const agreementsFromQuery = req.query.agreementsAccepted === "true" || req.query.agreementsAccepted === "1";
          const agreementsAccepted =
            agreementsFromQuery || statePayload?.agreementsAccepted || cookieAgreementsAccepted;

          const allowCreate = oauthIntent === "signup" && agreementsAccepted;
          const disallowReason = oauthIntent === "signup" ? "AGREEMENTS_REQUIRED" : "SIGN_IN_ONLY";
          
          const result = await oauthService.authenticateOAuthUserWithOptions(
            {
              provider: "google",
              providerId: profile.id,
              email: profile.emails?.[0]?.value || profile.id + "@example.com",
              name: profile.displayName || "",
              avatarUrl: profile.photos?.[0]?.value || null,
            },
            {
              allowCreate,
              disallowReason,
            }
          );

          logger(`Google OAuth strategy: User authenticated successfully. userId=${result.user.id}, isNewUser=${result.isNewUser}`);

          // Minimal Express User
          const user = {
            id: result.user.id,
            email: result.user.email,
            role: result.user.role,
          };

          // Store full OAuthResult in passport session (or locals) for callback
          // This way req.user stays type-safe
          (user as any)._oauth = result; // temporary storage

          logger(`Google OAuth strategy: User object created with _oauth property attached`);

          return done(null, user);
        } catch (error) {
          logger(`Google OAuth strategy error: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof Error) {
            logger(`Google OAuth strategy error stack: ${error.stack}`);
          }
          return done(error as Error);
        }
      }
    )
  );


  logger("Google OAuth strategy configured");
} else {
  logger("Google OAuth not configured (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)");
}

// FACEBOOK STRATEGY
// const facebookConfig = getOAuthConfig("facebook");
// if (facebookConfig) {
//   passport.use(
//     new FacebookStrategy(
//       {
//         clientID: facebookConfig.clientID,
//         clientSecret: facebookConfig.clientSecret,
//         callbackURL: facebookConfig.callbackURL,
//         profileFields: ["id", "emails", "name", "displayName", "photos"],
//       },
//       async (accessToken, refreshToken, profile, done) => {
//         try {
//           const oauthUser: OAuthUserProfile = {
//             providerId: profile.id,
//             provider: "facebook",
//             email: profile.emails?.[0]?.value || "",
//             name: profile.displayName || `${profile.name?.givenName} ${profile.name?.familyName}`.trim() || "",
//             avatarUrl: profile.photos?.[0]?.value || null,
//           };

//           if (!oauthUser.email) {
//             return done(new Error("Email not provided by Facebook. Please ensure email permission is granted."), undefined);
//           }

//           const result = await oauthService.authenticateOAuthUser(oauthUser);
//           return done(null, result);
//         } catch (error) {
//           logger(`Facebook auth error: ${error}`);
//           return done(error as Error, undefined);
//         }
//       }
//     )
//   );
//   logger("Facebook OAuth strategy configured");
// } else {
//   logger("Facebook OAuth not configured (missing FACEBOOK_APP_ID or FACEBOOK_APP_SECRET)");
// }

// APPLE STRATEGY
const appleClientID = process.env.APPLE_CLIENT_ID;
const appleTeamID = process.env.APPLE_TEAM_ID;
const appleKeyID = process.env.APPLE_KEY_ID;
const applePrivateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

// if (appleClientID && appleTeamID && appleKeyID && applePrivateKey) {
//   const baseUrl = process.env.BASE_URL || "http://localhost:3003";
//   passport.use(
//     new AppleStrategy(
//       {
//         clientID: appleClientID,
//         teamID: appleTeamID,
//         keyID: appleKeyID,
//         privateKeyString: applePrivateKey,
//         callbackURL: process.env.APPLE_CALLBACK_URL || `${baseUrl}/api/auth/apple/callback`,
//         scope: ["name", "email"],
//         passReqToCallback: false,
//       },
//       async (
//         accessToken: string,
//         refreshToken: string,
//         idToken: any,
//         profile: any,
//         done: (error: any, user?: any) => void
//       ) => {
//         try {
//           const oauthUser: OAuthUserProfile = {
//             providerId: idToken.sub || profile.id,
//             provider: "apple",
//             email: idToken.email || profile.email || "",
//             name: profile.name
//               ? `${profile.name.firstName || ""} ${profile.name.lastName || ""}`.trim()
//               : "",
//             avatarUrl: null,
//           };

//           if (!oauthUser.email) {
//             return done(new Error("Email not provided by Apple"), undefined);
//           }

//           const result = await oauthService.authenticateOAuthUser(oauthUser);
//           return done(null, result);
//         } catch (error) {
//           logger(`Apple auth error: ${error}`);
//           return done(error, undefined);
//         }
//       }
//     )
//   );
//   logger("OAuth strategy configured");
// } else {
//   logger("Apple OAuth not configured (missing APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, or APPLE_PRIVATE_KEY)");
// }

// SERIALIZATION (for session-less JWT auth)
passport.serializeUser((user: any, done) => {
  done(null, user);
});

passport.deserializeUser((user: any, done) => {
  done(null, user);
});

export default passport;
