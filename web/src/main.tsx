import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DemoModeProvider } from "./lib/demo";
import { ThemeProvider } from "./lib/theme";
import { router } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <DemoModeProvider>
          <RouterProvider router={router} />
        </DemoModeProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
