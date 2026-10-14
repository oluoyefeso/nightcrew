import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider, redirect } from "@tanstack/react-router";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { checkKey, lockStore, shouldRetry, takeLaunchKey } from "./api";
import { LockedPage } from "./components/locked";
import { Shell } from "./components/shell";
import { resumeReturnPath } from "./pending";
import { AgentsPage } from "./routes/agents";
import { LaterPage } from "./routes/later";
import { MissionPage, MissionsPage } from "./routes/missions";
import { OperationPage, ResultPage } from "./routes/operation-result";
import { OperationsPage } from "./routes/operations";
import { ReportPage } from "./routes/report";
import { RunPage } from "./routes/run";
import { SettingsPage } from "./routes/settings";
import { StationPage } from "./routes/station";
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
    return <StationPage runId={run} />;
  },
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/history",
  validateSearch,
  component: function History() {
    const { run } = historyRoute.useSearch();
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

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  validateSearch: (s: Record<string, unknown>): { mission?: string } =>
    typeof s.mission === "string" ? { mission: s.mission } : {},
  component: function Agents() {
    return <AgentsPage initialMissionId={agentsRoute.useSearch().mission} />;
  },
});
const missionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/missions", component: MissionsPage });
const missionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/missions/$missionId",
  validateSearch,
  component: function Mission() {
    return (
      <MissionPage
        key={missionRoute.useParams().missionId}
        missionId={missionRoute.useParams().missionId}
        runId={missionRoute.useSearch().run}
      />
    );
  },
});
// The night-only "Tonight" page became Agents.
const tonightRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tonight",
  beforeLoad: () => {
    throw redirect({ to: "/agents" });
  },
});
const laterRoute = createRoute({ getParentRoute: () => rootRoute, path: "/later", component: LaterPage });
const operationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations",
  component: OperationsPage,
});
const operationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations/$operationId",
  component: function Operation() {
    return <OperationPage operationId={operationRoute.useParams().operationId} />;
  },
});
const resultRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/results/$kind/$resultId",
  component: function Result() {
    return <ResultPage {...resultRoute.useParams()} />;
  },
});
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

// The launch link's ?t= key goes to storage and leaves the address bar, then
// back to the page a restart left edits on, before the router reads the URL.
takeLaunchKey();
resumeReturnPath();
void checkKey();

const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    historyRoute,
    nightRoute,
    agentsRoute,
    missionsRoute,
    missionRoute,
    tonightRoute,
    laterRoute,
    settingsRoute,
    operationsRoute,
    operationRoute,
    resultRoute,
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

/** The dashboard once the API takes our key; the locked page when it doesn't. */
function Gate() {
  const lock = useSyncExternalStore(lockStore.subscribe, lockStore.get);
  if (lock === "checking") return null;
  if (lock === "locked") return <LockedPage />;
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

createRoot(root).render(
  <StrictMode>
    <Gate />
  </StrictMode>,
);
