import { markdownToIR, type MarkdownIR } from "../../../packages/markdown-core/src/ir.js";

export type StripMarkdownOptions = {
  /** Mark parsed assistant transcript-role headers in transports without rich text. */
  assistantTranscriptRoleHeaders?: boolean;
  /** Prefix inserted before each marked transcript-role header. */
  assistantTranscriptRolePrefix?: string;
  /** Link projection after formatting is removed. Default: label-and-url. */
  linkStyle?: "label" | "label-and-url";
};

type PlainTextInsertion = {
  position: number;
  text: string;
  order: number;
};

function collectPlainTextInsertions(
  ir: MarkdownIR,
  options: StripMarkdownOptions,
): PlainTextInsertion[] {
  const insertions: PlainTextInsertion[] = [];
  const rolePrefix =
    options.assistantTranscriptRoleHeaders === true
      ? (options.assistantTranscriptRolePrefix ?? "[assistant-authored transcript] ")
      : "";
  if (rolePrefix) {
    for (const annotation of ir.annotations ?? []) {
      if (annotation.type === "assistant_transcript_role") {
        insertions.push({ position: annotation.start, text: rolePrefix, order: 0 });
      }
    }
  }
  const linkStyle = options.linkStyle ?? "label-and-url";
  if (linkStyle === "label-and-url") {
    for (const link of ir.links) {
      const href = link.href.trim();
      const label = ir.text.slice(link.start, link.end).trim();
      const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
      if (href && label && label !== href && label !== comparableHref) {
        insertions.push({ position: link.end, text: ` (${href})`, order: 1 });
      }
    }
  }
  return insertions;
}

function applyPlainTextInsertions(text: string, insertions: PlainTextInsertion[]): string {
  if (insertions.length === 0) {
    return text;
  }
  const sorted = insertions.toSorted((a, b) => a.position - b.position || a.order - b.order);
  let output = "";
  let cursor = 0;
  for (const insertion of sorted) {
    const position = Math.max(cursor, Math.min(insertion.position, text.length));
    output += text.slice(cursor, position);
    output += insertion.text;
    cursor = position;
  }
  return output + text.slice(cursor);
}

/** Parse Markdown once, then project its visible content to readable plain text. */
export function stripMarkdown(text: string, options: StripMarkdownOptions = {}): string {
  const ir = markdownToIR(text, {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders,
    autolink: false,
    blockquotePrefix: "",
    headingStyle: "none",
    horizontalRuleText: "",
    linkify: false,
    preserveSourceBlockSpacing: true,
    tableMode: "bullets",
  });
  return applyPlainTextInsertions(ir.text, collectPlainTextInsertions(ir, options)).trim();
}
