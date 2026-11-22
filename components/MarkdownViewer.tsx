"use client";

import React, { useMemo } from "react";

interface MarkdownViewerProps {
  content: string;
  isStreaming?: boolean;
}

/**
 * Editorial Markdown renderer aligned with the Claude visual language:
 * warm serif headings, clean body type, terracotta accents, calm pacing.
 */
export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({ content, isStreaming }) => {
  const renderedElements = useMemo(() => {
    if (!content.trim()) return null;

    const lines = content.split("\n");
    const elements: React.ReactNode[] = [];
    let currentBulletGroup: string[] = [];

    const flushBulletGroup = (keyPrefix: string) => {
      if (currentBulletGroup.length > 0) {
        elements.push(
          <ul
            key={`${keyPrefix}-ul`}
            className="my-3 space-y-2.5 list-none pl-0 text-[var(--text)]"
          >
            {currentBulletGroup.map((item, idx) => (
              <li key={`${keyPrefix}-li-${idx}`} className="flex items-start gap-3 leading-relaxed text-[15px] sm:text-base">
                <span className="inline-block mt-2.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)] shrink-0 opacity-85" />
                <span className="flex-1">{renderFormattedText(item)}</span>
              </li>
            ))}
          </ul>
        );
        currentBulletGroup = [];
      }
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      // Detect bullet points: lines starting with "- " or "* "
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        currentBulletGroup.push(trimmed.slice(2));
      } else if (trimmed === "") {
        flushBulletGroup(`blank-${idx}`);
      } else {
        flushBulletGroup(`text-${idx}`);
        // Heading / Headline (e.g. **Key Takeaways**)
        if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4) {
          const headlineText = trimmed.slice(2, -2);
          elements.push(
            <h3
              key={`h-${idx}`}
              className="font-serif text-lg md:text-xl font-normal text-[var(--text)] mt-4 mb-2 first:mt-0 tracking-tight"
            >
              {headlineText}
            </h3>
          );
        } else {
          elements.push(
            <p
              key={`p-${idx}`}
              className="my-3 text-[var(--text)] leading-relaxed text-[15px] sm:text-base"
            >
              {renderFormattedText(trimmed)}
            </p>
          );
        }
      }
    });

    flushBulletGroup("final");
    return elements;
  }, [content]);

  return (
    <div className="prose-content w-full font-sans antialiased text-[var(--text)]">
      {renderedElements}
      {isStreaming && (
        <span
          className="inline-block w-1.5 h-4 ml-1.5 bg-[var(--accent)] animate-pulse align-middle rounded-xs"
          aria-hidden="true"
        />
      )}
    </div>
  );
};

/**
 * Parses inline bold tags `**text**` and renders them with semantic <strong> tags.
 */
function renderFormattedText(text: string): React.ReactNode {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      return (
        <strong key={index} className="font-medium text-[var(--text)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}
