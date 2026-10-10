import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider, redirect } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { shouldRetry } from "./api";
import { Shell } from "./components/shell";
import { AgentsPage } from "./routes/agents";
import { LaterPage } from "./routes/later";
import { ReportPage } from "./routes/report";
import { RunPage } from "./routes/run";
import { SettingsPage } from "./routes/settings";
import { TaskPage } from "./routes/task";

type ReportSearch = { run?: string };
const validateSearch = (s: Record<string, unknown>): ReportSearch => (typeof s.run === "string" ? { run: s.run } : {});

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch,
  component: function Latest() {
    const { run } = indexRoute.useSearch();
    return <ReportPage runId={run} />;
  },
});

const nightRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/night/$nightId",
  validateSearch,
  component: function Night() {
    const { nightId } = nightRoute.useParams();
    const { run } = nightRoute.useSearch();
    return <ReportPage nightId={nightId} runId={run} />;
  },
});

const agentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agents", component: AgentsPage });
// The night-only "Tonight" page became Agents.
const tonightRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tonight",
  beforeLoad: () => {
    throw redirect({ to: "/agents" });
  },
});
const laterRoute = createRoute({ getParentRoute: () => rootRoute, path: "/later", component: LaterPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/task/$taskId",
  component: function Task() {
    const { taskId } = taskRoute.useParams();
    return <TaskPage taskId={taskId} />;
  },
});
const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/run/$runId",
  component: function Run() {
    const { runId } = runRoute.useParams();
    return <RunPage runId={runId} />;
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    nightRoute,
    agentsRoute,
    tonightRoute,
    laterRoute,
    settingsRoute,
    taskRoute,
    runRoute,
  ]),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: shouldRetry } },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
