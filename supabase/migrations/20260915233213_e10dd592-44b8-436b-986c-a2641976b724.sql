CREATE TABLE public.source_videos (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  video_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  thumbnail_url TEXT,
  published_at TIMESTAMPTZ,
  position INTEGER NOT NULL DEFAULT 0,
  transcript TEXT,
  transcript_source TEXT,
  analysis JSONB,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, video_id)
);

CREATE INDEX source_videos_source_idx ON public.source_videos (source_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.source_videos TO authenticated;
GRANT ALL ON public.source_videos TO service_role;

ALTER TABLE public.source_videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own source videos"
ON public.source_videos FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER source_videos_set_updated_at
BEFORE UPDATE ON public.source_videos
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();