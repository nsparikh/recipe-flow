/**
 * URL -> plain recipe text.
 *
 * Two strategies, in order of reliability:
 *
 * 1. `schema.org/Recipe` JSON-LD. Most recipe sites publish one, and it gives clean ingredients and
 *    instructions with no scraping heuristics at all.
 * 2. Stripped page text. Everything else — let the extraction model find the recipe in the noise.
 */

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_TEXT_CHARS = 50_000;

/** Honest identification. Many sites reject requests with no user agent at all. */
const USER_AGENT = "RecipeFlow/0.1 (recipe graph extractor; +https://github.com/nsparikh/recipe-flow)";

export type FetchFailureReason =
  | "invalid-url"
  | "blocked-host"
  | "unreachable"
  | "http-error"
  | "not-html"
  | "too-large"
  | "no-recipe";

export class RecipeFetchError extends Error {
  constructor(
    readonly reason: FetchFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "RecipeFetchError";
  }
}

export interface FetchedRecipe {
  text: string;
  /** Which strategy produced the text. Useful for judging how much to trust it. */
  source: "json-ld" | "page-text";
  finalUrl: string;
}

export async function fetchRecipeText(
  rawUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<FetchedRecipe> {
  const url = parseAndGuardUrl(rawUrl);

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en",
      },
    });
  } catch (cause) {
    const detail = cause instanceof Error && cause.name === "TimeoutError" ? " (timed out)" : "";
    throw new RecipeFetchError("unreachable", `Could not reach ${url.hostname}${detail}.`);
  }

  if (!response.ok) {
    throw new RecipeFetchError(
      "http-error",
      describeHttpFailure(response.status, url.hostname),
    );
  }

  // A redirect could land somewhere that would not have passed the original guard.
  const finalUrl = new URL(response.url || url.toString());
  if (isBlockedHost(finalUrl.hostname)) {
    throw new RecipeFetchError("blocked-host", "That URL redirected to a private address.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
    throw new RecipeFetchError("not-html", `That URL returned ${contentType.split(";")[0]}, not a web page.`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_HTML_BYTES) {
    throw new RecipeFetchError("too-large", "That page is too large to process.");
  }

  const html = await response.text();
  if (html.length > MAX_HTML_BYTES) {
    throw new RecipeFetchError("too-large", "That page is too large to process.");
  }

  const structured = recipeTextFromJsonLd(html);
  if (structured) {
    return { text: truncate(structured), source: "json-ld", finalUrl: finalUrl.toString() };
  }

  const stripped = stripHtml(html);
  if (stripped.length < 200) {
    throw new RecipeFetchError(
      "no-recipe",
      "No recipe text was found on that page. It may require JavaScript, or be behind a paywall. Try pasting the recipe instead.",
    );
  }

  return { text: truncate(stripped), source: "page-text", finalUrl: finalUrl.toString() };
}

// --- URL guarding -----------------------------------------------------------

export function parseAndGuardUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new RecipeFetchError("invalid-url", "That is not a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RecipeFetchError("invalid-url", "Only http and https URLs are supported.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new RecipeFetchError("blocked-host", "That address is not allowed.");
  }
  return url;
}

/**
 * Blocks loopback, private, and link-local targets.
 *
 * The server fetches whatever URL it is handed, so without this a visitor could use it to read
 * addresses only the server can reach — cloud metadata endpoints being the classic example.
 *
 * This checks the hostname as written. A domain that resolves to a private address still gets
 * through (DNS rebinding); closing that needs resolve-then-check-then-connect, which is more than
 * a prototype warrants. Noted in PLAN.md §10.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  // Bare hostnames with no dot are intranet names.
  if (!host.includes(".") && !host.includes(":")) return true;

  if (host === "::1" || host === "::") return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // cloud metadata
    if (a >= 224) return true; // multicast and reserved
  }

  return false;
}

// --- JSON-LD ----------------------------------------------------------------

/** Pulls a schema.org Recipe out of the page's structured data and formats it as plain text. */
export function recipeTextFromJsonLd(html: string): string | null {
  for (const raw of extractJsonLdBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const recipe = findRecipeNode(parsed);
    if (recipe) {
      const text = formatRecipe(recipe);
      if (text) return text;
    }
  }
  return null;
}

function extractJsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    blocks.push(match[1].trim());
  }
  return blocks;
}

type JsonObject = Record<string, unknown>;

