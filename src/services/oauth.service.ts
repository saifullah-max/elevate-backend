import prisma from "../dbConnection";
import jwt from "jsonwebtoken";
import { OAuthUserProfile, OAuthProvider, providerIdFields, providerEnumValues } from "../config/oauth.config";
import { logger } from "../utils/logger";

const JWT_SECRET = process.env.JWT_SECRET || "changeme";

/**
 * OAuth Service - Unified handler for all OAuth providers
 * Follows DRY principle - single function handles Google, Facebook, Apple
 */
class OAuthService {
  /**
   * Public: Get user by ID (for latest role, etc.)
   */
  async getUserById(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  }

  async assignRoleToUser(userId: string, roleId: string) {
    return prisma.user_roles.create({
      data: {
        user_id: userId,
        role_id: roleId
      }
    })
  }
  /**
   * Authenticate or register a user via OAuth
   * Handles all providers uniformly
   */
  async authenticateOAuthUser(profile: OAuthUserProfile): Promise<{
    token: string;
    user: {
      id: string;
      email: string;
      name: string | null;
      role: string[];
      avatarUrl: string | null;
      authProvider: string;
    };
    success: boolean;
    isNewUser: boolean;
  }> {
    return this.authenticateOAuthUserWithOptions(profile, { allowCreate: true });
  }

  async authenticateOAuthUserWithOptions(
    profile: OAuthUserProfile,
    options: { allowCreate: boolean; disallowReason?: "SIGN_IN_ONLY" | "AGREEMENTS_REQUIRED" }
  ): Promise<{
    token: string;
    user: {
      id: string;
      email: string;
      name: string | null;
      role: string[];
      avatarUrl: string | null;
      authProvider: string;
    };
    success: boolean;
    isNewUser: boolean;
  }> {
    const { providerId, provider, email, name, avatarUrl } = profile;
    const providerIdField = providerIdFields[provider];
    const authProviderValue = providerEnumValues[provider];

    logger(`OAuth login attempt: provider=${provider}, email=${email}`);

    // Step 1: Try to find user by provider ID
    let user = await this.findUserByProviderId(provider, providerId);
    let isNewUser = false;

    if (!user) {
      // Step 2: Check if user exists with this email
      user = await prisma.user.findUnique({ where: { email } });

      if (user) {
        // Link OAuth account to existing user
        user = await this.linkProviderToUser(user.id, provider, providerId, avatarUrl);
        logger(`Linked ${provider} account to existing user: ${user.id}`);
      } else {
        if (!options.allowCreate) {
          const error: any = new Error(
            options.disallowReason === "AGREEMENTS_REQUIRED"
              ? "You must accept required registration agreements before signing up with Google."
              : "No account found. Please sign up first."
          );
          error.code = options.disallowReason === "AGREEMENTS_REQUIRED"
            ? "OAUTH_AGREEMENTS_REQUIRED"
            : "OAUTH_ACCOUNT_NOT_FOUND";
          throw error;
        }

        // Step 3: Create new user
        user = await this.createOAuthUser(profile);
        isNewUser = true;
        logger(`Created new user via ${provider}: ${user.id}`);
      }
    } else {
      // Update user info if changed
      user = await this.updateUserProfile(user.id, name, avatarUrl);
    }

    const roles = await prisma.user_roles.findMany({
      where: { user_id: user.id },
      include: { role: true },
    });

    const roleNames = roles.map(r => r.role.name);


    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, role: roleNames },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: roleNames,
        avatarUrl: user.avatar_url,
        authProvider: user.auth_provider,
      },
      success: true,
      isNewUser,
    };
  }

  /**
   * Find user by provider-specific ID
   */
  private async findUserByProviderId(provider: OAuthProvider, providerId: string) {
    const whereClause: any = {};
    whereClause[providerIdFields[provider]] = providerId;
    return prisma.user.findFirst({ where: whereClause });
  }

  /**
   * Link an OAuth provider to an existing user
   */
  private async linkProviderToUser(
    userId: string,
    provider: OAuthProvider,
    providerId: string,
    avatarUrl: string | null
  ) {
    const updateData: any = {};
    updateData[providerIdFields[provider]] = providerId;

    // Update avatar if user doesn't have one
    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser?.avatar_url && avatarUrl) {
      updateData.avatar_url = avatarUrl;
    }

    // Only update auth_provider if user doesn't have a password (pure OAuth user)
    if (!currentUser?.password_hash) {
      updateData.auth_provider = providerEnumValues[provider] as any;
    }

    return prisma.user.update({
      where: { id: userId },
      data: updateData,
    });
  }

  /**
   * Create a new user from OAuth profile
   */
  private async createOAuthUser(profile: OAuthUserProfile) {
    const { providerId, provider, email, name, avatarUrl } = profile;

    const createData: any = {
      email,
      name: name || null,
      avatar_url: avatarUrl,
      auth_provider: providerEnumValues[provider] as any,
    };

    createData[providerIdFields[provider]] = providerId;

    const user = await prisma.user.create({ data: createData });

    const defaultRole = await prisma.roles.findUnique({ where: { name: "USER" } });
    if (defaultRole) {
      await prisma.user_roles.create({
        data: {
          user_id: user.id,
          role_id: defaultRole.id,
        },
      });
    }

    return user;
  }


  /**
   * Update user profile with latest info from OAuth provider
   */
  private async updateUserProfile(
    userId: string,
    name: string | null,
    avatarUrl: string | null
  ) {
    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser) throw new Error("User not found");

    const updateData: any = {};

    // Only update if user doesn't have a name set
    if (!currentUser.name && name) {
      updateData.name = name;
    }

    // Update avatar if changed
    if (avatarUrl && avatarUrl !== currentUser.avatar_url) {
      updateData.avatar_url = avatarUrl;
    }

    if (Object.keys(updateData).length === 0) {
      return currentUser;
    }

    return prisma.user.update({
      where: { id: userId },
      data: updateData,
    });
  }

  /**
   * Get available OAuth providers status
   */
  getProvidersStatus(): Record<OAuthProvider, boolean> {
    return {
      google: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
      facebook: !!process.env.FACEBOOK_APP_ID && !!process.env.FACEBOOK_APP_SECRET,
      apple:
        !!process.env.APPLE_CLIENT_ID &&
        !!process.env.APPLE_TEAM_ID &&
        !!process.env.APPLE_KEY_ID &&
        !!process.env.APPLE_PRIVATE_KEY,
    };
  }
}

// Export singleton instance
export const oauthService = new OAuthService();
