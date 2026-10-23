const MAX_HTML = 1200000;
const MAX_EMAILS = 8;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;

function reply(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin || "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function publicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }

  const h = u.hostname.toLowerCase();

  if (!["https:", "http:"].includes(u.protocol)) return null;
  if (u.username || u.password) return null;
  if (!h.includes(".") || h === "localhost") return null;
  if (h.endsWith(".local") || h.endsWith(".internal") ||
      h.endsWith(".localhost") || h === "metadata.google.internal") return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) return null;

  u.hash = "";
  return u;
}

async function fetchPage(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const start = Date.now();
    const response = await fetch(url.href, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": "StorePulsePublicAudit/1.0",
        "accept": "text/html,application/xhtml+xml"
      }
    });

    const responseMs = Date.now() - start;
    const contentType = response.headers.get("content-type") || "";

    if (response.status >= 300 && response.status < 400) {
      return { status: response.status, responseMs, html: "", contentType };
    }

    if (!response.ok ||
        !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return { status: response.status, responseMs, html: "", contentType };
    }

    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, responseMs, html: "", contentType };

    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;

      if (total > MAX_HTML) {
        await reader.cancel();
        break;
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return {
      status: response.status,
      responseMs,
      html: new TextDecoder().decode(bytes),
      contentType
    };
  } finally {
    clearTimeout(timer);
  }
}

