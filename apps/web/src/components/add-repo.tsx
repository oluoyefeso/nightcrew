import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { TextInput } from "./form";
import { Button } from "./ui";

export function AddRepo({ onAdded }: { onAdded?: () => void }) {
  const [path, setPath] = useState("");
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: () => api.post("/api/repos", { path }),
    onSuccess: () => {
      setPath("");
      qc.invalidateQueries({ queryKey: ["repos"] });
      onAdded?.();
    },
  });
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim()) add.mutate();
      }}
    >
      <div className="flex gap-2">
        <TextInput
          id="repo-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/code/my-app"
          className="font-mono"
          aria-label="Repository folder"
        />
        <Button type="submit" variant="primary" className="h-9" disabled={!path.trim() || add.isPending}>
          {add.isPending ? "Adding…" : "Add repo"}
        </Button>
      </div>
      {add.error && <p className="text-[12.5px] text-bad">{add.error.message}</p>}
      <p className="text-[12px] text-faint">
        Or from a terminal inside the repo: <span className="font-mono">nightcrew repo add</span>
      </p>
    </form>
  );
}
