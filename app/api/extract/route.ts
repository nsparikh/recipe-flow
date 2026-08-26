import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { extractRecipeGraph } from "../../../lib/extraction/extract";
import { buildRecipeView } from "../../../lib/view-model";
import { API_KEY_HEADER, looksLikeApiKey } from "../../../lib/api-key";

/**
 * A high-effort extraction can run well past the default serverless limit. Streaming inside
 * `extractRecipeGraph` keeps the connection alive; this raises the function's own ceiling.
 * 300s needs Fluid Compute (the Vercel default for new projects) — drop to 60 if a deploy rejects it.
 */
export const maxDuration = 300;

const MAX_INPUT_CHARS = 50_000;

export async function POST(request: Request) {
  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Paste a recipe first." }, { status: 400 });
  }
  if (text.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { error: `That recipe is ${text.length} characters. The limit is ${MAX_INPUT_CHARS}.` },
      { status: 400 },
    );
  }
  // The key arrives per request in a header, is used for this call only, and is never logged or
  // persisted. Deliberately not read from the environment — every user brings their own.
  const apiKey = request.headers.get(API_KEY_HEADER)?.trim() ?? "";
  if (!apiKey) {
    return NextResponse.json({ error: "Add your Anthropic API key to continue." }, { status: 401 });
  }
  if (!looksLikeApiKey(apiKey)) {
    return NextResponse.json(
      { error: "That does not look like an Anthropic API key. They start with \"sk-ant-\"." },
      { status: 401 },
    );
  }

  try {
    const outcome = await extractRecipeGraph(text, { apiKey, signal: request.signal });

    if (outcome.ok) {
      return NextResponse.json({
        // The graph is returned alongside the view so the client can persist it (M5).
        graph: outcome.graph,
        view: buildRecipeView(outcome.graph),
        attempts: outcome.attempts,
        usage: outcome.usage,
      });
    }

    return NextResponse.json(
      {
        error: outcome.message,
        errors: outcome.errors,
        attempts: outcome.attempts,
      },
      { status: 422 },
    );
  } catch (cause) {
    // Most specific first, so retryable and non-retryable failures stay distinguishable.
    if (cause instanceof Anthropic.AuthenticationError) {
      return NextResponse.json(
        { error: "Anthropic rejected that API key. Check it and try again." },
        { status: 401 },
      );
    }
    if (cause instanceof Anthropic.PermissionDeniedError) {
      return NextResponse.json(
        { error: "That API key does not have access to this model." },
        { status: 403 },
      );
    }
    if (cause instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Rate limited by the Anthropic API. Try again shortly." }, { status: 429 });
    }
    if (cause instanceof Anthropic.APIConnectionError) {
      return NextResponse.json({ error: "Could not reach the Anthropic API." }, { status: 502 });
    }
    if (cause instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `Anthropic API error: ${cause.message}` }, { status: 502 });
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return NextResponse.json({ error: `Extraction failed: ${message}` }, { status: 500 });
  }
}