function strip(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function plain(html) {
  return html.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag, name) {
  const re = new RegExp(
    "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i"
  );
  const m = tag.match(re);
  return ((m && (m[1] ?? m[2] ?? m[3])) || "")
    .replace(/&amp;/gi, "&").trim();
}

function parsePage(html, url) {
  const h = strip(html);
  const metas = h.match(/<meta\b[^>]*>/gi) || [];
  const titleMatch = h.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const desc = metas.find(t => /\bname\s*=\s*["']description["']/i.test(t));
  const viewport = metas.some(t => /\bname\s*=\s*["']viewport["']/i.test(t));
  const images = h.match(/<img\b[^>]*>/gi) || [];
  const imagesWithAlt = images.filter(t => attr(t, "alt").length > 0).length;
  const anchors = h.match(/<a\b[^>]*>/gi) || [];
  const hrefs = anchors.map(t => attr(t, "href")).filter(Boolean);
  const canonicalTag = (h.match(/<link\b[^>]*>/gi) || [])
    .find(t => /\brel\s*=\s*["']canonical["']/i.test(t));

  const emails = new Map();
  const contactLinks = [];

  function addEmail(raw, source) {
    const email = raw.replace(/^mailto:/i, "").split("?")[0].toLowerCase().trim();
    EMAIL_RE.lastIndex = 0;
    if (email.length < 255 && EMAIL_RE.test(email) &&
        !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(email)) {
      emails.set(email, { email, source });
    }
    EMAIL_RE.lastIndex = 0;
  }

  for (const match of h.matchAll(/\bmailto:([^"'\s<>]+)/gi)) {
    addEmail(match[1], url.href);
  }

  EMAIL_RE.lastIndex = 0;
  for (const match of h.matchAll(EMAIL_RE)) {
    addEmail(match[0], url.href);
  }
  EMAIL_RE.lastIndex = 0;

  for (const href of hrefs) {
    try {
      const target = new URL(href, url.href);
      if (target.origin === url.origin &&
          /contact|about|support|customer-service|refund-policy/i.test(target.pathname)) {
        contactLinks.push(target.href);
      }
    } catch {}
  }

  return {
    title: titleMatch ? plain(titleMatch[1]) : "",
    metaDescription: desc ? attr(desc, "content") : "",
    viewport,
    h1Count: (h.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || []).length,
    images: {
      total: images.length,
      withAlt: imagesWithAlt,
      withoutAlt: images.length - imagesWithAlt
    },
    canonical: canonicalTag ? attr(canonicalTag, "href") : "",
    emails: [...emails.values()].slice(0, MAX_EMAILS),
    contactLinks: [...new Set(contactLinks)].slice(0, 2)
  };
}

async function audit(raw) {
  const url = publicUrl(raw);

  if (!url) {
    throw new Error("Enter a valid public HTTP or HTTPS website URL.");
  }

  const page = await fetchPage(url);
  const data = parsePage(page.html || "", url);
  const warnings = [];

  if (page.status >= 300 && page.status < 400) {
    warnings.push({ message: "The homepage redirects; this scan did not follow the redirect." });
  } else if (page.status >= 400) {
    warnings.push({ message: "The homepage returned HTTP " + page.status + "." });
  } else if (!page.html) {
    warnings.push({ message: "No readable HTML was returned for the homepage." });
  }

  if (page.html) {
    if (!data.title) {
      warnings.push({ message: "No HTML title was detected." });
    } else if (data.title.length < 20 || data.title.length > 65) {
      warnings.push({ message: "Title is " + data.title.length +
        " characters long; review its clarity and length." });
    }

    if (!data.metaDescription) warnings.push({ message: "No meta description was detected." });
    if (!data.viewport) warnings.push({ message: "No viewport meta tag was detected." });
    if (!data.h1Count) warnings.push({ message: "No H1 heading was detected." });

    if (data.images.withoutAlt > 0) {
      warnings.push({ message: data.images.withoutAlt + " of " +
        data.images.total + " images lack non-empty alt text." });
    }

    if (!data.canonical) warnings.push({ message: "No canonical link was detected." });
  }

  const foundEmails = new Map(data.emails.map(e => [e.email, e]));

  // Inspect a maximum of two contact/about pages linked from the homepage.
  for (const link of data.contactLinks) {
    try {
      const contactUrl = publicUrl(link);
      if (!contactUrl || contactUrl.origin !== url.origin) continue;

      const sub = await fetchPage(contactUrl, 5000);
      if (!sub.html) continue;

      const parsed = parsePage(sub.html, contactUrl);
      for (const e of parsed.emails) {
        if (foundEmails.size < MAX_EMAILS) foundEmails.set(e.email, e);
      }
    } catch {}
  }

  // Common Shopify contact page fallback.
  if (foundEmails.size === 0) {
    try {
      const contactUrl = new URL("/pages/contact", url.origin);
      const sub = await fetchPage(contactUrl, 4500);

      if (sub.html) {
        const parsed = parsePage(sub.html, contactUrl);
        for (const e of parsed.emails) {
          if (foundEmails.size < MAX_EMAILS) foundEmails.set(e.email, e);
        }
      }
    } catch {}
  }

  if (url.protocol !== "https:") {
    warnings.push({ message: "The submitted URL uses HTTP instead of HTTPS." });
  }

  const checks = [];
  function check(name, passed, available) {
    if (available) checks.push({ name, passed });
  }

  check("Homepage returned readable HTTP 2xx", page.status >= 200 && page.status < 300 && !!page.html, !!page.html);
  check("HTTPS enabled", url.protocol === "https:", true);
  check("HTML title present", !!data.title, !!page.html);
  check("Meta description present", !!data.metaDescription, !!page.html);
  check("Viewport tag present", data.viewport, !!page.html);
  check("H1 heading present", data.h1Count > 0, !!page.html);
  check("Images have alt text", data.images.withoutAlt === 0, !!page.html);
  check("Canonical link present", !!data.canonical, !!page.html);

  const score = checks.length
    ? Math.round(checks.filter(c => c.passed).length * 100 / checks.length)
    : null;

  return {
    url: url.href,
    domain: url.hostname,
    status: page.status >= 200 && page.status < 300 ? "Scanned" : "HTTP " + page.status,
    httpStatus: page.status,
    responseMs: page.responseMs,
    title: data.title,
    metaDescription: !!data.metaDescription,
    viewport: data.viewport,
    h1Count: data.h1Count,
    images: data.images,
    emails: [...foundEmails.values()].slice(0, MAX_EMAILS),
    warnings,
    healthScore: score,
    checks,
    checkedAt: new Date().toISOString(),
    scoreNote: "Score is based on completed public-HTML checks, not a full Lighthouse or Shopify audit."
  };
}

export default {
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const corsOrigin = allowedOrigin === "*" ? "*" : allowedOrigin;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": corsOrigin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type"
        }
      });
    }

    if (allowedOrigin !== "*" && requestOrigin && requestOrigin !== allowedOrigin) {
      return reply({ error: "Origin not allowed." }, 403, corsOrigin);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return reply({
        ok: true,
        service: "StorePulse audit API",
        version: "1.0",
        usesPageSpeedApi: false
      }, 200, corsOrigin);
    }

    if (request.method !== "POST" || url.pathname !== "/scan") {
      return reply({ error: "Use GET /health or POST /scan." }, 404, corsOrigin);
    }

    let body;
    try { body = await request.json(); }
    catch { return reply({ error: "Request body must be JSON." }, 400, corsOrigin); }

    if (!body || typeof body.url !== "string" || body.url.length > 2048) {
      return reply({ error: "Provide one store URL in the url field." }, 400, corsOrigin);
    }

    try {
      return reply({ result: await audit(body.url) }, 200, corsOrigin);
    } catch (error) {
      return reply({
        error: error instanceof Error ? error.message : "Scan failed."
      }, 400, corsOrigin);
    }
  }
};
