import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getWorkspace } from "./studio.functions";

export const workspaceKey = ["workspace"] as const;

export function useWorkspace() {
  const fetchWorkspace = useServerFn(getWorkspace);
  return useQuery({
    queryKey: workspaceKey,
    queryFn: () => fetchWorkspace({ data: undefined }),
  });
}

export function useRefreshWorkspace() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: workspaceKey });
}
