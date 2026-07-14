import type MarkdownIt from "markdown-it";
import {
  ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE,
  markdownItAssistantTranscriptRoles,
} from "../../../packages/markdown-core/src/assistant-transcript.js";

const ROLE_MARKER_OPEN = '<code class="assistant-transcript-role">';
const ROLE_MARKER_CLOSE = "</code>";

export function renderAssistantTranscriptRoleMarker(
  text: string,
  escapeHtml: (value: string) => string,
): string {
  return `${ROLE_MARKER_OPEN}${escapeHtml(text)}${ROLE_MARKER_CLOSE}`;
}

export function renderAssistantTranscriptRoleImageLabel(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
  escapeHtml: (value: string) => string,
): string {
  let rendered = "";
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    rendered += escapeHtml(text.slice(cursor, start));
    if (end > start) {
      rendered += renderAssistantTranscriptRoleMarker(text.slice(start, end), escapeHtml);
    }
    cursor = end;
  }
  return rendered + escapeHtml(text.slice(cursor));
}

export function installAssistantTranscriptRoleMarkdown(
  md: MarkdownIt,
  escapeHtml: (value: string) => string,
): void {
  md.use(markdownItAssistantTranscriptRoles);
  md.renderer.rules[ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE] = (tokens, index) => {
    const token = tokens[index];
    return token ? renderAssistantTranscriptRoleMarker(token.content, escapeHtml) : "";
  };
}
