import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";
import AppleStrategy from "passport-apple";
import { oauthService } from "../services/oauth.service";
import { getOAuthConfig, OAuthUserProfile } from "./oauth.config";
import { logger } from "../utils/logger";

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
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          logger(`Google OAuth strategy: Received profile for email=${profile.emails?.[0]?.value}, id=${profile.id}`);
          
          const result = await oauthService.authenticateOAuthUser({
            provider: "google",
            providerId: profile.id,
            email: profile.emails?.[0]?.value || profile.id + "@example.com",
            name: profile.displayName || "",
            avatarUrl: profile.photos?.[0]?.value || null,
          });

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
