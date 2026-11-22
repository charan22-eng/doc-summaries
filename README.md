# Digest — AI Text Summariser

Digest is a purpose-built, production-quality AI text summarisation web application powered by Anthropic's Claude models. Designed as a dedicated document analysis tool (not a generic chat interface), it delivers instant, streaming executive summaries with fine-grained control over length and structure.

## Live Application
- **Live URL**: *(Configured upon production deployment)*
- **Repository**: [https://github.com/resma-digest/ai-summariser](https://github.com/resma-digest/ai-summariser)

## Architecture in 5 Lines
1. **Frontend**: Next.js 15 App Router client with responsive two-panel UI, dark mode, accessible ARIA live regions, and real-time word/character statistics.
2. **Streaming Protocol**: Plain client-side `fetch` consuming `ReadableStream` through `TextDecoder({ stream: true })` with `AbortController` cancellation.
3. **Server Gateway**: Next.js route handler (`app/api/summarise/route.ts`) on `nodejs` runtime with a 30s execution ceiling and early 100 KB payload checks.
4. **Resilience & Rate Limiting**: In-memory sliding-window IP rate limiting (10 req/min) returning 429 with `Retry-After` headers.
5. **AI Integration**: Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) utilized strictly server-side with stream priming to catch upstream provider errors prior to HTTP 200 emission.

## Environment Variables
The application requires the following environment variables (server-side only; never exposed with `NEXT_PUBLIC_`):

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `ANTHROPIC_API_KEY` | **Yes** (Prod) | *None* | Anthropic API key used to execute Claude models. |
| `ANTHROPIC_MODEL` | No | `claude-3-5-haiku-20241022` | Specific Anthropic model ID to invoke. |
| `USE_MOCK_LLM` | No | `false` | When set to `"true"`, enables simulated streaming for offline testing without an active API key. |

See `.env.example` for a ready-to-copy template.

## Local Setup & Development

### 1. Clone the repository
```bash
git clone https://github.com/resma-digest/ai-summariser.git
cd ai-summariser
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment
Create a local `.env.local` file:
```bash
cp .env.example .env.local
```
Add your Anthropic API key to `.env.local`:
```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### 4. Run development server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. Type checking & Production build
```bash
npm run typecheck
npm run build
npm start
```

## Known Limitations
1. **In-Memory Rate Limiting**: Per-IP rate limiting uses an in-memory sliding window. On multi-instance serverless deployments (such as Vercel), rate limiting is best-effort per edge container rather than globally synchronised across distributed nodes (a distributed store like Redis/Upstash would be required for global distributed enforcement).
2. **Text Window**: Enforces a strict minimum of 50 characters and maximum of 20,000 characters per document to maintain optimal latency and cost efficiency.
3. **Single Document Processing**: Designed for single-document ingestion rather than batch uploads or multi-file archives.
