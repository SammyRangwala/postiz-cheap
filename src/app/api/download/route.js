import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

export async function GET(req) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const mediaUrl = searchParams.get("url");
  if (!mediaUrl) return NextResponse.json({ error: "Missing url" }, { status: 400 });
  let parsed;
  try { parsed = new URL(mediaUrl); } catch { return NextResponse.json({ error: "Invalid url" }, { status: 400 }); }
  if (parsed.protocol !== "https:") return NextResponse.json({ error: "Only https media URLs are allowed" }, { status: 400 });
  
  try {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error("Failed to fetch media");
    
    const buffer = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") || "video/mp4";
    const filename = mediaUrl.split("/").pop() || `download_${Date.now()}.mp4`;
    
    return new Response(Buffer.from(buffer), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("CORS proxy download error:", err);
    return NextResponse.redirect(mediaUrl); // fallback
  }
}
