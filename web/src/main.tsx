import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import { StarfishAuthProvider } from "./auth/StarfishAuthProvider";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <StarfishAuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </StarfishAuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
);
