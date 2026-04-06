import prisma from "../dbConnection";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET!

export async function signupService({
  email,
  password,
  name,
  fromDemoBonus = false,
}: {
  email: string;
  password: string;
  name?: string;
  fromDemoBonus?: boolean;
}) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const err: any = new Error("User already exists");
    err.code = "USER_EXISTS";
    throw err;
  }
  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, password_hash: hash, name, auth_provider: "LOCAL" },
  });

  const defaultRole = await prisma.roles.findUnique({ where: { name: "USER" } });
  if (!defaultRole) {
    throw new Error("Default role 'USER' not found");
  }
  const assignRole = await prisma.user_roles.create({
    data: {
      user_id: user?.id,
      role_id: defaultRole?.id
    }
  })

  // Add 5 bonus credits if signing up from demo bonus offer
  if (fromDemoBonus) {
    await prisma.user_credit_balance.upsert({
      where: { user_id: user.id },
      create: {
        user_id: user.id,
        balance: 5,
      },
      update: {
        balance: {
          increment: 5,
        },
      },
    });
  }

  const token = jwt.sign({ userId: user.id, role: defaultRole.name }, JWT_SECRET, { expiresIn: "7d" });
  return {
    token,
    user: { id: user.id, email: user.email, name: user.name, role: defaultRole.name },
    success: true,
  };
}

export async function loginService({ email, password }: { email: string; password: string }) {
  const user = await prisma.user.findUnique({
    where: { email },
  });
  if (!user) {
    const err: any = new Error("Invalid credentials");
    err.code = "INVALID_CREDENTIALS";
    throw err;
  }

  // Check if user signed up with OAuth (no password set)
  if (!user.password_hash && user.auth_provider !== "LOCAL") {
    const err: any = new Error(`Please use ${user.auth_provider.toLowerCase()} login for this account`);
    err.code = "USE_OAUTH_LOGIN";
    err.provider = user.auth_provider.toLowerCase();
    throw err;
  }

  if (!user.password_hash) {
    const err: any = new Error("Invalid credentials");
    err.code = "INVALID_CREDENTIALS";
    throw err;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    const err: any = new Error("Invalid credentials");
    err.code = "INVALID_CREDENTIALS";
    throw err;
  }

  const userRole = await prisma.user_roles.findFirst({
    where: { user_id: user.id },
    include: { role: true }
  })

  if (!userRole) {
    const err: any = new Error("Invalid Role");
    err.code = "INVALID_USER_ROLE";
    throw err;
  }
  const userWithRole = {
    ...user,
    role: userRole.role.name,
  };
  const token = jwt.sign({ userId: user.id, role: userRole.role.name }, JWT_SECRET, { expiresIn: "7d" });
  return {
    token,
    user: userWithRole,
    success: true,
  };
}

export async function updateProfileImageService({
  userId,
  avatarUrl,
}: {
  userId: string;
  avatarUrl: string;
}) {
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!existingUser) {
    const err: any = new Error("User not found");
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      avatar_url: avatarUrl,
    },
  });

  const userRole = await prisma.user_roles.findFirst({
    where: { user_id: userId },
    include: { role: true },
  });

  return {
    success: true,
    message: "Profile image updated successfully",
    user: {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      role: userRole?.role.name || "USER",
      avatar_url: updatedUser.avatar_url,
    },
  };
}

export async function deleteProfileImageService({ userId }: { userId: string }) {
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!existingUser) {
    const err: any = new Error("User not found");
    err.code = "USER_NOT_FOUND";
    throw err;
  }

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      avatar_url: null,
    },
  });

  const userRole = await prisma.user_roles.findFirst({
    where: { user_id: userId },
    include: { role: true },
  });

  return {
    success: true,
    message: "Profile image removed successfully",
    user: {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name,
      role: userRole?.role.name || "USER",
      avatar_url: updatedUser.avatar_url,
    },
  };
}