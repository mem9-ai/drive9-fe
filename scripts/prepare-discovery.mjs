import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Public discovery is a separately indexed surface; previews must remain unindexed.
export async function prepareDiscovery(destination, siteDirectory, context) {
  const discoveryPages = [
    "",
    "get-started/",
    "analyze-sales-data/",
    "api/",
    "privacy/",
  ];
  const publicUrls = [];
  for (const path of discoveryPages) {
    const file = resolve(destination, "discover", path, "index.html");
    let page;
    try {
      page = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const url = "https://drive9.ai/studio/discover/" + path;
    page = page
      .replace(/<link rel="canonical"[^>]*>/g, "")
      .replace(/<meta property="og:url"[^>]*>/g, "")
      .replace(/<meta name="robots"[^>]*>/g, "");
    const meta =
      context === "production"
        ? `<meta name="robots" content="index,follow"><link rel="canonical" href="${url}"><meta property="og:url" content="${url}">`
        : '<meta name="robots" content="noindex,follow">';
    await writeFile(file, page.replace("</head>", meta + "</head>"));
    if (context === "production") publicUrls.push(url);
  }
  if (publicUrls.length) {
    const sitemap = resolve(siteDirectory, "sitemap.xml");
    let xml = await readFile(sitemap, "utf8");
    const entries = publicUrls
      .filter((url) => !xml.includes(`<loc>${url}</loc>`))
      .map((url) => `  <url><loc>${url}</loc></url>`)
      .join("\n");
    await writeFile(sitemap, xml.replace("</urlset>", entries + "\n</urlset>"));
    await writeFile(
      resolve(destination, "sitemap.xml"),
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
        publicUrls.map((url) => `<url><loc>${url}</loc></url>`).join("") +
        "</urlset>",
    );
    await writeFile(
      resolve(siteDirectory, "llms.txt"),
      "# Drive9\n\nDrive9 provides persistent files and a data workspace for developers and agents. Availability and limits are documented on each product page.\n\n## Workspace\n" +
        publicUrls.map((url) => "- " + url).join("\n") +
        "\n\n## Product documentation\n- https://drive9.ai/sdk.html\n- https://drive9.ai/skill.md\n- https://drive9.ai/security.html\n",
    );
    const home = resolve(siteDirectory, "index.html");
    const html = await readFile(home, "utf8");
    if (!html.includes('href="/studio/discover/"'))
      await writeFile(
        home,
        html.replace(
          "</nav>",
          '<a href="/studio/discover/">Workspace guide</a></nav>',
        ),
      );
  }
  await writeFile(
    resolve(siteDirectory, "404.html"),
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page not found</title><main><h1>Page not found</h1><p><a href="/studio/discover/">Explore Drive9 Workspace</a></p></main></html>',
  );
}
