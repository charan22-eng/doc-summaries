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

  // Helper to compute word count
  const countWords = (str: string): number => {
    const trimmed = str.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).filter(Boolean).length;
  };

  // Live character counter
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

  // Validate input text
  const validate = useCallback((): boolean => {
    const trimmed = inputText.trim();
    if (!trimmed) {
      setValidationError("Please enter some text to summarise.");
      return false;
    }
    if (trimmed.length < MIN_CHARS) {
      setValidationError(
        `Text is too short (${trimmed.length} chars). Minimum is ${MIN_CHARS} characters.`
      );
      return false;
    }
    if (trimmed.length > MAX_CHARS) {
      setValidationError(
        `Text is too long (${trimmed.length} chars). Maximum allowed is ${MAX_CHARS} characters.`
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

    // Abort any existing in-flight request
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

      // Stale response check: ignore if user started another request
      if (activeRequestIdRef.current !== currentRequestId) {
        return;
      }

      // Check if server returned an error JSON
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

      // Stream the response body chunk by chunk
      if (!response.body) {
        throw new Error("Response body is null");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      let receivedFirstChunk = false;

      while (true) {
        const { done, value } = await reader.read();

        // Guard against stale response
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

      // Flush final bytes if any
      const remaining = decoder.decode();
      if (remaining) {
        accumulatedText += remaining;
        setSummaryText(accumulatedText);
      }

      // Finalise completion & calculate statistics
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
      // Mid-stream network or server abort: preserve partial text
      if (accumulatedText.length > 0) {
        setStreamState("interrupted");
      } else {
        setApiError({
          code: "network_error",
          message: "Connection lost while generating summary. Please check your network and retry.",
        });
        setStreamState("error");
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
    }
  };

  // Stop button handler
  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  // Keyboard shortcut: Ctrl+Enter or Cmd+Enter
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSummarise();
    }
  };

  // Copy to clipboard
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

  // Try sample text
  const handleLoadSample = () => {
    setInputText(SAMPLE_TEXT);
    setValidationError(null);
    setApiError(null);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  // Clear input and state
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

  // Error message mapper
  const getErrorMessage = (error: ErrorState): string => {
    switch (error.code) {
      case "invalid_input":
        return error.message || "The input text is invalid. Please check and try again.";
      case "rate_limited":
        return error.message || "Too many requests. Please wait a moment before trying again.";
      case "payload_too_large":
        return "The document exceeds the maximum payload size (100 KB).";
      case "server_misconfigured":
        return "The AI engine is temporarily misconfigured. Please try again shortly or contact support.";
      case "upstream_failed":
        return "The AI service is temporarily unavailable. Please retry in a few moments.";
      case "timeout":
        return "The request timed out. Try choosing a shorter length or a smaller text section.";
      default:
        return error.message || "An unexpected error occurred while generating the summary.";
    }
  };

  const isStreamingOrLoading = streamState === "loading" || streamState === "streaming";

  return (
    <main className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950">
      {/* Header Bar */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-sm shadow-indigo-500/20">
              D
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight text-slate-900 dark:text-white">
                Digest
              </span>
              <span className="hidden sm:inline-block ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200/50 dark:border-indigo-800/40">
                AI Summariser
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span className="hidden md:inline-flex items-center gap-1.5 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              Gemini 2.0 Flash
            </span>
          </div>
        </div>
      </header>

      {/* Main Two-Panel Section */}
      <div className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full items-start">
          {/* LEFT PANEL: Source Input & Controls */}
          <section
            aria-label="Input Document"
            className="flex flex-col bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm p-5 sm:p-6"
          >
            <div className="flex items-center justify-between mb-3">
              <label
                htmlFor={textareaId}
                className="font-semibold text-sm text-slate-900 dark:text-slate-100 flex items-center gap-2"
              >
                Source Document
                <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                  (min {MIN_CHARS} chars)
                </span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleLoadSample}
                  disabled={isStreamingOrLoading}
                  className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors disabled:opacity-50 py-1 px-2 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                >
                  Try sample text
                </button>
                {inputText && (
                  <button
                    type="button"
                    onClick={handleClear}
                    disabled={isStreamingOrLoading}
                    className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors disabled:opacity-50 py-1 px-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Input Textarea */}
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
                placeholder="Paste or type an article, paper, report, or document to summarise..."
                rows={12}
                aria-describedby={validationError ? errorDescId : undefined}
                className={`w-full rounded-xl border bg-slate-50/50 dark:bg-slate-950/50 p-4 text-sm sm:text-base text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 resize-y transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500/20 ${
                  validationError || isTooLong
                    ? "border-red-500 dark:border-red-500 focus:border-red-500"
                    : "border-slate-200 dark:border-slate-800 focus:border-indigo-500 dark:focus:border-indigo-500"
                }`}
              />
            </div>

            {/* Inline Validation Error */}
            {validationError && (
              <p
                id={errorDescId}
                className="mt-2 text-xs font-medium text-red-600 dark:text-red-400 flex items-center gap-1.5 animate-fadeIn"
              >
                <svg
                  className="w-3.5 h-3.5 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                {validationError}
              </p>
            )}

            {/* Character & Word Counter */}
            <div className="mt-2.5 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>{countWords(inputText)} words</span>
              <span
                className={`font-mono transition-colors ${
                  isTooLong
                    ? "text-red-600 dark:text-red-400 font-bold"
                    : isTooShort
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              </span>
            </div>

            {/* Configuration Options */}
            <div className="mt-6 pt-5 border-t border-slate-200/80 dark:border-slate-800/80 space-y-4">
              {/* Length Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
                  Length
                </label>
                <div
                  role="radiogroup"
                  aria-label="Summary Length"
                  className="grid grid-cols-3 gap-2"
                >
                  {LENGTH_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={length === opt}
                      disabled={isStreamingOrLoading}
                      onClick={() => setLength(opt)}
                      className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-lg border transition-all text-center capitalize ${
                        length === opt
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 dark:bg-indigo-950/60 dark:border-indigo-500 dark:text-indigo-300 shadow-sm"
                          : "border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Format Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
                  Format
                </label>
                <div
                  role="radiogroup"
                  aria-label="Summary Format"
                  className="grid grid-cols-3 gap-2"
                >
                  {FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      role="radio"
                      aria-checked={format === opt}
                      disabled={isStreamingOrLoading}
                      onClick={() => setFormat(opt)}
                      className={`py-2 px-3 text-xs sm:text-sm font-medium rounded-lg border transition-all text-center capitalize ${
                        format === opt
                          ? "bg-indigo-50 border-indigo-500 text-indigo-700 dark:bg-indigo-950/60 dark:border-indigo-500 dark:text-indigo-300 shadow-sm"
                          : "border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-700"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="mt-6 pt-4 border-t border-slate-200/80 dark:border-slate-800/80 flex flex-col sm:flex-row items-center justify-between gap-3">
              <span className="text-xs text-slate-400 dark:text-slate-500 order-2 sm:order-1">
                Press <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-700 font-mono text-[10px]">Ctrl+Enter</kbd> to summarise
              </span>

              <div className="w-full sm:w-auto flex items-center gap-2 order-1 sm:order-2">
                {isStreamingOrLoading ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 hover:bg-red-100 dark:hover:bg-red-950/70 transition-colors"
                  >
                    <svg
                      className="w-4 h-4 fill-current"
                      viewBox="0 0 24 24"
                    >
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSummarise}
                    disabled={!inputText.trim() || isTooLong}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-indigo-500/20 transition-all focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                  >
                    Summarise
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* RIGHT PANEL: Output & Result */}
          <section
            role="region"
            aria-label="Summary Output"
            className="flex flex-col bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm p-5 sm:p-6 min-h-[460px] relative"
          >
            {/* Header: Title and Actions (Copy / Done feedback) */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-200/80 dark:border-slate-800/80">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-100">
                  Summary Result
                </h2>
                {streamState === "streaming" && (
                  <span className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400 font-medium">
                    <span className="w-2 h-2 rounded-full bg-indigo-600 animate-ping" />
                    Streaming...
                  </span>
                )}
              </div>

              {summaryText && (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors"
                  aria-label={copied ? "Copied to clipboard" : "Copy summary to clipboard"}
                >
                  {copied ? (
                    <>
                      <svg
                        className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      <span className="text-emerald-600 dark:text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                      <span>Copy</span>
                    </>
                  )}
                </button>
              )}
            </div>

            {/* Error Banner with Dismiss and Retry */}
            {apiError && (
              <div
                role="alert"
                className="mt-4 p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-900 dark:text-red-200 text-sm flex items-start justify-between gap-3 animate-fadeIn"
              >
                <div className="flex items-start gap-2.5">
                  <svg
                    className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <div>
                    <strong className="font-semibold block">Summarisation Error</strong>
                    <span className="text-xs text-red-700 dark:text-red-300">
                      {getErrorMessage(apiError)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleSummarise}
                    className="px-2.5 py-1 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => setApiError(null)}
                    aria-label="Dismiss error"
                    className="p-1 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 rounded"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* Interrupted Banner */}
            {streamState === "interrupted" && (
              <div
                role="status"
                className="mt-4 p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-200 text-xs sm:text-sm flex items-center justify-between gap-3 animate-fadeIn"
              >
                <div className="flex items-center gap-2">
                  <svg
                    className="w-4 h-4 text-amber-600 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <span>Generation interrupted. Showing partial summary.</span>
                </div>
                <button
                  type="button"
                  onClick={handleSummarise}
                  className="px-2.5 py-1 text-xs font-semibold rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors shrink-0"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Content Output Body */}
            <div
              aria-live="polite"
              className="flex-1 py-4 overflow-y-auto flex flex-col justify-start"
            >
              {/* State 1: Idle (Empty state) */}
              {streamState === "idle" && !summaryText && (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-slate-400 dark:text-slate-500 space-y-3 min-h-[280px]">
                  <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500">
                    <svg
                      className="w-6 h-6"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="font-medium text-slate-700 dark:text-slate-300 text-sm">
                      Your summary will appear here
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 max-w-xs mt-1">
                      Paste a document, select your length and format preferences, and click Summarise.
                    </p>
                  </div>
                </div>
              )}

              {/* State 2: Loading before first token */}
              {streamState === "loading" && (
                <div className="flex-1 flex flex-col justify-center items-center py-12 space-y-4">
                  <div className="flex items-center gap-3 text-indigo-600 dark:text-indigo-400">
                    <svg
                      className="animate-spin h-5 w-5"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    <span className="text-sm font-medium">Reading your text...</span>
                  </div>
                  {/* Subtle skeleton bars */}
                  <div className="w-full max-w-md space-y-2.5 opacity-60">
                    <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse w-3/4" />
                    <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse w-full" />
                    <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse w-5/6" />
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

            {/* Bottom Stats Line: words in, words out, % shorter */}
            {stats && (streamState === "done" || streamState === "interrupted") && (
              <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-slate-800/80 flex flex-wrap items-center justify-between text-xs text-slate-500 dark:text-slate-400 gap-2">
                <div className="flex items-center gap-3">
                  <span>
                    <strong className="font-semibold text-slate-700 dark:text-slate-300">
                      {stats.wordsIn.toLocaleString()}
                    </strong>{" "}
                    words in
                  </span>
                  <span>→</span>
                  <span>
                    <strong className="font-semibold text-slate-700 dark:text-slate-300">
                      {stats.wordsOut.toLocaleString()}
                    </strong>{" "}
                    words out
                  </span>
                </div>
                <div className="inline-flex items-center gap-1 font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 rounded">
                  {stats.reductionPercent}% shorter
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 py-4 text-center text-xs text-slate-400 dark:text-slate-500">
        Digest — Purpose-Built AI Summarisation Engine • Production Grade
      </footer>
    </main>
  );
}
