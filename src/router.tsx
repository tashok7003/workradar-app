import { createContext, useContext, useState, type ReactNode } from "react";

export type Route =
  | { name: "dashboard" }
  | { name: "feed"; tab?: FeedTab }
  | { name: "item"; id: string }
  | { name: "search"; q?: string };

export type FeedTab = "now" | "today" | "later" | "snoozed" | "all";

interface RouterCtx {
  route: Route;
  go: (r: Route) => void;
  back: () => void;
  canGoBack: boolean;
}

const Ctx = createContext<RouterCtx | null>(null);

/**
 * In-memory router. The app also runs inside a sandboxed frame (the hosted
 * demo), where history and hash state are unreliable, so routing lives in
 * React state with its own back stack.
 */
export function RouterProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: "dashboard" }]);
  const route = stack[stack.length - 1];
  const go = (r: Route) => {
    setStack((s) => [...s.slice(-30), r]);
    try { document.querySelector("main")?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 }); } catch { /* noop */ }
  };
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : [{ name: "dashboard" }]));
  return <Ctx.Provider value={{ route, go, back, canGoBack: stack.length > 1 }}>{children}</Ctx.Provider>;
}

export function useRouter(): RouterCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRouter must be used inside RouterProvider");
  return c;
}
