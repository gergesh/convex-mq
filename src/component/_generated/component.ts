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
      ack: FunctionReference<
        "mutation",
        "internal",
        { claimId: string; messageId: string },
        null,
        Name
      >;
      claim: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        Array<{ attempts: number; claimId: string; id: string; payload: any }>,
        Name
      >;
      nack: FunctionReference<
        "mutation",
        "internal",
        { claimId: string; error?: string; messageId: string },
        any,
        Name
      >;
      peek: FunctionReference<"query", "internal", {}, boolean, Name>;
      publish: FunctionReference<
        "mutation",
        "internal",
        { maxAttempts?: number; payload: any; visibilityTimeoutMs?: number },
        string,
        Name
      >;
      publishBatch: FunctionReference<
        "mutation",
        "internal",
        {
          messages: Array<{
            maxAttempts?: number;
            payload: any;
            visibilityTimeoutMs?: number;
          }>;
        },
        Array<string>,
        Name
      >;
    };
  };
