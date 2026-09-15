import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type VideoAnalysis = {
  summary: string;
  hook: string;
  structure: string[];
  topics: string[];
  tone: string;
  pacing: string;
  callToAction: string;
  whatWorks: string;
};

export type SourceVideo = {
  id: string;
  source_id: string;
  video_id: string;
  url: string;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  position: number;
  transcript_source: string | null;
  analysis: VideoAnalysis | null;
  status: string;
  error: string | null;
};

const SELECT =
  "id,source_id,video_id,url,title,thumbnail_url,published_at,position,transcript_source,analysis,status,error";

export const listSourceVideos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sourceId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const res = await context.supabase
      .from("source_videos")
      .select(SELECT)
      .eq("source_id", data.sourceId)
      .order("position", { ascending: true });
    if (res.error) throw new Error(res.error.message);
    return (res.data ?? []) as unknown as SourceVideo[];
  });

/** Resolves the source's link into a queue of videos ready to be analysed. */
export const discoverSourceVideos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sourceId: z.string().uuid(),
        limit: z.number().int().min(1).max(15).default(8),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { discoverVideos } = await import("./youtube.server");

    const source = await supabase
      .from("sources")
      .select("id,project_id,kind,content")
      .eq("id", data.sourceId)
      .single();
    if (source.error) throw new Error(source.error.message);
    if (source.data.kind !== "link") throw new Error("Only link sources can be analysed.");

    const videos = await discoverVideos(source.data.content.trim(), data.limit);

    const rows = videos.map((v, index) => ({
      source_id: data.sourceId,
      project_id: source.data.project_id,
      user_id: userId,
      video_id: v.videoId,
      url: v.url,
      title: v.title,
      thumbnail_url: v.thumbnailUrl,
      published_at: v.publishedAt,
      position: index,
    }));

    const res = await supabase
      .from("source_videos")
      .upsert(rows, { onConflict: "source_id,video_id", ignoreDuplicates: true })
      .select(SELECT);
    if (res.error) throw new Error(res.error.message);

    return listAfterDiscover(supabase, data.sourceId);
  });

async function listAfterDiscover(
  supabase: { from: (t: string) => any },
  sourceId: string,
): Promise<SourceVideo[]> {
  const res = await supabase
    .from("source_videos")
    .select(SELECT)
    .eq("source_id", sourceId)
    .order("position", { ascending: true });
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as SourceVideo[];
}

/** Reads one video's transcript and studies it. Called once per video. */
export const analyzeSourceVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { fetchTranscript } = await import("./youtube.server");
    const { askAIJson } = await import("./ai.server");

    const row = await supabase
      .from("source_videos")
      .select("id,video_id,title,url")
      .eq("id", data.id)
      .single();
    if (row.error) throw new Error(row.error.message);

    await supabase.from("source_videos").update({ status: "analyzing", error: null }).eq("id", data.id);

    try {
      const transcript = await fetchTranscript(row.data.video_id);
      const clipped = transcript.text.slice(0, 18000);

      const analysis = await askAIJson<VideoAnalysis>(
        "You are a YouTube performance analyst. You study one video and describe exactly how it is built.",
        `Video title: ${transcript.title}\nTranscript source: ${transcript.source}\n\nTranscript:\n${clipped}\n\nReturn JSON with keys: summary (2 sentences), hook (the opening move, one sentence), structure (array of 3-6 short beat labels in order), topics (array of 3-6 short topic tags), tone (one short phrase), pacing (one short phrase), callToAction (one short sentence, or "none"), whatWorks (one sentence on why this video holds attention).`,
      );

      const saved = await supabase
        .from("source_videos")
        .update({
          transcript: clipped,
          transcript_source: transcript.source,
          title: transcript.title || row.data.title,
          analysis,
          status: "done",
          error: null,
        })
        .eq("id", data.id)
        .select(SELECT)
        .single();
      if (saved.error) throw new Error(saved.error.message);
      return saved.data as unknown as SourceVideo;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed.";
      const failed = await supabase
        .from("source_videos")
        .update({ status: "failed", error: message.slice(0, 500) })
        .eq("id", data.id)
        .select(SELECT)
        .single();
      if (failed.error) throw new Error(failed.error.message);
      return failed.data as unknown as SourceVideo;
    }
  });

export const clearSourceVideos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sourceId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const res = await context.supabase
      .from("source_videos")
      .delete()
      .eq("source_id", data.sourceId);
    if (res.error) throw new Error(res.error.message);
    return { ok: true };
  });
