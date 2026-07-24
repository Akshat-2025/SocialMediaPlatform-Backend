const { z } = require("zod");

const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30)
    .regex(/^[a-zA-Z0-9_.]+$/, "Username can only contain letters, numbers, underscores and dots"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  fullName: z.string().min(1, "Full name is required").max(50),
});

const loginSchema = z.object({
  emailOrUsername: z.string().min(1, "Email or username is required"),
  password: z.string().min(1, "Password is required"),
});

const updateProfileSchema = z.object({
  fullName: z.string().min(1).max(50).optional(),
  bio: z.string().max(160).optional(),
});

module.exports = { registerSchema, loginSchema, updateProfileSchema };
