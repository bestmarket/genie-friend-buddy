ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS brainstorm text,
  ADD COLUMN IF NOT EXISTS brainstorm_at timestamp with time zone;