import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { rotateToken, revokeToken, hasToken } from "@/lib/mcp/token";

// Manage the private Claude connector link for the signed-in user.

async function requireUser() {
  const session = await getServerSession(authOptions);
  return session?.user?.id || null;
}

function baseUrl(req) {
  return process.env.NEXTAUTH_URL || new URL(req.url).origin;
}

export async function GET() {
  const userId = await requireUser();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json({ active: await hasToken(userId) });
}

// Creates a new link (and invalidates any previous one). The full link is
// only returned here, once.
export async function POST(req) {
  const userId = await requireUser();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  const token = await rotateToken(userId);
  return NextResponse.json({ url: `${baseUrl(req).replace(/\/$/, "")}/api/mcp/${token}` });
}

export async function DELETE() {
  const userId = await requireUser();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  await revokeToken(userId);
  return NextResponse.json({ active: false });
}
