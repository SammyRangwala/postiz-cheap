import { NextResponse } from "next/server";
import { processDuePosts } from "@/lib/services/publisher";

// Background scheduler endpoint. Called every few minutes by the GitHub Actions
// workflow in .github/workflows/scheduler.yml (and by Vercel Cron if enabled),
// so scheduled posts go out on time even when nobody has the dashboard open.
//
// It only ever publishes posts that are already due, and each post is claimed
// atomically, so extra calls are harmless. If CRON_SECRET is set, callers must
// send "Authorization: Bearer <CRON_SECRET>".
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  try {
    const summary = await processDuePosts();
    return NextResponse.json({ ok: true, ranAt: new Date().toISOString(), ...summary });
  } catch (error) {
    console.error("[CRON_PUBLISH_ERROR]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
