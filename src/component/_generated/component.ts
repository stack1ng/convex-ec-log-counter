/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    public: {
      add: FunctionReference<
        "mutation",
        "internal",
        {
          compactionDelay?: number;
          compactionLeaseDuration?: number;
          delta: number;
          key: string;
        },
        null,
        Name
      >;
      addMany: FunctionReference<
        "mutation",
        "internal",
        {
          compactionDelay?: number;
          compactionLeaseDuration?: number;
          deltas: Array<{ delta: number; key: string }>;
        },
        null,
        Name
      >;
      read: FunctionReference<
        "query",
        "internal",
        { key: string; logScanLimit?: number },
        { count: number; fullyConsistent: boolean },
        Name
      >;
      reset: FunctionReference<
        "mutation",
        "internal",
        {
          compactionDelay?: number;
          compactionLeaseDuration?: number;
          key: string;
        },
        null,
        Name
      >;
    };
  };
