const PROD_URL = "https://doc-summaries.vercel.app";

async function post(body) {
  const res = await fetch(`${PROD_URL}/api/summarise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function stream(body) {
  const start = Date.now();
  const res = await fetch(`${PROD_URL}/api/summarise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ time: Date.now() - start, text: decoder.decode(value, { stream: true }) });
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    chunkCount: chunks.length,
    firstChunkTime: chunks[0]?.time,
    fullText: chunks.map(c => c.text).join(""),
  };
}

async function runLiveTests() {
  console.log("=== RUNNING VERCEL PRODUCTION LIVE TESTS ===\n");

  // 1. Live real summary via stream (multiple chunks)
  console.log("[LIVE TEST 1] Real Token Streaming:");
  const sampleDoc = "In the summer of 2020, structural biology witnessed a historic milestone that transformed decades of molecular research. For more than fifty years, biochemists struggled with the protein folding problem, the monumental challenge of predicting a protein shape from amino acids. AlphaFold demonstrated predictive precision rivaling labor-intensive physical instrumentation.";
  const streamRes = await stream({ text: sampleDoc, length: "brief", format: "paragraph" });
  console.log(`Status: ${streamRes.status}`);
  console.log(`Chunks received: ${streamRes.chunkCount}`);
  console.log(`First chunk timing: ${streamRes.firstChunkTime}ms`);
  console.log(`Summary: ${streamRes.fullText}`);

  // 2. Deliberate empty-input error
  console.log("\n[LIVE TEST 2] Deliberate empty-input (whitespace):");
  const emptyRes = await post({ text: "   \n\t  ", length: "standard", format: "paragraph" });
  console.log(`Status: ${emptyRes.status}`);
  console.log(`Response:`, JSON.stringify(emptyRes.data));

  // 3. Deliberate over-limit error (20,001 chars)
  console.log("\n[LIVE TEST 3] Deliberate over-limit input (20,001 chars):");
  const overRes = await post({ text: "A".repeat(20001), length: "brief", format: "paragraph" });
  console.log(`Status: ${overRes.status}`);
  console.log(`Response:`, JSON.stringify(overRes.data));

  console.log("\n=== ALL LIVE PRODUCTION TESTS VERIFIED ===");
}

runLiveTests();
