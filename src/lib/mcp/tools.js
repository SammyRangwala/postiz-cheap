import { prisma } from "@/lib/prisma";
import config from "@/lib/config";
import { processDuePosts } from "@/lib/services/publisher";

// Tools exposed to Claude (or any MCP client) through /api/mcp/<token>.
// Every tool runs as the user who owns the connector token.

const DEFAULT_TZ = process.env.SCHEDULER_TIMEZONE || "America/Chicago";

const PLATFORM_LABELS = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  x_twitter: "X (Twitter)",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  threads: "Threads",
  pinterest: "Pinterest",
};

function platformKey(acc) {
  const p = (acc?.platform_name || "").toLowerCase();
  if (p === "x" || p === "twitter") return "x_twitter";
  return PLATFORM_LABELS[p] ? p : p || "unknown";
}

async function fetchChannels() {
  if (!config.ai.apiKey) throw new Error("MUAPIAPP_API_KEY is not configured on the server.");
  const res = await fetch("https://muapi.ai/api/social/accounts", {
    headers: { "x-api-key": config.ai.apiKey },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Could not load connected channels (MuAPI ${res.status}).`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((a) => ({
    channel_id: a.id,
    platform: platformKey(a),
    platform_label: PLATFORM_LABELS[platformKey(a)] || a.platform_name,
    account_name: a.account_name || a.username || `${a.platform_name} account`,
  }));
}

// Parse a date/time. Strings with Z or an offset are used as-is; strings
// without one are read as wall-clock time in DEFAULT_TZ.
function parseWhen(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, da, h, mi, se] = m.map((v) => (v === undefined ? "0" : v));
  const asUtc = Date.UTC(+y, +mo - 1, +da, +h, +mi, +se);
  // Find the zone offset at that moment and correct for it.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const zoned = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(asUtc - (zoned - asUtc));
}

function formatLocal(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ, dateStyle: "medium", timeStyle: "short",
  }).format(date) + ` (${DEFAULT_TZ})`;
}

function summarizePost(p) {
  return {
    post_id: p.id,
    platform: p.platform,
    channel_id: p.accountId,
    account_name: p.accountName,
    status: p.status,
    scheduled_for: p.scheduledAt.toISOString(),
    scheduled_for_local: formatLocal(p.scheduledAt),
    title: p.title || "",
    caption: p.description || "",
    tags: p.tags || "",
    media_url: p.mediaUrl,
    published_url: p.publishedUrl || null,
    error: p.error || null,
    last_status_check: p.status === "processing" && p.publishResult ? p.publishResult.slice(0, 1500) : undefined,
  };
}

const isHttpsUrl = (u) => typeof u === "string" && /^https:\/\//i.test(u.trim());

async function uploadFromUrl(url) {
  if (!isHttpsUrl(url)) throw new Error("media_url must be an https:// link.");
  const src = await fetch(url, { redirect: "follow" });
  if (!src.ok) throw new Error(`Could not download the media (HTTP ${src.status}).`);
  const type = (src.headers.get("content-type") || "").toLowerCase();
  if (!type.startsWith("image/") && !type.startsWith("video/")) {
    throw new Error(
      `That link returned "${type || "unknown"}", not an image or video. Use a direct file link (for Google Drive, the file must be shared publicly and the link must be a direct download).`
    );
  }
  const buf = await src.arrayBuffer();
  if (buf.byteLength > 250 * 1024 * 1024) throw new Error("File is larger than 250 MB.");
  const ext = type.split("/")[1]?.split(";")[0] || "bin";
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), `upload.${ext}`);
  const up = await fetch(config.ai.uploadEndpoint || "https://api.muapi.ai/api/v1/upload_file", {
    method: "POST",
    headers: { "x-api-key": config.ai.apiKey },
    body: fd,
  });
  if (!up.ok) throw new Error(`Upload to MuAPI failed: ${await up.text()}`);
  const data = await up.json();
  const hosted = data.url || data.file_url;
  if (!isHttpsUrl(hosted)) throw new Error("Upload did not return a usable URL.");
  return hosted;
}

export const TOOLS = [
  {
    name: "list_channels",
    description:
      "List the social media channels (pages/accounts) connected to the scheduler. Call this first to get channel_id values for schedule_post. Each brand's page is a separate channel, so pick channels by account_name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "schedule_post",
    description:
      `Schedule one post to one or more channels. Every post needs an image or video (media_url, a direct https link to the file). Times without a timezone are read as ${DEFAULT_TZ}. Set publish_now to true to post right away instead of scheduling. Creates one scheduled item per channel.`,
    inputSchema: {
      type: "object",
      properties: {
        channel_ids: {
          type: "array",
          items: { type: "integer" },
          minItems: 1,
          description: "channel_id values from list_channels. Only these channels get the post.",
        },
        caption: { type: "string", description: "Post text / description." },
        title: { type: "string", description: "Title or headline (used by YouTube, Pinterest, TikTok)." },
        tags: { type: "string", description: "Comma-separated hashtags without #, e.g. turf,dallas,backyard." },
        media_url: { type: "string", description: "Direct https link to the image or video file." },
        scheduled_at: {
          type: "string",
          description: `When to publish, e.g. "2026-11-24T09:00" (${DEFAULT_TZ}) or full ISO 8601 with offset. Required unless publish_now is true.`,
        },
        publish_now: { type: "boolean", description: "Publish immediately instead of scheduling." },
        per_channel_captions: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional caption overrides keyed by channel_id (as a string), e.g. {\"123\": \"Shorter text for X\"}.",
        },
      },
      required: ["channel_ids", "caption", "media_url"],
      additionalProperties: false,
    },
  },
  {
    name: "list_posts",
    description:
      "List posts on the calendar. Filter by status (scheduled, processing, completed, failed) and/or a date range. Defaults to upcoming scheduled posts.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["scheduled", "processing", "completed", "failed", "all"] },
        from: { type: "string", description: `Start of range (date or date-time, ${DEFAULT_TZ} if no offset).` },
        to: { type: "string", description: "End of range." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_post",
    description: "Change a scheduled post's time, caption, title, tags or media. Only posts still in 'scheduled' status can be changed.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string" },
        scheduled_at: { type: "string" },
        caption: { type: "string" },
        title: { type: "string" },
        tags: { type: "string" },
        media_url: { type: "string" },
      },
      required: ["post_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_post",
    description: "Cancel (delete) a scheduled post that has not been published yet.",
    inputSchema: {
      type: "object",
      properties: { post_id: { type: "string" } },
      required: ["post_id"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "publish_due_now",
    description:
      "Immediately publish any posts whose scheduled time has already passed, and refresh the status of posts that are publishing. Use when a post is late or the user asks to push due posts out now. Never publishes posts scheduled for the future.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "upload_media_from_url",
    description:
      "Copy an image or video from a public link into the scheduler's media hosting and return a stable media_url. Use when the original link might expire or isn't a direct file link.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export async function callTool(name, args, userId) {
  args = args || {};
  switch (name) {
    case "list_channels": {
      const channels = await fetchChannels();
      return { channels, count: channels.length };
    }

    case "schedule_post": {
      const ids = (args.channel_ids || []).map((n) => parseInt(n)).filter((n) => !isNaN(n));
      if (ids.length === 0) throw new Error("channel_ids is required. Call list_channels first.");
      if (!isHttpsUrl(args.media_url)) throw new Error("Every post needs an image or video: media_url must be a direct https link.");

      let when;
      if (args.publish_now) {
        when = new Date();
      } else {
        when = parseWhen(args.scheduled_at);
        if (!when) throw new Error(`scheduled_at is missing or not a valid date/time. Example: "2026-11-24T09:00" (${DEFAULT_TZ}).`);
        if (when.getTime() < Date.now() - 60_000) throw new Error(`That time (${formatLocal(when)}) is in the past.`);
      }

      const channels = await fetchChannels();
      const byId = new Map(channels.map((c) => [c.channel_id, c]));
      const unknown = ids.filter((id) => !byId.has(id));
      if (unknown.length) throw new Error(`Unknown channel_id(s): ${unknown.join(", ")}. Call list_channels for valid ids.`);

      const overrides = args.per_channel_captions || {};
      const created = [];
      for (const id of ids) {
        const ch = byId.get(id);
        const post = await prisma.scheduledPost.create({
          data: {
            userId,
            accountId: id,
            platform: ch.platform,
            accountName: ch.account_name,
            mediaUrl: args.media_url.trim(),
            title: args.title || "",
            description: overrides[String(id)] ?? args.caption ?? "",
            tags: args.tags || "",
            scheduledAt: when,
            status: "scheduled",
          },
        });
        created.push(post);
      }

      let publishResult = null;
      if (args.publish_now) publishResult = await processDuePosts({ userId });

      return {
        message: args.publish_now
          ? `Publishing now to ${created.length} channel(s).`
          : `Scheduled for ${formatLocal(when)} on ${created.length} channel(s). The background scheduler checks every 10 minutes, so it goes out within about 10-20 minutes of that time.`,
        posts: created.map(summarizePost),
        publish_result: publishResult,
      };
    }

    case "list_posts": {
      const where = { userId };
      const status = args.status || "scheduled";
      if (status !== "all") where.status = status;
      const from = args.from ? parseWhen(args.from.length === 10 ? `${args.from}T00:00` : args.from) : null;
      const to = args.to ? parseWhen(args.to.length === 10 ? `${args.to}T23:59` : args.to) : null;
      if (from || to) where.scheduledAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
      const posts = await prisma.scheduledPost.findMany({
        where,
        orderBy: { scheduledAt: status === "scheduled" ? "asc" : "desc" },
        take: Math.min(args.limit || 50, 100),
      });
      return { posts: posts.map(summarizePost), count: posts.length, timezone: DEFAULT_TZ };
    }

    case "update_post": {
      const post = await prisma.scheduledPost.findFirst({ where: { id: args.post_id, userId } });
      if (!post) throw new Error("Post not found.");
      if (post.status !== "scheduled") throw new Error(`This post is already ${post.status} and can't be changed.`);
      const data = {};
      if (args.scheduled_at !== undefined) {
        const when = parseWhen(args.scheduled_at);
        if (!when) throw new Error("scheduled_at is not a valid date/time.");
        if (when.getTime() < Date.now() - 60_000) throw new Error("That time is in the past.");
        data.scheduledAt = when;
      }
      if (args.caption !== undefined) data.description = args.caption;
      if (args.title !== undefined) data.title = args.title;
      if (args.tags !== undefined) data.tags = args.tags;
      if (args.media_url !== undefined) {
        if (!isHttpsUrl(args.media_url)) throw new Error("media_url must be a direct https link.");
        data.mediaUrl = args.media_url.trim();
      }
      if (Object.keys(data).length === 0) throw new Error("Nothing to change.");
      // Only update if it is still scheduled (guards against it publishing meanwhile).
      const res = await prisma.scheduledPost.updateMany({ where: { id: post.id, status: "scheduled" }, data });
      if (res.count !== 1) throw new Error("The post started publishing before it could be changed.");
      const updated = await prisma.scheduledPost.findUnique({ where: { id: post.id } });
      return { message: "Post updated.", post: summarizePost(updated) };
    }

    case "cancel_post": {
      const res = await prisma.scheduledPost.deleteMany({ where: { id: args.post_id, userId, status: "scheduled" } });
      if (res.count !== 1) {
        const exists = await prisma.scheduledPost.findFirst({ where: { id: args.post_id, userId } });
        throw new Error(exists ? `This post is already ${exists.status} and can't be cancelled.` : "Post not found.");
      }
      return { message: "Post cancelled." };
    }

    case "publish_due_now": {
      const summary = await processDuePosts({ userId });
      const recent = await prisma.scheduledPost.findMany({
        where: { userId, updatedAt: { gte: new Date(Date.now() - 5 * 60_000) } },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });
      return { summary, recently_updated: recent.map(summarizePost) };
    }

    case "upload_media_from_url": {
      const url = await uploadFromUrl(args.url);
      return { media_url: url };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
