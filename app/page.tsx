"use client";

import React, { useState, useRef, useEffect, useCallback, useId } from "react";
import {
  MIN_CHARS,
  MAX_CHARS,
  LENGTH_OPTIONS,
  FORMAT_OPTIONS,
  SummaryLength,
  SummaryFormat,
} from "@/lib/limits";
import { SAMPLE_TEXT } from "@/lib/sampleText";
import { MarkdownViewer } from "@/components/MarkdownViewer";

type StreamState = "idle" | "loading" | "streaming" | "done" | "error" | "interrupted";

interface ErrorState {
  code: string;
  message: string;
  field?: string;
}

interface SummaryStats {
  wordsIn: number;
  wordsOut: number;
  reductionPercent: number;
}

export default function SummariserPage() {
  const [inputText, setInputText] = useState("");
  const [length, setLength] = useState<SummaryLength>("standard");
  const [format, setFormat] = useState<SummaryFormat>("takeaways");

  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [summaryText, setSummaryText] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ErrorState | null>(null);
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState<SummaryStats | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const textareaId = useId();
  const errorDescId = useId();

  // Word count calculation
  const countWords = (str: string): number => {
    const trimmed = str.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
  };

  // Character counter state
  const charCount = inputText.length;
  const isTooShort = charCount > 0 && charCount < MIN_CHARS;
  const isTooLong = charCount > MAX_CHARS;

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Validation
  const validate = useCallback((): boolean => {
    const trimmed = inputText.trim();
    if (!trimmed) {
      setValidationError("Please paste or type text to summarise.");
      return false;
    }
    if (trimmed.length < MIN_CHARS) {
      setValidationError(
        `Document is too short (${trimmed.length} characters). Minimum required is ${MIN_CHARS} characters.`
      );
      return false;
    }
    if (trimmed.length > MAX_CHARS) {
      setValidationError(
        `Document exceeds maximum limit of ${MAX_CHARS.toLocaleString()} characters (received ${trimmed.length.toLocaleString()}).`
      );
      return false;
    }
    setValidationError(null);
    return true;
  }, [inputText]);

  // Main submission handler
  const handleSummarise = async () => {
    if (streamState === "loading" || streamState === "streaming") return;

    if (!validate()) {
      if (textareaRef.current) textareaRef.current.focus();
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const currentRequestId = Date.now();
    activeRequestIdRef.current = currentRequestId;

    setApiError(null);
    setValidationError(null);
    setSummaryText("");
    setStats(null);
    setCopied(false);
    setStreamState("loading");

    const inputWordCount = countWords(inputText);
    let accumulatedText = "";

    try {
      const response = await fetch("/api/summarise", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: inputText,
          length,
          format,
        }),
        signal: abortController.signal,
      });

      if (activeRequestIdRef.current !== currentRequestId) {
        return;
      }

      if (!response.ok) {
        let errJson: any;
        try {
          errJson = await response.json();
        } catch {
          errJson = {
            error: {
              code: "upstream_failed",
              message: `Server returned status ${response.status}`,
            },
          };
        }

        const errData = errJson.error || {
          code: "unknown",
          message: "An unexpected error occurred. Please try again.",
        };

        setApiError(errData);
        setStreamState("error");
        return;
      }

      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let receivedFirstChunk = false;

      while (true) {
        const { done, value } = await reader.read();

        if (activeRequestIdRef.current !== currentRequestId) {
          reader.cancel();
          return;
        }

        if (done) break;

        if (value) {
          if (!receivedFirstChunk) {
            receivedFirstChunk = true;
            setStreamState("streaming");
          }
          const chunk = decoder.decode(value, { stream: true });
          accumulatedText += chunk;
          setSummaryText(accumulatedText);
        }
      }

      const remaining = decoder.decode();
      if (remaining) {
        accumulatedText += remaining;
        setSummaryText(accumulatedText);
      }

      const outputWordCount = countWords(accumulatedText);
      const reduction =
        inputWordCount > 0
          ? Math.max(0, Math.round(((inputWordCount - outputWordCount) / inputWordCount) * 100))
          : 0;

      setStats({
        wordsIn: inputWordCount,
        wordsOut: outputWordCount,
        reductionPercent: reduction,
      });
      setStreamState("done");
    } catch (err: any) {
      if (activeRequestIdRef.current !== currentRequestId) return;

      if (err.name === "AbortError") {
        if (accumulatedText.length > 0) {
          setStreamState("interrupted");
        } else {
          setStreamState("idle");
        }
        return;
      }

      console.error("Client summarisation streaming error:", err);
      if (accumulatedText.length > 0) {
        setStreamState("interrupted");
      } else {
        setApiError({
          code: "network_error",
          message: "Connection interrupted. Please verify your network and retry.",
        });
        setStreamState("error");
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSummarise();
    }
  };

  const handleCopy = async () => {
    if (!summaryText) return;
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  };

  const handleLoadSample = () => {
    setInputText(SAMPLE_TEXT);
    setValidationError(null);
    setApiError(null);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const handleClear = () => {
    handleStop();
    setInputText("");
    setSummaryText("");
    setValidationError(null);
    setApiError(null);
    setStats(null);
    setStreamState("idle");
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const getErrorMessage = (error: ErrorState): string => {
    switch (error.code) {
      case "invalid_input":
        return error.message || "The input text is invalid. Please check and try again.";
      case "rate_limited":
        return error.message || "Too many requests. Please pause a moment before retrying.";
      case "payload_too_large":
        return "The document exceeds the maximum payload size (100 KB).";
      case "server_misconfigured":
        return "The summarisation service encountered a credential configuration error.";
      case "upstream_failed":
        return "The AI service is temporarily unavailable. Please try again in a few moments.";
      case "timeout":
        return "The request timed out. Try a shorter length setting or smaller text section.";
      default:
        return error.message || "An unexpected error occurred while generating the summary.";
    }
  };

  const isStreamingOrLoading = streamState === "loading" || streamState === "streaming";

  return (
    <main className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)] selection:bg-[var(--accent-soft)] selection:text-[var(--accent-hover)] font-sans">
      {/* Top Navigation Bar: Clean, warm, hairline border */}
      <header className="border-b border-[var(--border)] bg-[var(--bg)]/90 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-[var(--accent)] text-[var(--on-accent)] flex items-center justify-center font-serif text-lg font-normal shadow-xs">
              D
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-serif text-xl font-normal tracking-tight text-[var(--text)]">
                Digest
              </span>
              <span className="hidden sm:inline-block text-xs text-[var(--text-secondary)] font-normal">
                Text summariser
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-sans px-3 py-1 rounded-pill bg-[var(--accent-soft)] text-[var(--accent-hover)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
              Gemini Flash Lite
            </span>
          </div>
        </div>
      </header>

      {/* Main Two-Panel Layout */}
      <div className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full items-start">
          {/* LEFT PANEL: Source Input */}
          <section
            aria-label="Source document"
            className="flex flex-col bg-[var(--surface)] rounded-lg border border-[var(--border)] shadow-xs p-6 sm:p-7"
          >
            <div className="flex items-center justify-between mb-3.5">
              <label
                htmlFor={textareaId}
                className="font-serif text-lg font-normal text-[var(--text)] tracking-tight"
              >
                Source document
              </label>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleLoadSample}
                  disabled={isStreamingOrLoading}
                  className="text-xs font-sans text-[var(--accent-hover)] hover:text-[var(--accent)] transition-colors disabled:opacity-40 py-1 px-2.5 rounded-md hover:bg-[var(--accent-soft)]/50"
                >
                  Try sample text
                </button>
                {inputText && (
                  <button
                    type="button"
                    onClick={handleClear}
                    disabled={isStreamingOrLoading}
                    className="text-xs font-sans text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors disabled:opacity-40 py-1 px-2 rounded-md hover:bg-[var(--bg-sunken)]"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Input Textarea Container */}
            <div className="relative">
              <textarea
                id={textareaId}
                ref={textareaRef}
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Paste an article, research paper, report, or draft to summarise..."
                rows={12}
                aria-describedby={validationError ? errorDescId : undefined}
                className={`w-full rounded-md border bg-[var(--bg-subtle)] p-4 text-[15px] sm:text-base text-[var(--text)] placeholder:text-[var(--text-muted)] resize-y transition-all focus:outline-none focus:bg-[var(--surface)] ${
                  validationError || isTooLong
                    ? "border-[var(--danger)] focus:border-[var(--danger)]"
                    : "border-[var(--border-strong)] focus:border-[var(--accent-hover)] focus:ring-2 focus:ring-[var(--accent-soft)]"
                }`}
              />
            </div>

            {/* Inline Validation Notice */}
            {validationError && (
              <p
                id={errorDescId}
                className="mt-2.5 text-xs text-[var(--danger)] flex items-center gap-1.5"
              >
                <svg
                  className="w-3.5 h-3.5 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <circle cx="12" cy="12" r="9" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                {validationError}
              </p>
            )}

            {/* Counter Row */}
            <div className="mt-3 flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
              <span>{countWords(inputText)} words</span>
              <span
                className={`transition-colors font-mono ${
                  isTooLong
                    ? "text-[var(--danger)] font-semibold"
                    : isTooShort
                    ? "text-[var(--warning)]"
                    : "text-[var(--text-muted)]"
                }`}
              >
                {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              </span>
            </div>

            {/* Segmented Options */}
            <div className="mt-6 pt-5 border-t border-[var(--border)] space-y-4">
              {/* Length Selector */}
              <div>
                <label className="block text-xs font-sans text-[var(--text-secondary)] mb-2">
                  Summary length
                </label>
                <div
                  role="radiogroup"
                  aria-label="Summary length"
                  className="p-1 bg-[var(--bg-subtle)] rounded-md border border-[var(--border)] grid grid-cols-3 gap-1"
                >
                  {LENGTH_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={length === opt}
                      disabled={isStreamingOrLoading}
                      onClick={() => setLength(opt)}
                      className={`py-1.5 px-3 text-xs sm:text-sm font-sans rounded-sm transition-all text-center capitalize ${
                        length === opt
                          ? "bg-[var(--surface)] text-[var(--text)] shadow-xs border border-[var(--border)] font-medium"
                          : "text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-sunken)]/60"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Format Selector */}
              <div>
                <label className="block text-xs font-sans text-[var(--text-secondary)] mb-2">
                  Output format
                </label>
                <div
                  role="radiogroup"
                  aria-label="Output format"
                  className="p-1 bg-[var(--bg-subtle)] rounded-md border border-[var(--border)] grid grid-cols-3 gap-1"
                >
                  {FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={format === opt}
                      disabled={isStreamingOrLoading}
                      onClick={() => setFormat(opt)}
                      className={`py-1.5 px-3 text-xs sm:text-sm font-sans rounded-sm transition-all text-center capitalize ${
                        format === opt
                          ? "bg-[var(--surface)] text-[var(--text)] shadow-xs border border-[var(--border)] font-medium"
                          : "text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--bg-sunken)]/60"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Bottom Actions Row */}
            <div className="mt-6 pt-4 border-t border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-3">
              <span className="text-xs text-[var(--text-muted)] order-2 sm:order-1 font-sans">
                Press <kbd className="px-1.5 py-0.5 rounded bg-[var(--bg-sunken)] text-[var(--text-secondary)] border border-[var(--border-strong)] font-mono text-[10px]">Ctrl+Enter</kbd> to summarise
              </span>

              <div className="w-full sm:w-auto flex items-center gap-2 order-1 sm:order-2">
                {isStreamingOrLoading ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2 rounded-md font-sans font-medium text-sm text-[var(--accent-hover)] bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)]/80 border border-[var(--accent-hover)]/30 transition-all active:scale-[0.98]"
                  >
                    <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                    Stop generating
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSummarise}
                    disabled={!inputText.trim() || isTooLong}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-2 rounded-md font-sans font-medium text-sm text-[var(--on-accent)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-45 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-xs"
                  >
                    Summarise
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* RIGHT PANEL: Output Result */}
          <section
            role="region"
            aria-label="Summary output"
            className="flex flex-col bg-[var(--surface)] rounded-lg border border-[var(--border)] shadow-xs p-6 sm:p-7 min-h-[500px] relative"
          >
            {/* Header: Title and Copy Button */}
            <div className="flex items-center justify-between pb-4 border-b border-[var(--border)]">
              <div className="flex items-center gap-2.5">
                <h2 className="font-serif text-lg font-normal text-[var(--text)] tracking-tight">
                  Summary
                </h2>
                {streamState === "streaming" && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-[var(--accent-hover)] font-sans">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-ping" />
                    Streaming
                  </span>
                )}
              </div>

              {summaryText && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 text-xs font-sans font-medium px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--bg-subtle)] text-[var(--text)] transition-all shadow-xs"
                  aria-label={copied ? "Copied summary to clipboard" : "Copy summary to clipboard"}
                >
                  {copied ? (
                    <>
                      <svg className="w-3.5 h-3.5 text-[var(--success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-[var(--success)]">Copied</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <rect x="8" y="8" width="12" height="12" rx="2" />
                        <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
                      </svg>
                      <span>Copy</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Error Notification */}
            {apiError && (
              <div
                role="alert"
                className="mt-4 p-4 rounded-md bg-[var(--bg-sunken)] border border-[var(--danger)]/30 text-[var(--text)] text-sm flex items-start justify-between gap-3"
              >
                <div className="flex items-start gap-2.5">
                  <span className="text-[var(--danger)] font-medium mt-0.5">•</span>
                  <div>
                    <span className="text-xs text-[var(--text)] font-sans leading-relaxed">
                      {getErrorMessage(apiError)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleSummarise}
                    className="px-2.5 py-1 text-xs font-sans font-medium rounded-md bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => setApiError(null)}
                    aria-label="Dismiss message"
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--text)] rounded"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* Interrupted Banner */}
            {streamState === "interrupted" && (
              <div
                role="status"
                className="mt-4 p-3 rounded-md bg-[var(--bg-sunken)] border border-[var(--warning)]/30 text-xs sm:text-sm flex items-center justify-between gap-3 font-sans"
              >
                <div className="flex items-center gap-2 text-[var(--text-secondary)]">
                  <span className="text-[var(--warning)] font-bold">•</span>
                  <span>Generation stopped. Showing partial summary.</span>
                </div>
                <button
                  type="button"
                  onClick={handleSummarise}
                  className="px-2.5 py-1 text-xs font-sans font-medium rounded-md bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)] transition-colors shrink-0"
                >
                  Resume
                </button>
              </div>
            )}

            {/* Content Output Body */}
            <div
              aria-live="polite"
              className="flex-1 py-4 overflow-y-auto flex flex-col justify-start"
            >
              {/* State 1: Idle (Quiet empty state) */}
              {streamState === "idle" && !summaryText && (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-[var(--text-muted)] space-y-3 min-h-[300px]">
                  <div className="w-10 h-10 rounded-md bg-[var(--bg-sunken)] flex items-center justify-center text-[var(--text-muted)]">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-serif text-base font-normal text-[var(--text)]">
                      Your summary will appear here
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] max-w-xs mt-1.5 font-sans leading-relaxed">
                      Paste a document, select your preferred length and format, and click Summarise.
                    </p>
                  </div>
                </div>
              )}

              {/* State 2: Loading before first token */}
              {streamState === "loading" && (
                <div className="flex-1 flex flex-col justify-center items-center py-14 space-y-4 font-sans">
                  <div className="flex items-center gap-2.5 text-[var(--accent-hover)]">
                    <svg
                      className="animate-spin h-4 w-4"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span className="font-serif text-base font-normal text-[var(--text-secondary)]">
                      Reading document...
                    </span>
                  </div>
                  <div className="w-full max-w-sm space-y-2 opacity-50">
                    <div className="h-3.5 bg-[var(--bg-sunken)] rounded-sm animate-pulse w-3/4" />
                    <div className="h-3.5 bg-[var(--bg-sunken)] rounded-sm animate-pulse w-full" />
                    <div className="h-3.5 bg-[var(--bg-sunken)] rounded-sm animate-pulse w-5/6" />
                  </div>
                </div>
              )}

              {/* State 3 & 4: Streaming / Done / Interrupted */}
              {(streamState === "streaming" ||
                streamState === "done" ||
                streamState === "interrupted" ||
                (streamState === "error" && summaryText)) && (
                <div className="w-full">
                  <MarkdownViewer
                    content={summaryText}
                    isStreaming={streamState === "streaming"}
                  />
                </div>
              )}
            </div>

            {/* Bottom Stats Line: words in, words out, % reduction */}
            {stats && (streamState === "done" || streamState === "interrupted") && (
              <div className="mt-4 pt-3 border-t border-[var(--border)] flex flex-wrap items-center justify-between text-xs text-[var(--text-secondary)] gap-2 font-sans">
                <div className="flex items-center gap-2">
                  <span>
                    <strong className="font-medium text-[var(--text)]">
                      {stats.wordsIn.toLocaleString()}
                    </strong>{" "}
                    words in
                  </span>
                  <span>→</span>
                  <span>
                    <strong className="font-medium text-[var(--text)]">
                      {stats.wordsOut.toLocaleString()}
                    </strong>{" "}
                    words out
                  </span>
                </div>
                <div className="inline-flex items-center gap-1 font-sans font-medium text-[var(--accent-hover)] bg-[var(--accent-soft)] px-2.5 py-0.5 rounded-pill">
                  {stats.reductionPercent}% reduction
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-[var(--border)] py-4 text-center text-xs text-[var(--text-muted)] font-sans">
        Digest — quiet, purpose-built document summarisation
      </footer>
    </main>
  );
}
