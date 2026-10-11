// Markdown written by agents (plans, reviews, reports). It is untrusted: no
// images (a remote one would report back when the page loads), and links only
// to http(s), opened in a new tab without a referrer.

import Markdown, { type Components } from "react-markdown";

/** An http(s) URL as given, or "" for any other scheme (javascript:, data:, file:, relative paths). */
export function safeHref(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : "";
  } catch {
    return "";
  }
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function AgentMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      urlTransform={safeHref}
      disallowedElements={["img"]}
      unwrapDisallowed={false}
      skipHtml
      components={components}
    >
      {children}
    </Markdown>
  );
}
