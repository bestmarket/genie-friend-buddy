import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, Download, Film, Loader2, Pencil, Play, Trash2, Wand2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { VideoEditor } from "@/components/VideoEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { publishVideo } from "@/lib/channels.functions";
import { renderVideo } from "@/lib/renderVideo";
import type { Scene } from "@/lib/studio.functions";
import {
  VIDEO_STYLES,
  buildScene,
  deleteVideo,
  queueFromPrompts,
  queueVideos,
  setVideoStatus,
  signAssets,
} from "@/lib/studio.functions";
import { useRefreshWorkspace, useWorkspace } from "@/lib/useWorkspace";
import { cn } from "@/lib/utils";
import { normalizeIngredients } from "@/lib/videoIngredients";

export const Route = createFileRoute("/_authenticated/app/studio")({
  head: () => ({
    meta: [
      { title: "Studio — Channel Studio" },
      {
        name: "description",
        content: "Pick a look, produce videos from scripts or prompts, then download or schedule.",
      },
      { property: "og:title", content: "Studio — Channel Studio" },
      {
        property: "og:description",
        content: "Pick a look, produce videos from scripts or prompts, then download or schedule.",
      },
    ],
  }),
  component: StudioPage,
});

const LANGUAGES = ["English", "Spanish", "French", "German", "Portuguese", "Hindi"];

type VideoRow = {
  id: string;
  title: string;
  language: string;
  style: string | null;
  status: string;
  progress: number;
  error: string | null;
  scenes: unknown;
  settings?: unknown;
  video_path: string | null;
  scheduled_at: string | null;
};