/** Recipes hide inside arrays, `@graph` wrappers, and nested properties depending on the site. */
function findRecipeNode(node: unknown, depth = 0): JsonObject | null {
  if (depth > 6 || node === null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findRecipeNode(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const object = node as JsonObject;
  const type = object["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && t.toLowerCase() === "recipe")) {
    return object;
  }

  for (const value of Object.values(object)) {
    const found = findRecipeNode(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function formatRecipe(recipe: JsonObject): string | null {
  const ingredients = toStringArray(recipe.recipeIngredient);
  const instructions = flattenInstructions(recipe.recipeInstructions);
  if (ingredients.length === 0 || instructions.length === 0) return null;

  const lines: string[] = [];
  const name = firstString(recipe.name);
  if (name) lines.push(name);

  const yields = firstString(recipe.recipeYield);
  if (yields) lines.push(`Yield: ${yields}`);

  for (const [label, key] of [
    ["Prep time", "prepTime"],
    ["Cook time", "cookTime"],
    ["Total time", "totalTime"],
  ] as const) {
    const duration = formatDuration(firstString(recipe[key]));
    if (duration) lines.push(`${label}: ${duration}`);
  }

  lines.push("", "INGREDIENTS", "");
  lines.push(...ingredients);
  lines.push("", "INSTRUCTIONS", "");
  lines.push(...instructions);

  return lines.join("\n");
}

/**
 * Instructions come as a string, an array of strings, `HowToStep` objects, or `HowToSection`
 * groups. Section names are preserved as headings — they are exactly the explicit sub-recipe
 * markers the extraction prompt looks for.
 */
function flattenInstructions(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];

  if (typeof value === "string") {
    return splitProseInstructions(decodeEntities(stripTags(value)));
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenInstructions(entry, depth + 1));
  }
  if (typeof value !== "object") return [];

  const object = value as JsonObject;
  const type = String(object["@type"] ?? "").toLowerCase();

  if (type === "howtosection") {
    const heading = firstString(object.name);
    const steps = flattenInstructions(object.itemListElement, depth + 1);
    return heading ? [`For the ${stripLeadingFor(heading).toLowerCase()}:`, ...steps] : steps;
  }

  const text = firstString(object.text) ?? firstString(object.name);
  return text ? [decodeEntities(stripTags(text))] : [];
}

/** A single prose blob needs breaking into steps or the model sees one giant instruction. */
function splitProseInstructions(text: string): string[] {
  const byLine = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return byLine.length > 1 ? byLine : [text.trim()].filter(Boolean);
}

function stripLeadingFor(heading: string): string {
  return heading.replace(/^for\s+the\s+/i, "").replace(/:$/, "");
}

/** ISO 8601 duration -> something a language model reads without effort. */
export function formatDuration(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!match) return null;

  const [days, hours, minutes] = match.slice(1).map((n) => (n ? Number(n) : 0));
  const total = days * 1440 + hours * 60 + minutes;
  if (total === 0) return null;

  const parts: string[] = [];
  if (total >= 60) parts.push(`${Math.floor(total / 60)} hours`);
  if (total % 60 !== 0) parts.push(`${total % 60} minutes`);
  return parts.join(" ");
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [decodeEntities(stripTags(value))];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : firstString((entry as JsonObject)?.name)))
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => decodeEntities(stripTags(entry)));
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) return firstString(value[0]);
  return undefined;
}

// --- HTML stripping ---------------------------------------------------------

/** Crude but adequate: the extraction model tolerates noise, so this only has to remove markup. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    frac12: "½", frac14: "¼", frac34: "¾", frac13: "⅓", frac23: "⅔",
    deg: "°", mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'",
    ldquo: '"', rdquo: '"',
  };
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z][a-z0-9]*);/gi, (whole, name) => named[name.toLowerCase()] ?? whole);
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]` : text;
}

function describeHttpFailure(status: number, hostname: string): string {
  if (status === 401 || status === 402) return `${hostname} requires a subscription to read that recipe.`;
  if (status === 403) return `${hostname} refused the request. Some sites block automated readers — try pasting the recipe instead.`;
  if (status === 404) return "That page does not exist.";
  if (status === 429) return `${hostname} is rate limiting requests. Try again shortly.`;
  if (status >= 500) return `${hostname} returned a server error.`;
  return `${hostname} returned HTTP ${status}.`;
}
