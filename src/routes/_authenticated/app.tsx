import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/lib/useWorkspace";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/app")({
  component: AppLayout,
});

const TABS = [
  { to: "/app/sources", label: "Sources" },
  { to: "/app/chat", label: "Chat" },
  { to: "/app/studio", label: "Studio" },
  { to: "/app/channels", label: "Channels" },
] as const;

function AppLayout() {
  const navigate = useNavigate();
  const workspace = useWorkspace();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-base font-semibold text-foreground">
              {workspace.data?.project.name ?? "Channel Studio"}
            </h1>
            <p className="text-xs text-muted-foreground">Clone, plan and script your channel</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/auth" });
            }}
          >
            Sign out
          </Button>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 px-4">
          {TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: cn("border-primary text-foreground font-medium") }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
