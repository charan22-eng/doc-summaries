import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText } from "ai";
import { z } from "zod";
import {
  FORMAT_OPTIONS,
  LENGTH_OPTIONS,
  MAX_BODY_BYTES,
  MAX_CHARS,
  MIN_CHARS,
  SummaryFormat,
  SummaryLength,
} from "@/lib/limits";
import {
  buildSystemPrompt,
  DEFAULT_GEMINI_MODEL,
  MAX_OUTPUT_TOKENS,
  wrapUserContent,
} from "@/lib/prompt";
import { checkRateLimit } from "@/lib/ratelimit";

// Enforce nodejs runtime and 30-second maximum duration
export const runtime = "nodejs";
export const maxDuration = 30;

// Zod schema for input validation
const summariseRequestSchema = z.object({
  text: z.string({
    required_error: "text is required",
    invalid_type_error: "text must be a string",
  }),
  length: z.enum(LENGTH_OPTIONS, {
    errorMap: () => ({
      message: `length must be one of: ${LENGTH_OPTIONS.join(", ")}`,
    }),
  }),
  format: z.enum(FORMAT_OPTIONS, {
    errorMap: () => ({
      message: `format must be one of: ${FORMAT_OPTIONS.join(", ")}`,
    }),
  }),
});

/**
 * Handle non-POST HTTP methods with 405 Method Not Allowed
 */
export async function GET() {
  return Response.json(
    {
      error: {
        code: "method_not_allowed",
        message: "Only POST requests are supported for summarisation.",
      },
    },
    {
      status: 405,
      headers: {
        Allow: "POST",
      },
    }
  );
}

export async function PUT() {
  return GET();
}

export async function DELETE() {
  return GET();
}

export async function PATCH() {
  return GET();
}

/**
 * Mock stream generator for verified local development and test runs when API key is not configured.
 */
