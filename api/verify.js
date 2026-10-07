const MODEL = "gemini-2.5-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_ITEM_LENGTH = 120;
const MAX_BODY_BYTES = 5000;

// Small in-memory guard. Serverless instances are ephemeral, so this is only
// a best-effort abuse reduction layer, not a permanent rate limiter.
const ipBuckets = globalThis.__ecoCountIpBuckets || new Map();
globalThis.__ecoCountIpBuckets = ipBuckets;

function json(res, data, status = 200, extraHeaders = {}) {
  res.status(status);
  Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders
  }).forEach(([key, value]) => res.setHeader(key, value));
  return res.json(data);
}

function getHeader(request, name) {
  const headers = request?.headers || {};
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function getOrigin(request) {
  return getHeader(request, "origin");
}

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function corsHeaders(request) {
  const origin = getOrigin(request);
  const allowed = getAllowedOrigins();

  if (!origin) return {};

  if (allowed.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Vary": "Origin"
    };
  }

  if (allowed.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
  }

  return {};
}

function getClientIp(request) {
  const forwarded = getHeader(request, "x-forwarded-for");
  return forwarded.split(",")[0].trim() || "unknown";
}

function rateLimit(ip) {
  const now = Date.now();
  const minute = 60 * 1000;
  const day = 24 * 60 * 60 * 1000;

  let bucket = ipBuckets.get(ip);

  if (!bucket || now - bucket.startedAt > day) {
    bucket = {
      startedAt: now,
      dayCount: 0,
      minuteStartedAt: now,
      minuteCount: 0
    };
    ipBuckets.set(ip, bucket);
  }

  if (now - bucket.minuteStartedAt > minute) {
    bucket.minuteStartedAt = now;
    bucket.minuteCount = 0;
  }

  if (bucket.minuteCount >= 4) {
    return { allowed: false, retryAfter: 60 };
  }

  if (bucket.dayCount >= 40) {
    return { allowed: false, retryAfter: 24 * 60 * 60 };
  }

  bucket.minuteCount += 1;
  bucket.dayCount += 1;

  return { allowed: true };
}

function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(part => typeof part?.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}


function buildClassifyPrompt(item) {
  return `
You are the classification engine for Eco Count.

The user entered this item:
"${item}"

Classify the exact question:
"can ${item} be plastic"

Use your general knowledge. Do NOT claim to have searched the web, and do not
provide URLs or citations. Return ONLY JSON matching this schema:
{
  "verdict": "YES" | "NO" | "UNCLEAR",
  "reason": "short explanation",
  "recognized_item": true | false,
  "actions": {
    "reduce": "short practical tip or empty string",
    "reuse": "short practical tip or empty string",
    "recycle": "short practical tip or empty string"
  }
}

Classification rules:
- YES: the item can reasonably be made from plastic or is commonly a plastic product.
- NO: the item as named is clearly not plastic and cannot reasonably be a plastic version.
- UNCLEAR: the term is ambiguous, malformed, not a recognizable item, the answer
  depends strongly on missing context, or you are not sufficiently confident.
- If an item can reasonably be plastic, use YES even if it is also sold in
  non-plastic versions.
- Do not assume a precise resin/recycling code unless you know it reliably.
- Do not classify a random word, person's name, place name, or malformed input
  as an item.
- Be conservative: when in doubt, return UNCLEAR rather than guessing.

Advice rules for YES:
- Generate item-specific advice for reducing future use, safely reusing the item,
  and recycling/disposal.
- Keep each tip to 1–2 concise sentences.
- Recycling advice must acknowledge that local acceptance varies; do not claim a
  specific local facility or collection program.
- Never recommend unsafe food/drink reuse. Do not suggest reuse for food or drink
  when the material, condition, or original purpose makes that unsafe.
- Prefer practical actions a normal person can actually take.
- For NO or UNCLEAR, return empty strings for all three actions.
`;
}

function buildAdvicePrompt(item, plasticType, code) {
  return `
You are Eco Count's sustainability advice engine.

Eco Count has already determined that this item is plastic or likely plastic.

Item: "${item}"
Plastic type/material: "${plasticType || "Plastic"}"
Resin code: ${code ?? "unknown"}

Return ONLY JSON matching this schema:
{
  "reduce": "short practical advice",
  "reuse": "short practical advice",
  "recycle": "short practical advice"
}

Rules:
- Make the advice specific to the named item and material when possible.
- Give one concise, realistic tip for each of reduce, reuse, and recycle.
- Reduce should focus on avoiding or replacing future single-use plastic.
- Reuse must be safe and realistic. Never recommend food/drink reuse when the
  item is not clearly suitable, is damaged, has held chemicals, or hygiene is a concern.
- Recycle advice must not claim that every plastic code is accepted everywhere.
  Tell the user to check local municipal or recycler rules when relevant.
- Do not invent collection centers, brands, laws, or local programs.
- No URLs, citations, or web-search claims.
`;
}

