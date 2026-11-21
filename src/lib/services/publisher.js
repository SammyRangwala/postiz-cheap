import { prisma } from "@/lib/prisma";
import { UserService } from "@/lib/services/user";
import config from "@/lib/config";

// Calls the MuAPI publishing endpoint for one platform and returns the request id.
export async function triggerMuApiPublish(platform, payload) {
  const apiKey = config.ai.apiKey;
  const plat = (platform || "").toLowerCase().replace("x_twitter", "x");

  const endpointMap = {
    youtube: "https://api.muapi.ai/api/v1/youtube-publish",
    tiktok: "https://api.muapi.ai/api/v1/tiktok-publish",
    instagram: "https://api.muapi.ai/api/v1/instagram-publish",
    x: "https://api.muapi.ai/api/v1/x-publish",
    facebook: "https://api.muapi.ai/api/v1/facebook-publish",
    linkedin: "https://api.muapi.ai/api/v1/linkedin-publish",
    threads: "https://api.muapi.ai/api/v1/threads-publish",
    pinterest: "https://api.muapi.ai/api/v1/pinterest-publish",
  };

  const endpoint = endpointMap[plat] || endpointMap.youtube;

  const captionText = [
    payload.title,
    payload.description,
    payload.tags ? payload.tags.split(",").map(t => t.trim().startsWith("#") ? t.trim() : `#${t.trim()}`).join(" ") : ""
  ].filter(Boolean).join("\n\n");

  const bodyData = {
    account_id: parseInt(payload.accountId),
    media_url: payload.mediaUrl
  };

  if (plat === "youtube") {
    bodyData.title = payload.title || "Untitled Video";
    bodyData.description = payload.description || "";
    bodyData.tags = payload.tags ? payload.tags.split(",").map(t => t.trim()) : [];
    bodyData.privacy = payload.privacy || "public";
    if (payload.categoryId) bodyData.category_id = payload.categoryId;
    bodyData.made_for_kids = payload.madeForKids || false;
  } else if (plat === "tiktok") {
    bodyData.title = payload.title || captionText;
    // TikTok only accepts its own privacy values; map the app's generic ones.
    const tiktokPrivacy = {
      public: "PUBLIC_TO_EVERYONE",
      unlisted: "FOLLOWER_OF_CREATOR",
      private: "SELF_ONLY",
      friends: "MUTUAL_FOLLOW_FRIENDS",
    };
    const allowed = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
    const rawPrivacy = payload.privacy || "PUBLIC_TO_EVERYONE";
    bodyData.privacy_level = allowed.includes(rawPrivacy)
      ? rawPrivacy
      : (tiktokPrivacy[String(rawPrivacy).toLowerCase()] || "PUBLIC_TO_EVERYONE");
    bodyData.disable_comment = payload.disableComment || false;
    bodyData.disable_duet = payload.disableDuet || false;
    bodyData.disable_stitch = payload.disableStitch || false;
  } else if (plat === "instagram") {
    bodyData.caption = captionText;
    bodyData.placement = "reels";
    bodyData.share_to_feed = true;
  } else if (plat === "x") {
    bodyData.caption = captionText.substring(0, 280);
    bodyData.reply_settings = "everyone";
  } else if (plat === "facebook") {
    bodyData.caption = captionText;
    bodyData.placement = "timeline";
  } else if (plat === "linkedin") {
    bodyData.caption = captionText;
  } else if (plat === "threads") {
    bodyData.caption = captionText.substring(0, 500);
    bodyData.placement = "timeline";
  } else if (plat === "pinterest") {
    bodyData.title = payload.title || "Untitled Pin";
    bodyData.caption = payload.description || captionText;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify(bodyData)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MuAPI submission failed: ${errText}`);
  }

  const data = await res.json();
  return data.request_id || data.id;
}

async function fetchConnectedAccounts() {
  if (!config.ai.apiKey) return null;
  try {
    const accRes = await fetch("https://muapi.ai/api/social/accounts", {
      headers: { "x-api-key": config.ai.apiKey }
    });
    if (accRes.ok) return await accRes.json();
  } catch (_) {}
  return null;
}

/**
 * Publishes every due scheduled post and polls MuAPI for posts still processing.
 * Pass a userId to limit the run to one user (dashboard refresh); omit it for
 * the background scheduler, which handles everyone.
 *
 * Each due post is "claimed" with an atomic status change before publishing,
 * so the background scheduler and an open dashboard can never publish the
 * same post twice.
 */
export async function processDuePosts({ userId } = {}) {
  const now = new Date();
  const userFilter = userId ? { userId } : {};
  const summary = { triggered: 0, failed: 0, completed: 0, stillProcessing: 0 };

  // 1. Publish due posts
  const duePosts = await prisma.scheduledPost.findMany({
    where: { ...userFilter, status: "scheduled", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: 25
  });

  let devAccounts = null;
  if (duePosts.some(p => !p.accountId || p.accountId === 101)) {
    devAccounts = await fetchConnectedAccounts();
  }

  for (const post of duePosts) {
    const claim = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "scheduled" },
      data: { status: "processing" }
    });
    if (claim.count !== 1) continue; // another run already took it

    try {
      await UserService.deductCredits(post.userId, config.ai.generationCost);

      let targetAccountId = post.accountId;
      if ((!targetAccountId || targetAccountId === 101) && devAccounts) {
        const normPlat = (post.platform || "").toLowerCase().replace("x_twitter", "x").replace("twitter", "x");
        const matched = devAccounts.find(a => (a.platform_name || "").toLowerCase() === normPlat);
        if (matched) targetAccountId = matched.id;
      }

      const requestId = await triggerMuApiPublish(post.platform, {
        accountId: targetAccountId,
        mediaUrl: post.mediaUrl,
        title: post.title,
        description: post.description,
        tags: post.tags,
        privacy: post.privacy,
        disableComment: post.disableComment,
        disableDuet: post.disableDuet,
        disableStitch: post.disableStitch,
        categoryId: post.categoryId,
        madeForKids: post.madeForKids
      });

      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { accountId: targetAccountId, status: "processing", requestId }
      });
      summary.triggered++;
    } catch (err) {
      console.error(`Failed to trigger due post ${post.id}:`, err);
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "failed", error: err.message || "Failed to trigger scheduled post" }
      });
      summary.failed++;
    }
  }

  // 2. Poll posts that MuAPI is still working on
  const processingPosts = await prisma.scheduledPost.findMany({
    where: { ...userFilter, status: "processing", requestId: { not: null } },
    take: 50
  });

  for (const post of processingPosts) {
    try {
      const res = await fetch(`https://api.muapi.ai/api/v1/predictions/${post.requestId}/result`, {
        headers: { "x-api-key": config.ai.apiKey }
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        console.error(`[PUBLISH_POLL] ${post.id} HTTP ${res.status}: ${body}`);
        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: { publishResult: JSON.stringify({ lastCheck: new Date().toISOString(), http: res.status, body }) },
        });
        summary.stillProcessing++;
        continue;
      }

      const result = await res.json();
      const status = result.status || result.state;

      if (status === "completed" || status === "succeeded") {
        const output = result.output || (Array.isArray(result.outputs) ? result.outputs[0] : null) || {};
        const publishedUrl = output.url || output.x_url || output.instagram_url || output.facebook_url || output.linkedin_url || output.threads_url || output.pinterest_url || (output.publish_id ? `https://${post.platform}.com/post/${output.publish_id}` : null);

        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: {
            status: "completed",
            publishedUrl: publishedUrl || "Published successfully",
            publishResult: JSON.stringify(output),
            publishedAt: new Date()
          }
        });
        summary.completed++;
      } else if (status === "failed" || status === "cancelled") {
        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: { status: "failed", error: result.error || "Publishing failed" }
        });
        await UserService.addCredits(post.userId, config.ai.generationCost);
        summary.failed++;
      } else {
        // Keep the latest raw status so a stuck post can be diagnosed.
        await prisma.scheduledPost.update({
          where: { id: post.id },
          data: { publishResult: JSON.stringify({ lastCheck: new Date().toISOString(), status, raw: result }).slice(0, 4000) },
        });
        summary.stillProcessing++;
      }
    } catch (err) {
      console.error(`Failed to poll status for post ${post.id}:`, err);
    }
  }

  return summary;
}
