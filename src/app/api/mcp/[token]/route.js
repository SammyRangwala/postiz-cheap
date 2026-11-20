import { NextResponse } from "next/server";
import { TOOLS, callTool } from "@/lib/mcp/tools";
import { userIdForToken } from "@/lib/mcp/token";

// Model Context Protocol endpoint (Streamable HTTP, stateless JSON responses).
// Add https://<app>/api/mcp/<token> as a custom connector in Claude.
// The token in the URL is the secret: generate or revoke it on /connector.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "sammy-social-scheduler", title: "Social Media Scheduler", version: "1.0.0" };

const INSTRUCTIONS = `Schedules social media posts for the owner's connected pages.
Workflow: call list_channels to see the pages, pick only the channels the user asked for (by account_name; each brand's page is a separate channel and brands must never be mixed), then call schedule_post.
Every post needs an image or video as a direct https link. Confirm the channels, time and caption with the user before scheduling if anything is ambiguous.`;

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleMessage(msg, userId) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") {
    return isNotification ? null : rpcError(id, -32600, "Invalid Request");
  }

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(name, params?.arguments, userId);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return rpcResult(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(req, { params }) {
  const { token } = await params;
  const userId = await userIdForToken(token);
  if (!userId) {
    return NextResponse.json(rpcError(null, -32001, "Invalid or revoked connector link. Generate a new one on the Connector page."), { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const m of messages) {
    const r = await handleMessage(m, userId);
    if (r) responses.push(r);
  }

  if (responses.length === 0) return new NextResponse(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? responses : responses[0]);
}

export async function GET() {
  // No server-initiated stream; clients fall back to POST-only.
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
