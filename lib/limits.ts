/**
 * Shared limits between client and server for text summarisation.
 */
export const MIN_CHARS = 50;
export const MAX_CHARS = 20000;

// Maximum allowed payload size (100 KB) checked before reading/parsing request body
export const MAX_BODY_BYTES = 100 * 1024; // 100 KB = 102,400 bytes

// Length options supported by the summariser
export const LENGTH_OPTIONS = ["brief", "standard", "detailed"] as const;
export type SummaryLength = (typeof LENGTH_OPTIONS)[number];

// Format options supported by the summariser
export const FORMAT_OPTIONS = ["paragraph", "bullets", "takeaways"] as const;
export type SummaryFormat = (typeof FORMAT_OPTIONS)[number];

// Rate limiting configuration
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per minute per IP
