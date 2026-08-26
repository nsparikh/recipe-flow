import { describe, it, expect } from "vitest";
import {
  isBlockedHost,
  parseAndGuardUrl,
  recipeTextFromJsonLd,
  stripHtml,
  formatDuration,
  RecipeFetchError,
} from "../fetch-page";

describe("host guarding", () => {
  it("allows ordinary public hosts", () => {
    expect(isBlockedHost("cookieandkate.com")).toBe(false);
    expect(isBlockedHost("www.bbc.co.uk")).toBe(false);
    expect(isBlockedHost("203.0.113.10")).toBe(false);
  });

  it("blocks loopback and localhost", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true);
  });

  it("blocks private ranges", () => {
    expect(isBlockedHost("10.0.0.5")).toBe(true);
    expect(isBlockedHost("192.168.1.1")).toBe(true);
    expect(isBlockedHost("172.16.0.1")).toBe(true);
    expect(isBlockedHost("172.31.255.255")).toBe(true);
    // 172.32 is public — the private block is 172.16–172.31 only.
    expect(isBlockedHost("172.32.0.1")).toBe(false);
  });

  it("blocks the cloud metadata endpoint", () => {
    // The classic SSRF target: readable from the server, not from the internet.
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  it("blocks intranet-style names", () => {
    expect(isBlockedHost("intranet")).toBe(true);
    expect(isBlockedHost("printer.local")).toBe(true);
    expect(isBlockedHost("db.internal")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(() => parseAndGuardUrl("file:///etc/passwd")).toThrow(RecipeFetchError);
    expect(() => parseAndGuardUrl("ftp://example.com/x")).toThrow(RecipeFetchError);
  });

  it("rejects malformed input and blocked hosts with a reason", () => {
    expect(() => parseAndGuardUrl("not a url")).toThrow(
      expect.objectContaining({ reason: "invalid-url" }),
    );
    expect(() => parseAndGuardUrl("http://169.254.169.254/latest/meta-data/")).toThrow(
      expect.objectContaining({ reason: "blocked-host" }),
    );
  });

  it("accepts a well-formed recipe URL", () => {
    expect(parseAndGuardUrl("https://example.com/recipe").hostname).toBe("example.com");
  });
});

describe("JSON-LD extraction", () => {
  const page = (jsonLd: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>noise</body></html>`;

  it("reads a plain Recipe object", () => {
    const text = recipeTextFromJsonLd(
      page({
        "@type": "Recipe",
        name: "Tomato Soup",
        recipeYield: "4 servings",
        recipeIngredient: ["2 tins tomatoes", "1 onion, chopped"],
        recipeInstructions: ["Soften the onion.", "Add tomatoes and simmer."],
      }),
    );
    expect(text).toContain("Tomato Soup");
    expect(text).toContain("Yield: 4 servings");
    expect(text).toContain("1 onion, chopped");
    expect(text).toContain("Add tomatoes and simmer.");
  });

  it("finds a Recipe inside an @graph wrapper", () => {
    const text = recipeTextFromJsonLd(
      page({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebSite", name: "A Food Blog" },
          {
            "@type": "Recipe",
            name: "Buried Recipe",
            recipeIngredient: ["1 egg"],
            recipeInstructions: ["Fry it."],
          },
        ],
      }),
    );
    expect(text).toContain("Buried Recipe");
  });

  it("handles an array of @type values", () => {
    const text = recipeTextFromJsonLd(
      page({
        "@type": ["Recipe", "NewsArticle"],
        name: "Dual Typed",
        recipeIngredient: ["1 egg"],
        recipeInstructions: ["Fry it."],
      }),
    );
    expect(text).toContain("Dual Typed");
  });

  it("reads HowToStep instruction objects", () => {
    const text = recipeTextFromJsonLd(
      page({
        "@type": "Recipe",
        name: "Stepped",
        recipeIngredient: ["1 egg"],
        recipeInstructions: [
          { "@type": "HowToStep", text: "Crack the egg." },
          { "@type": "HowToStep", text: "Fry the egg." },
        ],
      }),
    );
    expect(text).toContain("Crack the egg.");
    expect(text).toContain("Fry the egg.");
  });

  it("preserves HowToSection names as sub-recipe headings", () => {
    // These headings are exactly what the extraction prompt uses to decide on components.
    const text = recipeTextFromJsonLd(
      page({
        "@type": "Recipe",
        name: "Sectioned",
        recipeIngredient: ["1 egg", "butter"],
        recipeInstructions: [
          {
            "@type": "HowToSection",
            name: "For the sauce",
            itemListElement: [{ "@type": "HowToStep", text: "Melt the butter." }],
          },
        ],
      }),
    );
    expect(text).toContain("For the sauce:");
    expect(text).toContain("Melt the butter.");
  });

  it("strips markup and decodes entities inside fields", () => {
    const text = recipeTextFromJsonLd(
      page({
        "@type": "Recipe",
        name: "Fractions",
        recipeIngredient: ["<b>&frac12; cup</b> sugar", "1 tbsp caf&#233; syrup"],
        recipeInstructions: ["Mix &amp; serve."],
      }),
    );
    expect(text).toContain("½ cup sugar");
    expect(text).toContain("café syrup");
    expect(text).toContain("Mix & serve.");
    expect(text).not.toContain("<b>");
  });

  it("returns null when the block has no usable recipe", () => {
    expect(recipeTextFromJsonLd(page({ "@type": "WebSite", name: "Not a recipe" }))).toBeNull();
    // A Recipe with no instructions is not usable either.
    expect(recipeTextFromJsonLd(page({ "@type": "Recipe", name: "Empty", recipeIngredient: [] }))).toBeNull();
  });

  it("survives malformed JSON without throwing", () => {
    const html = '<script type="application/ld+json">{ not json </script>';
    expect(recipeTextFromJsonLd(html)).toBeNull();
  });

  it("skips a broken block and uses a later valid one", () => {
    const html =
      '<script type="application/ld+json">{oops</script>' +
      page({ "@type": "Recipe", name: "Second Block", recipeIngredient: ["1 egg"], recipeInstructions: ["Fry."] });
    expect(recipeTextFromJsonLd(html)).toContain("Second Block");
  });
});

describe("duration formatting", () => {
  it("converts ISO 8601 durations to readable text", () => {
    expect(formatDuration("PT30M")).toBe("30 minutes");
    expect(formatDuration("PT1H")).toBe("1 hours");
    expect(formatDuration("PT1H30M")).toBe("1 hours 30 minutes");
  });

  it("ignores absent, zero and unparseable values", () => {
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration("PT0M")).toBeNull();
    expect(formatDuration("half an hour")).toBeNull();
  });
});

describe("HTML stripping", () => {
  it("removes scripts, styles and tags but keeps the text", () => {
    const text = stripHtml(`
      <html><head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body><h1>Soup</h1><p>Chop the onion.</p></body></html>
    `);
    expect(text).toContain("Soup");
    expect(text).toContain("Chop the onion.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("turns block boundaries into line breaks so steps stay separate", () => {
    const text = stripHtml("<li>Chop the onion.</li><li>Fry the onion.</li>");
    expect(text.split("\n").filter(Boolean)).toEqual(["Chop the onion.", "Fry the onion."]);
  });

  it("collapses runaway whitespace", () => {
    expect(stripHtml("<p>a</p>\n\n\n\n\n<p>b</p>")).toBe("a\n\nb");
  });
});
