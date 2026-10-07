const MODEL = "gemini-3.5-flash-lite";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_ITEM_LENGTH = 120;
const MAX_BODY_BYTES = 5000;

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
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
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
    return {
      allowed: false,
      retryAfter: 60
    };
  }

  if (bucket.dayCount >= 40) {
    return {
      allowed: false,
      retryAfter: 24 * 60 * 60
    };
  }

  bucket.minuteCount += 1;
  bucket.dayCount += 1;

  return {
    allowed: true
  };
}

function extractText(payload) {
  const parts =
    payload?.candidates?.[0]?.content?.parts || [];

  return parts
    .filter(part => typeof part?.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();
}

function safeString(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}

function buildClassifyPrompt(item) {
  return `
You are the classification engine for Eco Count.

The user entered:
"${item}"

Determine whether this item can be plastic.

Return ONLY JSON matching this schema:

{
  "verdict": "YES" | "NO" | "UNCLEAR",
  "reason": "short explanation",
  "recognized_item": true | false
}

Rules:

- YES when the named item can reasonably be made from plastic.
- NO when the item clearly cannot be plastic.
- UNCLEAR when the item is ambiguous, unknown, or there is not enough information.
- Do not invent a specific resin code.
- Do not use web search.
- Base the answer on general knowledge.
`;
}

function buildAdvicePrompt(item, plasticType, code) {
  return `
Eco Count has determined that this item is plastic or likely plastic.

Item:
"${item}"

Plastic type/material:
"${plasticType || "Plastic"}"

Resin code:
${code ?? "unknown"}

Give concise, practical advice for:

1. Reduce
2. Reuse
3. Recycle

Return ONLY JSON:

{
  "reduce": "short practical advice",
  "reuse": "short practical advice",
  "recycle": "short practical advice"
}

Rules:

- Make the advice specific to the item when possible.
- Reduce should explain how to avoid or reduce future use.
- Reuse must be safe and realistic.
- Do not recommend food or drink reuse when the item is unsuitable, damaged,
  contaminated, has contained chemicals, or hygiene is a concern.
- Recycling rules vary by location, so do not claim that every plastic type
  is accepted everywhere.
- Tell the user to check local municipal/recycler rules when appropriate.
- Do not invent recycling centres, laws, brands, or collection programs.
- No URLs or citations.
`;
}

export default async function handler(request, response) {
  const headers = corsHeaders(request);

  Object.entries(headers).forEach(([key, value]) => {
    response.setHeader(key, value);
  });

  if (request.method === "OPTIONS") {
    return response.status(204).end();
  }

  if (request.method !== "POST") {
    return json(
      response,
      { error: "Method not allowed." },
      405,
      headers
    );
  }

  if (!process.env.GEMINI_API_KEY) {
    return json(
      response,
      {
        error:
          "Gemini verification is not configured on the backend."
      },
      503,
      headers
    );
  }

  const origin = getOrigin(request);
  const allowedOrigins = getAllowedOrigins();

  if (
    origin &&
    !allowedOrigins.includes("*") &&
    !allowedOrigins.includes(origin)
  ) {
    return json(
      response,
      { error: "Origin not allowed." },
      403,
      headers
    );
  }

  const contentLength =
    Number(getHeader(request, "content-length") || 0);

  if (contentLength > MAX_BODY_BYTES) {
    return json(
      response,
      { error: "Request body is too large." },
      413,
      headers
    );
  }

  let body = request.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return json(
        response,
        { error: "Invalid JSON request." },
        400,
        headers
      );
    }
  }

  if (!body || typeof body !== "object") {
    return json(
      response,
      { error: "Invalid JSON request." },
      400,
      headers
    );
  }

  try {
    const bodySize =
      Buffer.byteLength(JSON.stringify(body), "utf8");

    if (bodySize > MAX_BODY_BYTES) {
      return json(
        response,
        { error: "Request body is too large." },
        413,
        headers
      );
    }
  } catch {
    return json(
      response,
      { error: "Invalid JSON request." },
      400,
      headers
    );
  }

  const mode =
    body?.mode === "advice"
      ? "advice"
      : "classify";

  const item = safeString(body?.item);

  if (!item) {
    return json(
      response,
      { error: "Item is required." },
      400,
      headers
    );
  }

  if (item.length > MAX_ITEM_LENGTH) {
    return json(
      response,
      {
        error:
          `Item must be ${MAX_ITEM_LENGTH} characters or fewer.`
      },
      400,
      headers
    );
  }

  const plasticType =
    safeString(body?.plasticType);

  const rawCode = body?.code;

  const code =
    rawCode === null ||
    rawCode === undefined ||
    rawCode === ""
      ? null
      : String(rawCode)
          .trim()
          .slice(0, 20);

  const limit =
    rateLimit(getClientIp(request));

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
        "Retry-After":
          String(limit.retryAfter)
      }
    );
  }

  const bodyPayload = {
    contents: [
      {
        parts: [
          {
            text:
              mode === "advice"
                ? buildAdvicePrompt(
                    item,
                    plasticType,
                    code
                  )
                : buildClassifyPrompt(item)
          }
        ]
      }
    ],

    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",

      responseSchema:
        mode === "advice"
          ? {
              type: "OBJECT",
              properties: {
                reduce: {
                  type: "STRING"
                },
                reuse: {
                  type: "STRING"
                },
                recycle: {
                  type: "STRING"
                }
              },
              required: [
                "reduce",
                "reuse",
                "recycle"
              ]
            }

          : {
              type: "OBJECT",
              properties: {
                verdict: {
                  type: "STRING",
                  enum: [
                    "YES",
                    "NO",
                    "UNCLEAR"
                  ]
                },

                reason: {
                  type: "STRING"
                },

                recognized_item: {
                  type: "BOOLEAN"
                }
              },

              required: [
                "verdict",
                "reason",
                "recognized_item"
              ]
            }
    }
  };

  try {
    const geminiResponse =
      await fetch(GEMINI_URL, {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-goog-api-key":
            process.env.GEMINI_API_KEY
        },

        body:
          JSON.stringify(bodyPayload)
      });

    const responseText =
      await geminiResponse.text();

    let geminiData = null;

    try {
      geminiData =
        JSON.parse(responseText);
    } catch {
      geminiData = null;
    }

    if (!geminiResponse.ok) {
      const status =
        geminiResponse.status;

      if (status === 429) {
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

      if (
        status === 400 ||
        status === 401 ||
        status === 403
      ) {
        console.error(
          "Gemini API error:",
          responseText
        );

        return json(
          response,
          {
            error:
              "Gemini rejected the verification request."
          },
          502,
          headers
        );
      }

      console.error(
        "Gemini API error:",
        responseText
      );

      return json(
        response,
        {
          error:
            "Gemini verification is temporarily unavailable."
        },
        503,
        headers
      );
    }

    const text =
      extractText(geminiData);

    if (!text) {
      return json(
        response,
        {
          error:
            "Gemini returned no classification."
        },
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
        {
          error:
            "Gemini returned invalid JSON."
        },
        502,
        headers
      );
    }

    // NEW: advice request
    if (mode === "advice") {
      const actions = {
        reduce:
          safeString(result?.reduce),

        reuse:
          safeString(result?.reuse),

        recycle:
          safeString(result?.recycle)
      };

      if (
        !actions.reduce ||
        !actions.reuse ||
        !actions.recycle
      ) {
        return json(
          response,
          {
            error:
              "Gemini returned incomplete sustainability advice."
          },
          502,
          headers
        );
      }

      return json(
        response,
        { actions },
        200,
        headers
      );
    }

    // ORIGINAL CLASSIFICATION FLOW
    const verdict =
      result?.verdict;

    if (
      ![
        "YES",
        "NO",
        "UNCLEAR"
      ].includes(verdict)
    ) {
      return json(
        response,
        {
          error:
            "Gemini returned an invalid verdict."
        },
        502,
        headers
      );
    }

    return json(
      response,
      {
        verdict,

        reason:
          safeString(result?.reason),

        recognized_item:
          Boolean(
            result?.recognized_item
          ),

        sources: []
      },
      200,
      headers
    );

  } catch (error) {
    console.error(
      "Eco Count verification error:",
      error
    );

    return json(
      response,
      {
        error:
          "Gemini verification is temporarily unavailable."
      },
      503,
      headers
    );
  }
}