export default async function handler(request, response) {
  const headers = corsHeaders(request);

  Object.entries(headers).forEach(([key, value]) => response.setHeader(key, value));

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "POST") {
    return json(response, { error: "Method not allowed." }, 405, headers);
  }

  if (!process.env.GEMINI_API_KEY) {
    return json(
      response,
      { error: "Gemini verification is not configured on the backend." },
      503,
      headers
    );
  }

  const origin = getOrigin(request);
  const allowedOrigins = getAllowedOrigins();

  if (origin && !allowedOrigins.includes("*") && !allowedOrigins.includes(origin)) {
    return json(response, { error: "Origin not allowed." }, 403, headers);
  }

  const contentLength = Number(getHeader(request, "content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json(response, { error: "Request body is too large." }, 413, headers);
  }

  let body = request.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(response, { error: "Invalid JSON request." }, 400, headers);
    }
  }

  if (!body || typeof body !== "object") {
    return json(response, { error: "Invalid JSON request." }, 400, headers);
  }

  try {
    const bodySize = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (bodySize > MAX_BODY_BYTES) {
      return json(response, { error: "Request body is too large." }, 413, headers);
    }
  } catch {
    return json(response, { error: "Invalid JSON request." }, 400, headers);
  }

  const mode = body?.mode === "advice" ? "advice" : "classify";
  const item = safeString(body?.item);

  if (!item) {
    return json(response, { error: "Item is required." }, 400, headers);
  }

  if (item.length > MAX_ITEM_LENGTH) {
    return json(
      response,
      { error: `Item must be ${MAX_ITEM_LENGTH} characters or fewer.` },
      400,
      headers
    );
  }

  const plasticType = safeString(body?.plasticType);
  const rawCode = body?.code;
  const code = rawCode === null || rawCode === undefined || rawCode === ""
    ? null
    : String(rawCode).trim().slice(0, 20);

  const limit = rateLimit(getClientIp(request));

  if (!limit.allowed) {
    return json(
      response,
      {
        error:
          "Gemini verification is temporarily limited to protect Eco Count's free quota."
      },
      429,
      {
        ...headers,
        "Retry-After": String(limit.retryAfter)
      }
    );
  }


  const bodyPayload = {
    contents: [
      {
        parts: [
          {
            text: mode === "advice"
              ? buildAdvicePrompt(item, plasticType, code)
              : buildClassifyPrompt(item)
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: mode === "advice"
        ? {
            type: "OBJECT",
            properties: {
              reduce: { type: "STRING" },
              reuse: { type: "STRING" },
              recycle: { type: "STRING" }
            },
            required: ["reduce", "reuse", "recycle"]
          }
        : {
            type: "OBJECT",
            properties: {
              verdict: {
                type: "STRING",
                enum: ["YES", "NO", "UNCLEAR"]
              },
              reason: {
                type: "STRING"
              },
              recognized_item: {
                type: "BOOLEAN"
              },
              actions: {
                type: "OBJECT",
                properties: {
                  reduce: { type: "STRING" },
                  reuse: { type: "STRING" },
                  recycle: { type: "STRING" }
                },
                required: ["reduce", "reuse", "recycle"]
              }
            },
            required: ["verdict", "reason", "recognized_item", "actions"]
          }
    }
  };

  try {
    const geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(bodyPayload)
    });

    const responseText = await geminiResponse.text();

    let geminiData = null;

    try {
      geminiData = JSON.parse(responseText);
    } catch {
      geminiData = null;
    }

    if (!geminiResponse.ok) {
      const code = geminiResponse.status;

      if (code === 429) {
        return json(
          response,
          {
            error:
              "Gemini's current free quota or rate limit has been reached. Try again later."
          },
          429,
          headers
        );
      }

      if (code === 400 || code === 401 || code === 403) {
        return json(
          response,
          {
            error:
              "Gemini rejected the verification request. Check the Gemini project, key, and Free Tier configuration."
          },
          502,
          headers
        );
      }

      return json(
        response,
        { error: "Gemini verification is temporarily unavailable." },
        503,
        headers
      );
    }

    const text = extractText(geminiData);

    if (!text) {
      return json(
        response,
        { error: "Gemini returned no classification." },
        502,
        headers
      );
    }

    let result;

    try {
      result = JSON.parse(text);
    } catch {
      return json(
        response,
        { error: "Gemini returned an invalid classification." },
        502,
        headers
      );
    }


    if (mode === "advice") {
      const actions = {
        reduce: safeString(result?.reduce),
        reuse: safeString(result?.reuse),
        recycle: safeString(result?.recycle)
      };

      if (!actions.reduce || !actions.reuse || !actions.recycle) {
        return json(
          response,
          { error: "Gemini returned incomplete sustainability advice." },
          502,
          headers
        );
      }

      return json(response, { actions }, 200, headers);
    }

    const verdict = result?.verdict;

    if (!["YES", "NO", "UNCLEAR"].includes(verdict)) {
      return json(
        response,
        { error: "Gemini returned an invalid verdict." },
        502,
        headers
      );
    }

    const actions = result?.actions && typeof result.actions === "object"
      ? {
          reduce: safeString(result.actions.reduce),
          reuse: safeString(result.actions.reuse),
          recycle: safeString(result.actions.recycle)
        }
      : { reduce: "", reuse: "", recycle: "" };

    return json(
      response,
      {
        verdict,
        reason: safeString(result.reason),
        recognized_item: Boolean(result.recognized_item),
        actions,
        sources: []
      },
      200,
      headers
    );

  } catch (error) {
    console.error("Eco Count verification error:", error);

    return json(
      response,
      { error: "Gemini verification is temporarily unavailable." },
      503,
      headers
    );
  }
}