function StudioPage() {
  const workspace = useWorkspace();
  const refresh = useRefreshWorkspace();
  const projectId = workspace.data?.project.id;

  const [style, setStyle] = useState("cinematic");
  const [scriptIds, setScriptIds] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>(["English"]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [prompts, setPrompts] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [localProgress, setLocalProgress] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rerenderId, setRerenderId] = useState<string | null>(null);

  const scripts = workspace.data?.scripts ?? [];
  const videos = (workspace.data?.videos ?? []) as unknown as VideoRow[];

  const schedule = scheduledAt ? new Date(scheduledAt).toISOString() : null;

  const queue = useMutation({
    mutationFn: useServerFn(queueVideos),
    onSuccess: async () => {
      setScriptIds([]);
      await refresh();
      toast.success(schedule ? "Scheduled" : "Added to the production queue");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const queuePrompts = useMutation({
    mutationFn: useServerFn(queueFromPrompts),
    onSuccess: async () => {
      setPrompts("");
      await refresh();
      toast.success(schedule ? "Scheduled" : "Added to the production queue");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: useServerFn(deleteVideo),
    onSuccess: async () => refresh(),
    onError: (e: Error) => toast.error(e.message),
  });

  const runBuildScene = useServerFn(buildScene);
  const runSetStatus = useServerFn(setVideoStatus);
  const runSignAssets = useServerFn(signAssets);
  const runPublish = useServerFn(publishVideo);

  const produce = useCallback(
    async (video: VideoRow) => {
      const scenes = (video.scenes as Scene[]) ?? [];
      if (scenes.length === 0) {
        toast.error("This video has no scenes.");
        return;
      }
      setBusyId(video.id);
      setLocalProgress((p) => ({ ...p, [video.id]: 0 }));
      try {
        // 1. Generate the still and the narration for every scene.
        for (let i = 0; i < scenes.length; i += 1) {
          if (scenes[i]?.imagePath && scenes[i]?.audioPath) continue;
          await runBuildScene({ data: { videoId: video.id, index: i, voice: "warm" } });
          setLocalProgress((p) => ({ ...p, [video.id]: ((i + 1) / scenes.length) * 0.6 }));
        }

        // 2. Read the freshly built scenes back and sign the media.
        const fresh = await supabase
          .from("videos")
          .select("scenes,settings")
          .eq("id", video.id)
          .single();
        if (fresh.error) throw new Error(fresh.error.message);
        const built = ((fresh.data.scenes as unknown as Scene[]) ?? []).filter((s) => s.imagePath);
        const paths = built.flatMap((s) =>
          [s.imagePath, s.audioPath].filter((p): p is string => Boolean(p)),
        );
        const signed = await runSignAssets({ data: { paths } });
        const urlFor = (path: string | null | undefined) =>
          path ? (signed.find((s) => s.path === path)?.url ?? null) : null;

        // 3. Assemble the film in the browser with its production ingredients.
        await runSetStatus({ data: { videoId: video.id, status: "rendering", progress: 60 } });
        const ingredients = normalizeIngredients(
          (fresh.data as { settings?: unknown }).settings ?? video.settings,
        );
        const blob = await renderVideo(
          built.map((s) => ({
            imageUrl: urlFor(s.imagePath)!,
            audioUrl: urlFor(s.audioPath),
            caption: s.narration,
          })),
          ingredients,
          (f) => setLocalProgress((p) => ({ ...p, [video.id]: 0.6 + f * 0.35 })),
        );


        // 4. Store it and mark the video ready.
        const { data: userData } = await supabase.auth.getUser();
        const path = `${userData.user!.id}/${video.id}/video.webm`;
        const upload = await supabase.storage
          .from("media")
          .upload(path, blob, { contentType: blob.type || "video/webm", upsert: true });
        if (upload.error) throw new Error(upload.error.message);

        await runSetStatus({
          data: { videoId: video.id, status: "ready", progress: 100, videoPath: path, error: null },
        });
        setLocalProgress((p) => ({ ...p, [video.id]: 1 }));

        // 5. Send it to every account set to post automatically.
        try {
          const posted = await runPublish({ data: { videoId: video.id } });
          const ok = posted.results.filter((r) => r.status === "posted").length;
          if (ok > 0) toast.success(`Video is ready and posted to ${ok} account(s)`);
          else toast.success("Video is ready");
        } catch {
          toast.success("Video is ready, but auto-posting failed");
        }

        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Production failed";
        await runSetStatus({ data: { videoId: video.id, status: "failed", error: message } }).catch(
          () => undefined,
        );
        await refresh();
        toast.error(message);
      } finally {
        setBusyId(null);
      }
    },
    [refresh, runBuildScene, runPublish, runSetStatus, runSignAssets],
  );

  const download = useCallback(
    async (video: VideoRow) => {
      if (!video.video_path) return;
      try {
        const signed = await runSignAssets({ data: { paths: [video.video_path] } });
        const url = signed[0]?.url;
        if (!url) throw new Error("That file is no longer available.");
        const link = document.createElement("a");
        link.href = url;
        link.download = `${video.title.replace(/[^\w\- ]+/g, "").trim() || "video"}.webm`;
        link.click();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Download failed");
      }
    },
    [runSignAssets],
  );

  // Keep the list fresh so scheduled videos appear the moment they are prepared.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Finish any scheduled video the background scheduler has already prepared.
  const autoRan = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (busyId) return;
    const next = videos.find((v) => v.status === "assembling" && !autoRan.current.has(v.id));
    if (!next) return;
    autoRan.current.add(next.id);
    void produce(next);
  }, [busyId, produce, videos]);

  // Re-render a video straight after it was edited.
  useEffect(() => {
    if (!rerenderId || busyId) return;
    const target = videos.find((v) => v.id === rerenderId);
    if (!target) return;
    setRerenderId(null);
    void produce(target);
  }, [busyId, produce, rerenderId, videos]);

  const editing = videos.find((v) => v.id === editingId) ?? null;


  if (workspace.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your studio…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Style picker */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Video style</h2>
          <p className="text-xs text-muted-foreground">
            Every scene image is generated in the look you pick here.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {VIDEO_STYLES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={style === option.id}
              onClick={() => setStyle(option.id)}
              className={cn(
                "overflow-hidden rounded-lg border text-left transition-colors",
                style === option.id
                  ? "border-primary ring-2 ring-ring"
                  : "border-border hover:border-primary/50",
              )}
            >
              <span className="block h-16 w-full" style={{ background: option.swatch }} />
              <span className="block p-3">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{option.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Languages + schedule */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="space-y-2">
          <Label>Languages</Label>
          <div className="flex flex-wrap gap-2">
            {LANGUAGES.map((language) => {
              const on = languages.includes(language);
              return (
                <button
                  key={language}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setLanguages((current) =>
                      current.includes(language)
                        ? current.filter((l) => l !== language)
                        : [...current, language],
                    )
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {language}
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="schedule">Schedule (optional)</Label>
          <Input
            id="schedule"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to produce right away. Scheduled videos wait in the list until their time.
          </p>
        </div>
      </section>

      {/* From scripts */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Produce from scripts</h2>
        {scripts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No scripts yet. Write one from an idea first.
          </p>
        ) : (
          <ul className="space-y-2">
            {scripts.map((script) => {
              const on = scriptIds.includes(script.id);
              return (
                <li key={script.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setScriptIds((current) =>
                        current.includes(script.id)
                          ? current.filter((id) => id !== script.id)
                          : [...current, script.id],
                      )
                    }
                    className={cn(
                      "w-full rounded-lg border p-3 text-left transition-colors",
                      on ? "border-primary bg-accent" : "border-border hover:border-primary/50",
                    )}
                  >
                    <span className="block text-sm font-medium text-foreground">
                      {script.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {((script.scenes as unknown as Scene[]) ?? []).length} scenes
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Button
          className="w-full"
          disabled={
            !projectId || scriptIds.length === 0 || languages.length === 0 || queue.isPending
          }
          onClick={() =>
            projectId &&
            queue.mutate({
              data: { projectId, scriptIds, languages, style, scheduledAt: schedule },
            })
          }
        >
          {queue.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Adding…
            </>
          ) : schedule ? (
            <>
              <CalendarClock className="mr-2 h-4 w-4" /> Schedule {scriptIds.length || ""} video(s)
            </>
          ) : (
            <>
              <Film className="mr-2 h-4 w-4" /> Queue {scriptIds.length || ""} video(s)
            </>
          )}
        </Button>
      </section>

      {/* From prompts */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Produce from prompts</h2>
          <p className="text-xs text-muted-foreground">
            Paste the image prompts from chat — one per line — and they become the scenes.
          </p>
        </div>
        <Textarea
          rows={5}
          value={prompts}
          placeholder={"A lone hiker at dawn on a ridge\nClose-up of frost on a compass\n…"}
          onChange={(e) => setPrompts(e.target.value)}
        />
        <Button
          variant="outline"
          className="w-full"
          disabled={!projectId || prompts.trim().length < 3 || queuePrompts.isPending}
          onClick={() =>
            projectId &&
            queuePrompts.mutate({
              data: {
                projectId,
                title: "Prompt video",
                prompts,
                language: languages[0] ?? "English",
                style,
                scheduledAt: schedule,
              },
            })
          }
        >
          {queuePrompts.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Building scenes…
            </>
          ) : (
            <>
              <Wand2 className="mr-2 h-4 w-4" /> Turn prompts into a video
            </>
          )}
        </Button>
      </section>

      {/* Queue */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-foreground">Productions</h2>
        {videos.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Nothing in production yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {videos.map((video) => {
              const scenes = (video.scenes as Scene[]) ?? [];
              const busy = busyId === video.id;
              const pct = Math.round((localProgress[video.id] ?? video.progress / 100) * 100);
              const styleLabel =
                VIDEO_STYLES.find((s) => s.id === video.style)?.label ?? video.style ?? "Cinematic";
              return (
                <li key={video.id} className="space-y-3 rounded-lg border border-border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{video.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {video.language} · {styleLabel} · {scenes.length} scenes · {video.status}
                        {video.scheduled_at
                          ? ` · ${new Date(video.scheduled_at).toLocaleString()}`
                          : ""}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete video"
                      onClick={() => remove.mutate({ data: { id: video.id } })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  {busy ||
                  ["building", "rendering", "preparing", "assembling"].includes(video.status) ? (
                    <Progress value={pct} />
                  ) : null}
                  {video.error ? <p className="text-xs text-destructive">{video.error}</p> : null}

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => produce(video)}>
                      {busy ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Producing… {pct}%
                        </>
                      ) : (
                        <>
                          <Play className="mr-2 h-4 w-4" />
                          {video.status === "ready" ? "Produce again" : "Produce video"}
                        </>
                      )}
                    </Button>
                    {scenes.length > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setEditingId(video.id)}
                      >
                        <Pencil className="mr-2 h-4 w-4" /> Edit
                      </Button>
                    ) : null}
                    {video.video_path ? (
                      <Button size="sm" variant="outline" onClick={() => download(video)}>
                        <Download className="mr-2 h-4 w-4" /> Download
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <VideoEditor
        video={editing}
        onClose={() => setEditingId(null)}
        onChanged={refresh}
        onRerender={(id) => setRerenderId(id)}
      />
    </div>
  );
}
