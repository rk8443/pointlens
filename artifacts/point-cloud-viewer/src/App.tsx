import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

// Wouter's `base` expects either "" or a path like "/my-app". Vite's
// BASE_URL is "/" for browser builds and "./" for the Tauri build (so
// asset URLs resolve under tauri://localhost/). Naively stripping a
// trailing slash leaves "." for Tauri, which wouter treats as a literal
// path segment and matches nothing — the whole app silently renders an
// empty body. Normalize both cases to "" instead.
const routerBase = import.meta.env.BASE_URL
  .replace(/^\.\/?/, "")   // "./"  -> ""
  .replace(/\/$/, "");     // "/x/" -> "/x"

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={routerBase}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
