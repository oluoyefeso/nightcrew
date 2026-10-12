import type { OperationAttention, OperationJob } from "@nightcrew/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, missionsQuery, reposQuery } from "../api";
import { Select } from "./form";
import { Button } from "./ui";

export const operationAttentionQuery = {
  queryKey: ["operation-attention", "summary"],
  queryFn: () => api.get<OperationAttention>("/api/operations/attention"),
  refetchInterval: 5000,
};

export function AttentionCard({ job }: { job: OperationJob }) {
  const repos = useQuery(reposQuery);
  const missions = useQuery(missionsQuery);
  const name =
    job.kind === "mission"
      ? (missions.data?.find((mission) => mission.id === job.subjectId)?.title ?? "Removed mission")
      : (repos.data?.find((repo) => repo.id === job.subjectId)?.name ?? "Removed repository");
  return (
    <Link
      to="/operations/$operationId"
      params={{ operationId: job.id }}
      className="grid min-w-0 gap-2 rounded-2xl bg-surface p-5 ring-1 ring-line hover:ring-dawn/50"
    >
      <span className="text-[12px] text-dawn">
        {job.status === "interrupted" ? "Interrupted operation" : "Failed operation"} ·{" "}
        {job.kind === "mission"
          ? "Acceptance"
          : job.kind === "repository"
            ? "Setup verification"
            : `Delivery ${job.stage}`}
      </span>
      <span className="font-medium break-words">{name}</span>
      <span className="text-[13px] text-muted break-words">
        {job.detail || "Inspect the saved outcome before deciding what to do next."}
      </span>
      <span className="text-[12px] text-muted">{new Date(job.updatedAt).toLocaleString()}</span>
      <span className="text-[12px] text-dawn">Inspect outcome and mark reviewed →</span>
    </Link>
  );
}

export function OperationAttentionPanel() {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [showAll, setShowAll] = useState(false);
  const attention = useInfiniteQuery({
    queryKey: ["operation-attention", "list", kind, status],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams();
      if (kind) query.set("kind", kind);
      if (status) query.set("status", status);
      if (pageParam) query.set("before", pageParam);
      return api.get<OperationAttention>(`/api/operations/attention?${query}`);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5000,
  });
  const jobs =
    attention.data?.pages
      .flatMap((page) => page.jobs)
      .filter((job, index, all) => all.findIndex((other) => other.id === job.id) === index) ?? [];
  const total = attention.data?.pages[0]?.total;
  return (
    <section id="attention" aria-label="Operations needing attention" className="grid scroll-mt-20 gap-3">
      <h2 className="text-[18px] font-medium">Needs attention{total !== undefined ? ` · ${total}` : ""}</h2>
      <p className="text-[13px] text-muted">
        Failed and interrupted operations stay here until you inspect and mark them reviewed. Reviewing clears this
        list; it does not rerun commands or allow delivery retries.
      </p>
      <div className="flex flex-wrap gap-3">
        <Select
          aria-label="Attention kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setShowAll(false);
          }}
        >
          <option value="">All operation kinds</option>
          <option value="repository">Repository setup</option>
          <option value="mission">Mission acceptance</option>
          <option value="delivery">Delivery</option>
        </Select>
        <Select
          aria-label="Attention status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setShowAll(false);
          }}
        >
          <option value="">Failed and interrupted</option>
          <option value="failed">Failed</option>
          <option value="interrupted">Interrupted</option>
        </Select>
      </div>
      {attention.isPending && <p className="text-[13px] text-muted">Loading attention list…</p>}
      {attention.error && (
        <p role="alert" className="text-bad">
          {attention.error.message}
        </p>
      )}
      {jobs.slice(0, showAll ? jobs.length : 3).map((job) => (
        <AttentionCard key={job.id} job={job} />
      ))}
      {jobs.length > 3 && (
        <div>
          <Button variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer attention items" : `Show all ${jobs.length} loaded items`}
          </Button>
        </div>
      )}
      {total === 0 && <p className="text-[13px] text-muted">No unreviewed operations match these filters.</p>}
      {attention.hasNextPage && (
        <div>
          <Button
            disabled={attention.isFetchingNextPage}
            onClick={() => {
              setShowAll(true);
              void attention.fetchNextPage();
            }}
          >
            Load older items · {jobs.length} of {total}
          </Button>
        </div>
      )}
    </section>
  );
}
