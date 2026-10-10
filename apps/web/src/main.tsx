import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./components/shell";
import { ReportPage } from "./routes/report";

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

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, nightRoute]),
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
