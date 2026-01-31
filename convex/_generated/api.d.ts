/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as emailQueue from "../emailQueue.js";
import type * as secureQueue from "../secureQueue.js";
import type * as taskQueue from "../taskQueue.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";

declare const fullApi: ApiFromModules<{
  emailQueue: typeof emailQueue;
  secureQueue: typeof secureQueue;
  taskQueue: typeof taskQueue;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;

export declare const components: {
  emailQueue: {
    public: {
      ack: FunctionReference<"mutation", "internal", { claimId: string; messageId: string }, null>;
      claim: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        Array<{ attempts: number; claimId: string; id: string; payload: any }>
      >;
      nack: FunctionReference<
        "mutation",
        "internal",
        { claimId: string; error?: string; messageId: string },
        any
      >;
      peek: FunctionReference<"query", "internal", {}, boolean>;
      publish: FunctionReference<
        "mutation",
        "internal",
        { maxAttempts?: number; payload: any; visibilityTimeoutMs?: number },
        string
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
        Array<string>
      >;
    };
  };
  taskQueue: {
    public: {
      ack: FunctionReference<"mutation", "internal", { claimId: string; messageId: string }, null>;
      claim: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        Array<{ attempts: number; claimId: string; id: string; payload: any }>
      >;
      nack: FunctionReference<
        "mutation",
        "internal",
        { claimId: string; error?: string; messageId: string },
        any
      >;
      peek: FunctionReference<"query", "internal", {}, boolean>;
      publish: FunctionReference<
        "mutation",
        "internal",
        { maxAttempts?: number; payload: any; visibilityTimeoutMs?: number },
        string
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
        Array<string>
      >;
    };
  };
  secureQueue: {
    public: {
      ack: FunctionReference<"mutation", "internal", { claimId: string; messageId: string }, null>;
      claim: FunctionReference<
        "mutation",
        "internal",
        { limit?: number },
        Array<{ attempts: number; claimId: string; id: string; payload: any }>
      >;
      nack: FunctionReference<
        "mutation",
        "internal",
        { claimId: string; error?: string; messageId: string },
        any
      >;
      peek: FunctionReference<"query", "internal", {}, boolean>;
      publish: FunctionReference<
        "mutation",
        "internal",
        { maxAttempts?: number; payload: any; visibilityTimeoutMs?: number },
        string
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
        Array<string>
      >;
    };
  };
};
