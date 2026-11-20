import crypto from "crypto";
import { prisma } from "@/lib/prisma";

// Connector tokens are random secrets shown to the user once. Only a SHA-256
// hash is stored, so a database leak doesn't expose a working token.
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");

export async function rotateToken(userId) {
  const token = "sms_" + crypto.randomBytes(24).toString("base64url");
  await prisma.user.update({ where: { id: userId }, data: { mcpTokenHash: hash(token) } });
  return token;
}

export async function revokeToken(userId) {
  await prisma.user.update({ where: { id: userId }, data: { mcpTokenHash: null } });
}

export async function hasToken(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { mcpTokenHash: true } });
  return !!u?.mcpTokenHash;
}

export async function userIdForToken(token) {
  if (!token || typeof token !== "string" || !token.startsWith("sms_") || token.length < 20) return null;
  const u = await prisma.user.findFirst({ where: { mcpTokenHash: hash(token) }, select: { id: true } });
  return u?.id || null;
}
