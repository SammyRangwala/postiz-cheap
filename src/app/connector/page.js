"use client";

import { useEffect, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { FiCopy, FiCheck, FiRefreshCw, FiTrash2, FiLink, FiAlertTriangle } from "react-icons/fi";

export default function ConnectorPage() {
  const { status } = useSession();
  const [active, setActive] = useState(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/connector")
      .then((r) => r.json())
      .then((d) => setActive(!!d.active))
      .catch(() => setActive(false));
  }, [status]);

  const generate = async () => {
    if (active && !confirm("This replaces your current link. Claude will stop working until you update the connector with the new link. Continue?")) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/connector", { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d.url) throw new Error(d.error || "Could not create a link.");
      setUrl(d.url);
      setActive(true);
      setCopied(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!confirm("Turn off the Claude connector? Claude will no longer be able to schedule posts until you create a new link.")) return;
    setBusy(true);
    try {
      await fetch("/api/connector", { method: "DELETE" });
      setActive(false);
      setUrl("");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Couldn't copy automatically. Select the link and copy it by hand.");
    }
  };

  if (status === "loading") return null;
  if (status !== "authenticated") {
    return (
      <div className="p-8 text-center">
        <button onClick={() => signIn("google")} className="px-4 py-2 rounded-lg bg-[#612bd3] text-white text-sm font-semibold">
          Sign in to manage the Claude connector
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-white flex items-center gap-2">
            <FiLink /> Schedule posts by talking to Claude
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Connect this scheduler to Claude once, then ask Claude in any chat, on web, desktop or phone, to schedule, list,
            move or cancel posts.
          </p>
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-[#1a1919] border border-zinc-200 dark:border-[#2a2929] space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Your private connector link</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${active ? "bg-emerald-500/15 text-emerald-500" : "bg-zinc-500/15 text-zinc-400"}`}>
              {active === null ? "…" : active ? "Active" : "Not set up"}
            </span>
          </div>

          {url ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input readOnly value={url} onFocus={(e) => e.target.select()}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#111] border border-zinc-200 dark:border-[#333] text-xs font-mono text-zinc-800 dark:text-zinc-200" />
                <button onClick={copy} className="px-3 py-2 rounded-lg bg-[#612bd3] text-white text-xs font-semibold flex items-center gap-1.5">
                  {copied ? <><FiCheck /> Copied</> : <><FiCopy /> Copy</>}
                </button>
              </div>
              <p className="text-xs text-amber-500 flex items-start gap-1.5">
                <FiAlertTriangle className="mt-0.5 shrink-0" />
                Copy it now. For security it is shown only once. Anyone with this link can schedule posts, so don&apos;t share it.
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {active
                ? "A link is active, but it's hidden for security. If you lost it, create a new one (the old one stops working)."
                : "Create a link, then add it to Claude as a custom connector."}
            </p>
          )}

          <div className="flex gap-2">
            <button onClick={generate} disabled={busy}
              className="px-3.5 py-2 rounded-lg bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
              <FiRefreshCw /> {active ? "Create new link" : "Create link"}
            </button>
            {active && (
              <button onClick={revoke} disabled={busy}
                className="px-3.5 py-2 rounded-lg border border-red-500/40 text-red-500 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
                <FiTrash2 /> Turn off
              </button>
            )}
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-[#1a1919] border border-zinc-200 dark:border-[#2a2929] space-y-3">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Add it to Claude</h2>
          <ol className="list-decimal list-inside text-sm text-zinc-600 dark:text-zinc-300 space-y-1.5">
            <li>Open Claude, go to <b>Settings → Connectors</b>.</li>
            <li>Click <b>Add custom connector</b>.</li>
            <li>Name it <b>Social Scheduler</b> and paste your link as the URL. Leave the advanced/OAuth fields empty.</li>
            <li>Click <b>Add</b>. In a chat, make sure the connector is switched on in the tools menu.</li>
          </ol>
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-[#1a1919] border border-zinc-200 dark:border-[#2a2929] space-y-2">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Things you can ask</h2>
          <ul className="text-sm text-zinc-600 dark:text-zinc-300 space-y-1">
            <li>&ldquo;What channels are connected?&rdquo;</li>
            <li>&ldquo;Schedule this video to Green Guard&apos;s Instagram and TikTok Tuesday at 9am: &lt;link&gt;&rdquo;</li>
            <li>&ldquo;What&apos;s scheduled this week?&rdquo;</li>
            <li>&ldquo;Move Thursday&apos;s Facebook post to Friday 10am.&rdquo;</li>
            <li>&ldquo;Cancel the Threads post.&rdquo;</li>
          </ul>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 pt-1">
            Every post needs an image or video as a direct link (for example a Canva export or a public file link).
          </p>
        </div>
      </div>
    </div>
  );
}
