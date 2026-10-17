import type { Repo } from "@nightcrew/core";
import { useState } from "react";

const key = "nc-last-goal-project";

/** Remember the last explicit project choice on this dashboard's origin. */
export function useProjectChoice(repos: Repo[] | undefined) {
  const [chosen, setChosen] = useState(() => {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  const project = repos?.some((repo) => repo.id === chosen) ? chosen : repos?.length === 1 ? repos[0]!.id : "";
  const choose = (id: string) => {
    setChosen(id);
    try {
      if (id) localStorage.setItem(key, id);
      else localStorage.removeItem(key);
    } catch {}
  };
  return [project, choose] as const;
}
