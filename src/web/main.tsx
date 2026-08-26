/**
 * The browser entrypoint. Everything below it observes; nothing below it
 * decides (R3).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "./data/theme";
import { router } from "./router";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // The server is one hop away and the queue changes constantly; there is
      // no snapshot of it worth reusing without checking.
      staleTime: 0,
      // A queue view that silently stopped updating is worse than one that
      // reloads on focus.
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root — the bundle and the page disagree");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <TooltipProvider delayDuration={200}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
