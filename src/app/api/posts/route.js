import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { UserService } from "@/lib/services/user";
import config from "@/lib/config";
import { DemoStore } from "@/lib/demo-store";
import { processDuePosts, triggerMuApiPublish } from "@/lib/services/publisher";

// GET: List posts + Process Due Posts + Poll Status
export async function GET(req) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const userId = session.user.id;

    // 1. Fetch current posts from database with fallback
    let posts = [];
    try {
      posts = await prisma.scheduledPost.findMany({
        where: { userId },
        orderBy: { scheduledAt: "desc" }
      });
    } catch (dbErr) {
      console.warn("[POSTS_GET_FALLBACK] Database offline, returning DemoStore posts:", dbErr.message);
      return NextResponse.json(DemoStore.getPosts());
    }

    // Publish anything due and refresh statuses (the background scheduler
    // does the same every few minutes, so this is just a faster refresh).
    try {
      const summary = await processDuePosts({ userId });
      if (summary.triggered || summary.failed || summary.completed) {
        posts = await prisma.scheduledPost.findMany({
          where: { userId },
          orderBy: { scheduledAt: "desc" }
        });
      }
    } catch (procErr) {
      console.error("[POSTS_PROCESS_ERROR]", procErr);
    }

    return NextResponse.json(posts);
  } catch (error) {
    console.error("[GET_POSTS_ERROR]", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}

// POST: Schedule or Publish Immediately
export async function POST(req) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const userId = session.user.id;
    const body = await req.json();

    const {
      accountId = 101,
      accountName,
      title = "",
      description = "",
      tags = "",
      customTag = null,
      tagColor = null,
      mediaUrl,
      privacy = "public",
      scheduledAt,
      disableComment = false,
      disableDuet = false,
      disableStitch = false,
      categoryId,
      madeForKids = false,
      placement,
      shareToFeed = true,
      destinationLink = "",
      boardId = "",
      replySettings = "everyone"
    } = body;

    const targetPlatforms = Array.isArray(body.platforms) && body.platforms.length > 0
      ? body.platforms
      : (body.platform ? [body.platform] : []);

    if (targetPlatforms.length === 0) {
      return NextResponse.json({ error: "Select at least one channel to post to." }, { status: 400 });
    }

    // Every platform needs an image or video: either its own override or the
    // shared "All Channels" media.
    const overridesForCheck = body.platformOverrides || {};
    const isUsableMedia = (u) => typeof u === "string" && /^https:\/\//i.test(u.trim());
    const missingMedia = targetPlatforms.filter((plat) => {
      const norm = plat.toLowerCase().replace("x_twitter", "x").replace("twitter", "x");
      const ov = overridesForCheck[plat] || overridesForCheck[norm] || {};
      const url = (ov.mediaUrl && ov.mediaUrl.trim()) ? ov.mediaUrl : mediaUrl;
      return !isUsableMedia(url);
    });
    if (missingMedia.length > 0) {
      return NextResponse.json({
        error: `Every post needs an uploaded image or video. Missing or invalid media for: ${missingMedia.join(", ")}. Upload a file on the "All Channels" tab to use it everywhere.`
      }, { status: 400 });
    }

    let user = null;
    try {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: { credits: true }
      });
    } catch (e) {
      console.warn("[POSTS_USER_CREDITS_FALLBACK] DB unreachable, using default credits");
      user = { credits: 50 };
    }

    const costPerPost = config.ai.generationCost || 1;
    const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

    if (!isScheduled) {
      const totalCost = costPerPost * targetPlatforms.length;
      if (config.credits.enabled && user && user.credits < totalCost) {
        return NextResponse.json({
          error: `Insufficient credits. Publishing to ${targetPlatforms.length} platforms costs ${totalCost} credits, but you have ${user?.credits ?? 0}.`
        }, { status: 400 });
      }
    }

    const createdPosts = [];
    const platformAccountMap = body.platformAccountMap || {};

    let devAccounts = [];
    if (config.ai.apiKey) {
      try {
        const accRes = await fetch("https://muapi.ai/api/social/accounts", {
          headers: { "x-api-key": config.ai.apiKey }
        });
        if (accRes.ok) devAccounts = await accRes.json();
      } catch (_) {}
    }

    for (const plat of targetPlatforms) {
      const normPlat = plat.toLowerCase().replace("x_twitter", "x").replace("twitter", "x");
      let platAccountId = platformAccountMap[plat] || platformAccountMap[normPlat];
      let platAccountName = accountName;

      if (!platAccountId || platAccountId === 101) {
        const matched = devAccounts.find(a => (a.platform_name || "").toLowerCase() === normPlat);
        if (matched) {
          platAccountId = matched.id;
          platAccountName = matched.account_name || platAccountName;
        }
      }

      platAccountId = parseInt(platAccountId) || 101;
      platAccountName = platAccountName || `${plat} Account`;

      // Resolve platform-specific overrides if provided
      const override = (body.platformOverrides && (body.platformOverrides[plat] || body.platformOverrides[normPlat])) || {};
      const postTitle = (override.title !== undefined && override.title !== null && override.title.trim() !== "") ? override.title : title;
      const postDescription = (override.description !== undefined && override.description !== null && override.description.trim() !== "") ? override.description : description;
      const postTags = (override.tags !== undefined && override.tags !== null && override.tags.trim() !== "") ? override.tags : tags;
      const postMediaUrl = (override.mediaUrl !== undefined && override.mediaUrl !== null && override.mediaUrl.trim() !== "") ? override.mediaUrl : mediaUrl;

      if (isScheduled) {
        try {
          const post = await prisma.scheduledPost.create({
            data: {
              userId,
              accountId: platAccountId,
              platform: plat,
              accountName: platAccountName,
              mediaUrl: postMediaUrl,
              title: postTitle || "",
              description: postDescription || "",
              tags: postTags || "",
              customTag: customTag || null,
              tagColor: tagColor || null,
              privacy: privacy || "public",
              disableComment: !!disableComment,
              disableDuet: !!disableDuet,
              disableStitch: !!disableStitch,
              categoryId: categoryId || null,
              madeForKids: !!madeForKids,
              scheduledAt: new Date(scheduledAt),
              status: "scheduled"
            }
          });
          createdPosts.push(post);
        } catch (dbErr) {
          console.warn(`[POST_CREATE_FALLBACK] DB offline for ${plat}, saving to DemoStore:`, dbErr.message);
          const post = DemoStore.addPost({
            userId,
            accountId: platAccountId,
            platform: plat,
            accountName: platAccountName,
            mediaUrl: postMediaUrl,
            title: postTitle || "",
            description: postDescription || "",
            tags: postTags || "",
            customTag: customTag || null,
            tagColor: tagColor || null,
            privacy: privacy || "public",
            disableComment: !!disableComment,
            disableDuet: !!disableDuet,
            disableStitch: !!disableStitch,
            categoryId: categoryId || null,
            madeForKids: !!madeForKids,
            scheduledAt: new Date(scheduledAt).toISOString(),
            status: "scheduled"
          });
          createdPosts.push(post);
        }
      } else {
        // Immediate publish
        try {
          await UserService.deductCredits(userId, costPerPost);
        } catch (e) {}

        let requestId = null;
        let publishError = null;

        if (config.ai.apiKey && !config.ai.apiKey.includes("your_")) {
          try {
            requestId = await triggerMuApiPublish(plat, {
              accountId: platAccountId,
              mediaUrl: postMediaUrl,
              title: postTitle,
              description: postDescription,
              tags: postTags,
              privacy,
              disableComment,
              disableDuet,
              disableStitch,
              categoryId,
              madeForKids,
              placement,
              shareToFeed,
              destinationLink,
              boardId,
              replySettings
            });
          } catch (pubErr) {
            console.error(`[IMMEDIATE_PUBLISH_ERR] Failed for ${plat}:`, pubErr.message);
            publishError = pubErr.message;
          }
        }

        const postStatus = publishError ? "failed" : (requestId ? "processing" : "completed");
        const finalRequestId = requestId || ("req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));

        try {
          const post = await prisma.scheduledPost.create({
            data: {
              userId,
              accountId: platAccountId,
              platform: plat,
              accountName: platAccountName,
              mediaUrl: postMediaUrl,
              title: postTitle || "",
              description: postDescription || "",
              tags: postTags || "",
              customTag: customTag || null,
              tagColor: tagColor || null,
              privacy: privacy || "public",
              disableComment: !!disableComment,
              disableDuet: !!disableDuet,
              disableStitch: !!disableStitch,
              categoryId: categoryId || null,
              madeForKids: !!madeForKids,
              scheduledAt: new Date(),
              status: postStatus,
              requestId: finalRequestId,
              error: publishError
            }
          });
          createdPosts.push(post);
        } catch (dbErr) {
          console.warn(`[POST_IMMEDIATE_FALLBACK] DB offline for ${plat}, saving to DemoStore`);
          const post = DemoStore.addPost({
            userId,
            accountId: platAccountId,
            platform: plat,
            accountName: platAccountName,
            mediaUrl: postMediaUrl,
            title: postTitle || "",
            description: postDescription || "",
            tags: postTags || "",
            customTag: customTag || null,
            tagColor: tagColor || null,
            privacy: privacy || "public",
            scheduledAt: new Date().toISOString(),
            status: postStatus,
            requestId: finalRequestId,
            error: publishError,
            publishedUrl: `https://${plat}.com/sample_post`
          });
          createdPosts.push(post);
        }
      }
    }

    // Return created post(s)
    if (createdPosts.length === 1 && !Array.isArray(body.platforms)) {
      return NextResponse.json(createdPosts[0]);
    }
    return NextResponse.json({
      success: true,
      posts: createdPosts,
      count: createdPosts.length
    });
  } catch (error) {
    console.error("[POST_POSTS_ERROR]", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
