"use client";

/**
 * Markdown renderer for chat message bubbles.
 *
 * Scope:
 * - GitHub-flavored markdown (tables, strikethrough, task lists, autolinks)
 *   via `remark-gfm`.
 * - Single newlines become `<br>` via `remark-breaks`, matching chat
 *   conventions (agents often compose multi-line text without double
 *   blank lines).
 * - Sanitized through `rehype-sanitize` with its default schema — this is
 *   the GitHub whitelist, which blocks `<script>`, `<iframe>`, `on*`
 *   handlers, `javascript:` URLs, and raw HTML injection. The transcript
 *   content is not trusted (it comes from the model), so sanitizing is
 *   mandatory.
 *
 * Styling:
 * - Inline styles live on per-element component overrides, not a global
 *   `prose` class. Rationale: the chat bubble is small, the default prose
 *   scale is too large, and code/inline-code need different backgrounds
 *   depending on whether the bubble is the user's (accent bg) or the
 *   assistant's (raised surface). A tone-keyed component map keeps both
 *   variants honest without forking the whole renderer.
 */

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export type MessageTone = "user" | "assistant";

interface MessageMarkdownProps {
  readonly text: string;
  readonly tone: MessageTone;
}

export function MessageMarkdown({ text, tone }: MessageMarkdownProps) {
  return (
    <div className="space-y-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        components={tone === "user" ? USER_COMPONENTS : ASSISTANT_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component maps — one per tone.
// ---------------------------------------------------------------------------
//
// These are the only surfaces that change between user and assistant bubbles.
// Text color is inherited from the bubble wrapper (set in Message.tsx), so
// paragraphs and headings don't override it. Code blocks, inline code, and
// links DO override because they need their own contrast inside a colored
// bubble.

function buildComponents(tone: MessageTone): Components {
  // User bubbles are accent-colored (high saturation). Code on top of that
  // needs a translucent overlay to stay readable; an absolute bg color would
  // clash. Assistant bubbles are neutral, so we can use a solid muted bg.
  const inlineCodeBg =
    tone === "user" ? "bg-black/15" : "bg-surface-muted";
  const blockCodeBg =
    tone === "user" ? "bg-black/20" : "bg-surface-muted";
  const linkClass =
    tone === "user"
      ? "underline decoration-accent-foreground/60 hover:decoration-accent-foreground"
      : "text-accent underline decoration-accent/60 hover:decoration-accent";

  return {
    // Paragraphs: let `space-y-2` from the wrapper handle vertical rhythm.
    // Inline `m-0` resets the browser default margin react-markdown inherits.
    p: ({ children }) => <p className="m-0 leading-relaxed">{children}</p>,

    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClass}
      >
        {children}
      </a>
    ),

    // react-markdown v9 no longer passes an `inline` flag; we detect inline
    // code by the absence of a `language-*` className. Block code is always
    // wrapped in a `<pre>` by react-markdown, so our `pre` override below is
    // the outer shell and `code` below is the inner text.
    code: ({ className, children }) => {
      const isBlock = typeof className === "string" && className.startsWith("language-");
      if (isBlock) {
        return (
          <code className={`font-mono text-[12px] ${className}`}>{children}</code>
        );
      }
      return (
        <code
          className={`${inlineCodeBg} rounded px-1 py-0.5 font-mono text-[0.85em]`}
        >
          {children}
        </code>
      );
    },

    pre: ({ children }) => (
      <pre
        className={`${blockCodeBg} rounded-md p-3 overflow-x-auto text-[12px] leading-snug my-1`}
      >
        {children}
      </pre>
    ),

    ul: ({ children }) => (
      <ul className="list-disc list-outside pl-5 space-y-1 m-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal list-outside pl-5 space-y-1 m-0">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,

    // Headings are scaled DOWN from browser defaults — a chat bubble isn't
    // a document, and the default `<h1>` is comically large inside one.
    h1: ({ children }) => (
      <h1 className="text-base font-semibold m-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-sm font-semibold m-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-sm font-semibold m-0">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-sm font-semibold m-0">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="text-sm font-semibold m-0">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="text-sm font-semibold m-0">{children}</h6>
    ),

    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border pl-3 italic m-0">
        {children}
      </blockquote>
    ),

    hr: () => <hr className="my-1 border-border" />,

    // Tables from GFM. Scrollable on overflow so long tables don't break
    // the bubble's max width.
    table: ({ children }) => (
      <div className="overflow-x-auto">
        <table className="text-[12px] border-collapse">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-border px-2 py-1 font-semibold text-left">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-border px-2 py-1">{children}</td>
    ),
  };
}

const USER_COMPONENTS: Components = buildComponents("user");
const ASSISTANT_COMPONENTS: Components = buildComponents("assistant");
