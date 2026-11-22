const BASE_URL = "http://localhost:3001";

async function post(path, body, headers = {}) {
  const url = `${BASE_URL}${path}`;
  const isString = typeof body === "string";
  const payload = isString ? body : JSON.stringify(body);
  const reqHeaders = {
    "Content-Type": "application/json",
    ...headers,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: reqHeaders,
    body: payload,
  });

  const contentType = response.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    data,
  };
}

async function stream(path, body, headers = {}) {
  const url = `${BASE_URL}${path}`;
  const start = Date.now();
  const chunks = [];

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const time = Date.now() - start;
    const text = decoder.decode(value, { stream: true });
    chunks.push({ time, text });
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    chunkCount: chunks.length,
    chunks,
    fullText: chunks.map((c) => c.text).join(""),
    durationMs: Date.now() - start,
  };
}

async function get(path, headers = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, { method: "GET", headers });
  let data;
  try {
    data = await response.json();
  } catch {
    data = await response.text();
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    data,
  };
}

async function runAll() {
  console.log("=== RUNNING DIGEST TEST MATRIX ===\n");
  const results = [];

  // 1. GET request (expect 405)
  try {
    const res = await get("/api/summarise", { "x-forwarded-for": "10.0.0.1" });
    console.log(`[TEST 1] GET /api/summarise: status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "GET request", passed: res.status === 405, res });
  } catch (e) {
    console.error("[TEST 1 FAILED]", e);
  }

  // 2. Empty Body (expect 400)
  try {
    const res = await post("/api/summarise", "", { "x-forwarded-for": "10.0.0.2" });
    console.log(`\n[TEST 2] Empty Body: status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "Empty Body", passed: res.status === 400, res });
  } catch (e) {
    console.error("[TEST 2 FAILED]", e);
  }

  // 3. Malformed JSON (expect 400)
  try {
    const res = await post("/api/summarise", "{ text: broken json", { "x-forwarded-for": "10.0.0.3" });
    console.log(`\n[TEST 3] Malformed JSON: status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "Malformed JSON", passed: res.status === 400, res });
  } catch (e) {
    console.error("[TEST 3 FAILED]", e);
  }

  // 4. Whitespace Text (expect 400)
  try {
    const res = await post(
      "/api/summarise",
      {
        text: "     \n\t   ",
        length: "standard",
        format: "paragraph",
      },
      { "x-forwarded-for": "10.0.0.4" }
    );
    console.log(`\n[TEST 4] Whitespace text: status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "Whitespace Text", passed: res.status === 400, res });
  } catch (e) {
    console.error("[TEST 4 FAILED]", e);
  }

  // 5. 49 Chars (under limit, expect 400)
  try {
    const shortText = "A".repeat(49);
    const res = await post(
      "/api/summarise",
      {
        text: shortText,
        length: "standard",
        format: "paragraph",
      },
      { "x-forwarded-for": "10.0.0.5" }
    );
    console.log(`\n[TEST 5] 49 Chars (too short): status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "49 Chars (under limit)", passed: res.status === 400, res });
  } catch (e) {
    console.error("[TEST 5 FAILED]", e);
  }

  // 6. 20,001 Chars (over limit, expect 400)
  try {
    const longText = "A".repeat(20001);
    const res = await post(
      "/api/summarise",
      {
        text: longText,
        length: "standard",
        format: "paragraph",
      },
      { "x-forwarded-for": "10.0.0.6" }
    );
    console.log(`\n[TEST 6] 20,001 Chars (too long): status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "20,001 Chars (over limit)", passed: res.status === 400, res });
  } catch (e) {
    console.error("[TEST 6 FAILED]", e);
  }

  // 7. Invalid enum for length/format (expect 400)
  try {
    const res = await post(
      "/api/summarise",
      {
        text: "This is a valid text that easily exceeds the fifty characters minimum requirement for summarisation.",
        length: "ultra-long",
        format: "paragraph",
      },
      { "x-forwarded-for": "10.0.0.7" }
    );
    console.log(`\n[TEST 7] Invalid enum: status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "Invalid Enum", passed: res.status === 400, res });
  } catch (e) {
    console.error("[TEST 7 FAILED]", e);
  }

  // 8. Payload > 100 KB Content-Length (expect 413)
  try {
    const hugePayload = JSON.stringify({
      text: "A".repeat(105000),
      length: "standard",
      format: "paragraph",
    });
    const res = await post("/api/summarise", hugePayload, {
      "Content-Length": String(Buffer.byteLength(hugePayload)),
      "x-forwarded-for": "10.0.0.8",
    });
    console.log(`\n[TEST 8] 413 Payload Too Large (>100KB): status ${res.status}`);
    console.log("Response:", JSON.stringify(res.data));
    results.push({ name: "Payload Too Large (413)", passed: res.status === 413, res });
  } catch (e) {
    console.error("[TEST 8 FAILED]", e);
  }

  // 9. Streaming Proof (expect 200, chunked streaming, multiple chunks)
  try {
    const validText =
      "In the summer of 2020, structural biology witnessed a historic milestone that transformed decades of molecular research. " +
      "For more than fifty years, biochemists struggled with the protein folding problem, the monumental challenge of predicting a protein's 3D shape.";
    const streamRes = await stream(
      "/api/summarise",
      {
        text: validText,
        length: "standard",
        format: "takeaways",
      },
      { "x-forwarded-for": "10.0.0.9" }
    );
    console.log(`\n[TEST 9] Streaming Proof: status ${streamRes.status}`);
    console.log(`Chunks received: ${streamRes.chunkCount}`);
    console.log(`Duration: ${streamRes.durationMs}ms`);
    console.log(`Sample chunks:`, streamRes.chunks.slice(0, 3));
    console.log(`Output text preview:`, streamRes.fullText.slice(0, 120) + "...");
    results.push({
      name: "Streaming Proof (200 chunked)",
      passed: streamRes.status === 200 && streamRes.chunkCount > 1,
      streamRes,
    });
  } catch (e) {
    console.error("[TEST 9 FAILED]", e);
  }

  // 10. Rate Limiting Test (10 req/min per IP, expect 429 on 11th request)
  try {
    console.log("\n[TEST 10] Testing Rate Limiting (10 req/min limit on 10.0.0.10)...");
    const validText = "This is a valid test document that is definitely longer than fifty characters for rate limit testing.";
    let hit429 = false;
    let retryAfterHeader = null;
    let rateLimitBody = null;
    for (let i = 1; i <= 12; i++) {
      const res = await post(
        "/api/summarise",
        {
          text: validText,
          length: "brief",
          format: "paragraph",
        },
        { "x-forwarded-for": "10.0.0.10" }
      );
      if (res.status === 429) {
        hit429 = true;
        retryAfterHeader = res.headers["retry-after"];
        rateLimitBody = res.data;
        console.log(`Request #${i} resulted in 429:`);
        console.log(`Retry-After Header: ${retryAfterHeader}`);
        console.log(`Response Body:`, JSON.stringify(rateLimitBody));
        break;
      }
    }
    results.push({
      name: "Rate Limiting (429 with Retry-After)",
      passed: hit429 && !!retryAfterHeader,
      res: { status: 429, retryAfter: retryAfterHeader, data: rateLimitBody },
    });
  } catch (e) {
    console.error("[TEST 10 FAILED]", e);
  }

  // Summary
  console.log("\n=== TEST RESULTS SUMMARY ===");
  for (const r of results) {
    console.log(`${r.passed ? "✅ PASS" : "❌ FAIL"}: ${r.name}`);
  }
}

runAll();
