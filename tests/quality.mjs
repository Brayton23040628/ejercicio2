import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 4173;
const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript"
};

const server = createServer(async (request, response) => {
  const requestedPath = request.url === "/" ? "/index.html" : request.url;
  const filePath = join(root, requestedPath);

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "text/plain"
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const html = await readFile(join(root, "index.html"), "utf8");
const externalUrls = [...html.matchAll(/(?:href|src)=["'](https?:\/\/[^"']+)["']/gi)]
  .map((match) => match[1]);
const insecureUrls = externalUrls.filter((url) => new URL(url).protocol !== "https:");
if (insecureUrls.length > 0) {
  throw new Error(`Enlaces externos inseguros: ${insecureUrls.join(", ")}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
try {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });

  const semanticChecks = await page.evaluate(() => ({
    language: document.documentElement.lang,
    mainCount: document.querySelectorAll("main").length,
    headingCount: document.querySelectorAll("h1").length,
    formCount: document.querySelectorAll("form").length,
    unlabeledInputs: [...document.querySelectorAll("input")]
      .filter((input) => !input.labels?.length)
      .map((input) => input.id || input.name)
  }));

  if (semanticChecks.language !== "es" || semanticChecks.mainCount !== 1 ||
      semanticChecks.headingCount !== 1 || semanticChecks.formCount !== 1 ||
      semanticChecks.unlabeledInputs.length > 0) {
    throw new Error(`Fallo semántico: ${JSON.stringify(semanticChecks)}`);
  }

  const accessibilityResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  if (accessibilityResults.violations.length > 0) {
    const details = accessibilityResults.violations
      .map((violation) => `${violation.id}: ${violation.help}`)
      .join("; ");
    throw new Error(`Fallo WCAG 2 AA: ${details}`);
  }

  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.reload({ waitUntil: "networkidle" });
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth
    }));
    if (layout.documentWidth > layout.viewport + 1) {
      throw new Error(`Desbordamiento horizontal a ${width}px: ${JSON.stringify(layout)}`);
    }
  }

  console.log("Calidad OK: semántica, WCAG 2 AA, enlaces HTTPS y responsive.");
} finally {
  await context.close();
  await browser.close();
  server.close();
}
