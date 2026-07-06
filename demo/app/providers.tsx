"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useMemo } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const client = useMemo(
    () =>
      // The placeholder keeps `next build` from throwing while prerendering
      // when NEXT_PUBLIC_CONVEX_URL isn't set; `convex deploy --cmd` injects
      // the real URL at build time on Vercel.
      new ConvexReactClient(
        process.env.NEXT_PUBLIC_CONVEX_URL ?? "https://placeholder.convex.cloud",
      ),
    [],
  );
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