async function* generateMockTokens(length: SummaryLength, format: SummaryFormat): AsyncGenerator<string> {
  let content = "";
  if (format === "takeaways") {
    content =
      "**Key Takeaways**\n" +
      "- AlphaFold resolved the historic 50-year protein folding challenge using deep neural networks.\n" +
      "- Provides atomic-resolution 3D coordinate predictions directly from 1D amino acid sequences.\n" +
      "- Millions of predicted structural models accelerate targeted pharmaceutical design and therapeutics.\n" +
      "- Eliminates costly experimental bottlenecks in molecular biology and structural determination.";
  } else if (format === "bullets") {
    content =
      "- DeepMind's AlphaFold transformed structural biology by solving the 50-year-old protein folding problem.\n" +
      "- Deep transformer architectures predict atomic-level 3D molecular structures from linear sequences.\n" +
      "- The open database of hundreds of millions of structures accelerates drug discovery and enzyme design.\n" +
      "- Computational prediction has shifted structural biology from experimental bottlenecks to automated inquiry.";
  } else {
    content =
      "AlphaFold transformed modern structural biology by successfully solving the fifty-year protein folding challenge. " +
      "By utilizing deep transformer architectures alongside evolutionary sequence constraints, it predicts high-accuracy " +
      "three-dimensional macromolecular shapes directly from amino acid sequences. This computational breakthrough replaces " +
      "arduous experimental crystallographic workflows and rapidly accelerates targeted drug discovery and enzyme engineering globally.";
  }

  const words = content.split(" ");
  for (let i = 0; i < words.length; i++) {
    yield (i === 0 ? "" : " ") + words[i];
    // Realistic inter-token arrival delay (20ms)
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * POST /api/summarise
 */
export async function POST(req: Request) {
  // 1. Check Content-Length BEFORE parsing body
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(contentLength) && contentLength > MAX_BODY_BYTES) {
      return Response.json(
        {
          error: {
            code: "payload_too_large",
            message: `Content-Length ${contentLength} bytes exceeds the maximum limit of ${MAX_BODY_BYTES} bytes (100 KB).`,
          },
        },
        { status: 413 }
      );
    }
  }

  // 2. In-memory per-IP Rate Limiting (10 requests/minute)
  // Best-effort on serverless platforms (multi-instance/ephemeral containers)
  const forwardedFor = req.headers.get("x-forwarded-for");
  const realIp = req.headers.get("x-real-ip");
  const clientIp = (forwardedFor ? forwardedFor.split(",")[0] : realIp || "127.0.0.1").trim();

  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error: {
          code: "rate_limited",
          message: `Rate limit exceeded. Please wait ${rateLimit.retryAfterSeconds} seconds before retrying.`,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds || 60),
        },
      }
    );
  }

  // 3. Parse JSON body safely
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_input",
          message: "Request body contains malformed JSON.",
        },
      },
      { status: 400 }
    );
  }

  // 4. Validate body shape with Zod
  const parseResult = summariseRequestSchema.safeParse(rawBody);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const field = firstIssue.path.length > 0 ? String(firstIssue.path[0]) : undefined;
    return Response.json(
      {
        error: {
          code: "invalid_input",
          message: firstIssue.message,
          ...(field ? { field } : {}),
        },
      },
      { status: 400 }
    );
  }

  const { text, length, format } = parseResult.data;

  // 5. Semantic string validation (empty, whitespace-only, MIN_CHARS, MAX_CHARS)
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    return Response.json(
      {
        error: {
          code: "invalid_input",
          field: "text",
          message: "Text cannot be empty or whitespace-only.",
        },
      },
      { status: 400 }
    );
  }

  if (text.length < MIN_CHARS) {
    return Response.json(
      {
        error: {
          code: "invalid_input",
          field: "text",
          message: `Text must be at least ${MIN_CHARS} characters (received ${text.length}).`,
        },
      },
      { status: 400 }
    );
  }

  if (text.length > MAX_CHARS) {
    return Response.json(
      {
        error: {
          code: "invalid_input",
          field: "text",
          message: `Text exceeds maximum allowed length of ${MAX_CHARS} characters (received ${text.length}).`,
        },
      },
      { status: 400 }
    );
  }

  // 6. Check Provider Configuration (Google Generative AI / Gemini)
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  const isMockMode = process.env.USE_MOCK_LLM === "true" || apiKey === "mock-key";

  if (!apiKey && !isMockMode) {
    // Missing API key: generic client message, detailed server log
    console.error("[Digest Server Error] GOOGLE_GENERATIVE_AI_API_KEY is not defined in environment variables.");
    return Response.json(
      {
        error: {
          code: "server_misconfigured",
          message: "The summarisation service is temporarily misconfigured. Please contact support.",
        },
      },
      { status: 500 }
    );
  }

  // 7. Initialize Streaming Pipeline with Priming
  let tokenIterator: AsyncIterator<string>;
  let capturedStreamError: unknown = null;

  if (isMockMode) {
    tokenIterator = generateMockTokens(length, format);
  } else {
    try {
      const google = createGoogleGenerativeAI({
        apiKey: apiKey!,
      });
      const modelId = process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || DEFAULT_GEMINI_MODEL;

      const result = streamText({
        model: google(modelId),
        system: buildSystemPrompt(length, format),
        prompt: wrapUserContent(text),
        maxTokens: MAX_OUTPUT_TOKENS,
        onError({ error }) {
          capturedStreamError = error;
          console.error("[Digest Gemini Provider stream error]:", error);
        },
      });

      tokenIterator = result.textStream[Symbol.asyncIterator]();
    } catch (initErr: any) {
      console.error("[Digest Gemini Provider init error]:", initErr);
      return Response.json(
        {
          error: {
            code: "upstream_failed",
            message: "Failed to initialize communication with Google Gemini API.",
          },
        },
        { status: 502 }
      );
    }
  }

  // 8. Stream Priming: Await the first chunk before sending 200 HTTP response
  let firstChunk: IteratorResult<string>;
  try {
    firstChunk = await tokenIterator.next();
    if (capturedStreamError) {
      throw capturedStreamError;
    }
  } catch (primeErr: any) {
    console.error("[Digest Gemini Stream Priming Error]:", primeErr);
    const errString = primeErr?.message || String(primeErr);

    const isAuth =
      errString.includes("401") ||
      errString.includes("403") ||
      errString.includes("API_KEY_INVALID") ||
      errString.includes("api_key") ||
      errString.includes("authentication") ||
      errString.includes("API key not valid");

    if (isAuth) {
      return Response.json(
        {
          error: {
            code: "server_misconfigured",
            message: "The Google Gemini API credentials are invalid. Please check server configuration.",
          },
        },
        { status: 500 }
      );
    }

    const isTimeout = errString.includes("timeout") || errString.includes("ETIMEDOUT");
    if (isTimeout) {
      return Response.json(
        {
          error: {
            code: "timeout",
            message: "Google Gemini timed out while generating summary.",
          },
        },
        { status: 504 }
      );
    }

    return Response.json(
      {
        error: {
          code: "upstream_failed",
          message: "Google Gemini was unable to generate a summary. Please try again.",
        },
      },
      { status: 502 }
    );
  }

  // 9. Priming succeeded: construct ReadableStream emitting first chunk then remaining chunks
  const textEncoder = new TextEncoder();
  const readableStream = new ReadableStream({
    async start(controller) {
      // Emit the primed first chunk if present
      if (!firstChunk.done && firstChunk.value) {
        controller.enqueue(textEncoder.encode(firstChunk.value));
      }

      if (firstChunk.done) {
        controller.close();
        return;
      }

      // Stream the remaining chunks
      try {
        while (true) {
          const { done, value } = await tokenIterator.next();
          if (capturedStreamError) {
            throw capturedStreamError;
          }
          if (done) break;
          if (value) {
            controller.enqueue(textEncoder.encode(value));
          }
        }
        controller.close();
      } catch (streamErr) {
        console.error("[Digest Mid-stream Emission Error]:", streamErr);
        // Error the stream so the client detects interruption while preserving partial text
        controller.error(streamErr);
      }
    },
  });

  return new Response(readableStream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
