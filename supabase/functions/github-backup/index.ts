// Supabase Edge Function: github-backup
// Deploy via the Supabase dashboard editor (Edge Functions > github-backup > paste & deploy).
//
// Holds a GitHub fine-grained PAT server-side so the frontend never sees it.
// Scopes needed on the PAT: Actions (read/write), Contents (read-only), on the single repo.
//
// Set secrets first (Supabase dashboard > Edge Functions > Secrets):
//   GITHUB_PAT          github_pat_... (fine-grained token, see setup guide)
//   GITHUB_REPO_OWNER   your GitHub username or org, e.g. "yourname"
//   GITHUB_REPO_NAME    your repo name, e.g. "trade-journal"
//
// This function leaves Supabase's default JWT verification ON, so only a
// signed-in user of your app (or something presenting a valid anon/service
// key) can call it — see the setup guide for what that means in practice.
//
// Request body: { action: "list" | "backup" | "restore", release_tag?: string }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GITHUB_PAT = Deno.env.get("GITHUB_PAT");
const REPO_OWNER = Deno.env.get("GITHUB_REPO_OWNER");
const REPO_NAME = Deno.env.get("GITHUB_REPO_NAME");
const BRANCH = "main";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function listReleases() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=50`,
    { headers: githubHeaders() }
  );
  if (!res.ok) throw new Error(`GitHub list releases failed: ${await res.text()}`);
  const releases = await res.json();
  const backups = releases
    .filter((r: any) => typeof r.tag_name === "string" && r.tag_name.startsWith("backup-"))
    .map((r: any) => ({
      id: r.id,
      tag_name: r.tag_name,
      name: r.name,
      // published_at (when the release was actually made visible) rather than
      // created_at (which tracks the underlying git tag's commit date) — the
      // latter can look frozen if there have been no new commits to main.
      published_at: r.published_at,
      size_bytes: (r.assets || []).reduce((sum: number, a: any) => sum + (a.size || 0), 0),
    }))
    .sort((a: any, b: any) => (a.published_at < b.published_at ? 1 : -1));
  return backups;
}

async function dispatchWorkflow(workflowFile: string, inputs: Record<string, string> = {}) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: { ...githubHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: BRANCH, inputs }),
    }
  );
  if (!res.ok) throw new Error(`GitHub workflow dispatch failed: ${await res.text()}`);
  return { dispatched: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!GITHUB_PAT || !REPO_OWNER || !REPO_NAME) {
    return new Response(
      JSON.stringify({ error: "GITHUB_PAT / GITHUB_REPO_OWNER / GITHUB_REPO_NAME not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { action, release_tag } = await req.json();

    let result;
    if (action === "list") {
      result = { backups: await listReleases() };
    } else if (action === "backup") {
      result = await dispatchWorkflow("backup.yml");
    } else if (action === "restore") {
      if (!release_tag) throw new Error("release_tag is required for restore");
      result = await dispatchWorkflow("restore.yml", { release_tag, confirm: "RESTORE" });
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
