import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./components/shell";
import { LaterPage } from "./routes/later";
import { ReportPage } from "./routes/report";
import { RunPage } from "./routes/run";
import { SettingsPage } from "./routes/settings";
import { TaskPage } from "./routes/task";
import { TonightPage } from "./routes/tonight";

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

const tonightRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tonight", component: TonightPage });
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
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } },
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
