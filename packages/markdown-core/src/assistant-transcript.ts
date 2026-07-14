// Assistant transcript annotations are produced after Markdown inline parsing and text joining.
import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export const ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE = "assistant_transcript_role_text";

export type AssistantTranscriptRole = "assistant" | "developer" | "system" | "user";

export type AssistantTranscriptRoleHeaderKind =
  | "angle_role_header"
  | "role_timestamp_bracket"
  | "timestamp_role_colon";

export type AssistantTranscriptRoleHeaderSpan = {
  start: number;
  end: number;
  kind: AssistantTranscriptRoleHeaderKind;
  role: AssistantTranscriptRole;
};

export type AssistantTranscriptRoleTokenMeta = {
  assistantTranscriptRoleHeader: Omit<AssistantTranscriptRoleHeaderSpan, "start" | "end">;
};

export type AssistantTranscriptRoleImageMeta = {
  assistantTranscriptRoleImage: {
    /** Parsed visible label; annotation offsets are relative to this text. */
    text: string;
    spans: AssistantTranscriptRoleHeaderSpan[];
  };
};

type TextRange = {
  start: number;
  end: number;
};

const TRANSCRIPT_ROLES: readonly AssistantTranscriptRole[] = [
  "assistant",
  "developer",
  "system",
  "user",
];

function isHorizontalWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isLineTrailingWhitespace(char: string | undefined): boolean {
  return isHorizontalWhitespace(char) || char === "\r";
}

function skipHorizontalWhitespace(text: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && isHorizontalWhitespace(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function matchRoleAt(
  text: string,
  start: number,
  end: number,
): { role: AssistantTranscriptRole; end: number } | null {
  for (const role of TRANSCRIPT_ROLES) {
    const roleEnd = start + role.length;
    if (roleEnd <= end && text.slice(start, roleEnd).toLowerCase() === role) {
      return { role, end: roleEnd };
    }
  }
  return null;
}

function findDelimitedEnd(params: {
  text: string;
  contentStart: number;
  lineEnd: number;
  close: "]" | ">";
  minContentLength: number;
  maxContentLength: number;
}): number | null {
  const searchEnd = Math.min(params.lineEnd, params.contentStart + params.maxContentLength + 1);
  let closeAt = -1;
  for (let index = params.contentStart; index < searchEnd; index += 1) {
    const char = params.text[index];
    // Paired backticks are parsed as code and excluded earlier. An unmatched
    // delimiter leaves a header that target renderers cannot wrap consistently.
    if (char === "`") {
      return null;
    }
    if (char === params.close) {
      closeAt = index;
      break;
    }
  }
  if (closeAt === -1) {
    return null;
  }
  const contentLength = closeAt - params.contentStart;
  if (contentLength < params.minContentLength || contentLength > params.maxContentLength) {
    return null;
  }
  return closeAt + 1;
}

function isHeaderBoundary(char: string | undefined): boolean {
  return char === undefined || isLineTrailingWhitespace(char) || char === ":" || char === "：";
}

function matchRoleTimestampHeader(
  text: string,
  start: number,
  lineEnd: number,
): AssistantTranscriptRoleHeaderSpan | null {
  const role = matchRoleAt(text, start, lineEnd);
  if (!role) {
    return null;
  }
  const bracketStart = skipHorizontalWhitespace(text, role.end, lineEnd);
  if (text[bracketStart] !== "[") {
    return null;
  }
  const headerEnd = findDelimitedEnd({
    text,
    contentStart: bracketStart + 1,
    lineEnd,
    close: "]",
    minContentLength: 1,
    maxContentLength: 160,
  });
  if (!headerEnd || !isHeaderBoundary(text[headerEnd])) {
    return null;
  }
  return {
    start,
    end: headerEnd,
    kind: "role_timestamp_bracket",
    role: role.role,
  };
}

function matchTimestampRoleHeader(
  text: string,
  start: number,
  lineEnd: number,
): AssistantTranscriptRoleHeaderSpan | null {
  if (text[start] !== "[") {
    return null;
  }
  const bracketEnd = findDelimitedEnd({
    text,
    contentStart: start + 1,
    lineEnd,
    close: "]",
    minContentLength: 4,
    maxContentLength: 160,
  });
  if (!bracketEnd) {
    return null;
  }
  const roleStart = skipHorizontalWhitespace(text, bracketEnd, lineEnd);
  const role = matchRoleAt(text, roleStart, lineEnd);
  if (!role) {
    return null;
  }
  const colonAt = skipHorizontalWhitespace(text, role.end, lineEnd);
  if (text[colonAt] !== ":" && text[colonAt] !== "：") {
    return null;
  }
  const headerEnd = colonAt + 1;
  return {
    start,
    end: headerEnd,
    kind: "timestamp_role_colon",
    role: role.role,
  };
}

function matchAngleRoleHeader(
  text: string,
  start: number,
  lineEnd: number,
): AssistantTranscriptRoleHeaderSpan | null {
  if (text[start] !== "<") {
    return null;
  }
  const roleStart = skipHorizontalWhitespace(text, start + 1, lineEnd);
  const role = matchRoleAt(text, roleStart, lineEnd);
  const roleBoundary = role ? text[role.end] : undefined;
  if (!role || (roleBoundary !== ">" && !isHorizontalWhitespace(roleBoundary))) {
    return null;
  }
  const headerEnd = findDelimitedEnd({
    text,
    contentStart: role.end,
    lineEnd,
    close: ">",
    minContentLength: 0,
    maxContentLength: 160,
  });
  if (!headerEnd || !isHeaderBoundary(text[headerEnd])) {
    return null;
  }
  return {
    start,
    end: headerEnd,
    kind: "angle_role_header",
    role: role.role,
  };
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && left.end > right.start;
}

/** Finds supported transcript-role headers in parser-visible text. */
export function findAssistantTranscriptRoleHeaderSpans(
  text: string,
  excludedRanges: readonly TextRange[] = [],
): AssistantTranscriptRoleHeaderSpan[] {
  const spans: AssistantTranscriptRoleHeaderSpan[] = [];
  const sortedExcludedRanges = [...excludedRanges].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let excludedRangeIndex = 0;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newlineAt = text.indexOf("\n", lineStart);
    const lineEnd = newlineAt === -1 ? text.length : newlineAt;
    const contentStart = skipHorizontalWhitespace(text, lineStart, lineEnd);
    const span =
      matchTimestampRoleHeader(text, contentStart, lineEnd) ??
      matchAngleRoleHeader(text, contentStart, lineEnd) ??
      matchRoleTimestampHeader(text, contentStart, lineEnd);
    if (span) {
      for (;;) {
        const excludedRange = sortedExcludedRanges[excludedRangeIndex];
        if (!excludedRange || excludedRange.end > span.start) {
          break;
        }
        excludedRangeIndex += 1;
      }
      const excludedRange = sortedExcludedRanges[excludedRangeIndex];
      if (!excludedRange || !rangesOverlap(span, excludedRange)) {
        spans.push(span);
      }
    }
    if (newlineAt === -1) {
      break;
    }
    lineStart = newlineAt + 1;
  }
  return spans;
}

type VisibleTokenProjection = {
  text: string;
  excludedRanges: TextRange[];
};

function visibleTokenProjection(token: Token): VisibleTokenProjection | null {
  if (token.type === "softbreak" || token.type === "hardbreak") {
    return { text: "\n", excludedRanges: [] };
  }
  if (token.type === "text" || token.type === "html_inline") {
    return { text: token.content, excludedRanges: [] };
  }
  if (token.type === "code_inline") {
    return { text: token.content, excludedRanges: [{ start: 0, end: token.content.length }] };
  }
  if (token.type === "image") {
    return token.children && token.children.length > 0
      ? visibleTokensProjection(token.children)
      : { text: token.content, excludedRanges: [] };
  }
  return null;
}

function visibleTokensProjection(tokens: readonly Token[]): VisibleTokenProjection {
  let text = "";
  const excludedRanges: TextRange[] = [];
  for (const token of tokens) {
    const projection = visibleTokenProjection(token);
    if (!projection) {
      continue;
    }
    const offset = text.length;
    text += projection.text;
    for (const range of projection.excludedRanges) {
      excludedRanges.push({ start: offset + range.start, end: offset + range.end });
    }
  }
  return { text, excludedRanges };
}

function cloneToken(
  TokenType: typeof Token,
  source: Token,
  content: string,
  type: string = source.type,
): Token {
  const token = new TokenType(
    type,
    type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE ? "" : source.tag,
    0,
  );
  Object.assign(token, source);
  token.type = type;
  token.content = content;
  token.children = null;
  return token;
}

function annotatedToken(
  TokenType: typeof Token,
  source: Token,
  content: string,
  span: AssistantTranscriptRoleHeaderSpan,
): Token {
  const token = cloneToken(TokenType, source, content, ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE);
  token.meta = {
    ...(source.meta && typeof source.meta === "object" ? source.meta : {}),
    assistantTranscriptRoleHeader: {
      kind: span.kind,
      role: span.role,
    },
  } satisfies AssistantTranscriptRoleTokenMeta;
  return token;
}

function splitVisibleToken(params: {
  TokenType: typeof Token;
  token: Token;
  visibleStart: number;
  spanStartIndex: number;
  spans: readonly AssistantTranscriptRoleHeaderSpan[];
}): Token[] {
  const { token, visibleStart } = params;
  const visibleEnd = visibleStart + token.content.length;
  const firstSpan = params.spans[params.spanStartIndex];
  if (!firstSpan || firstSpan.start >= visibleEnd) {
    return [token];
  }

  const result: Token[] = [];
  let localCursor = 0;
  for (let spanIndex = params.spanStartIndex; spanIndex < params.spans.length; spanIndex += 1) {
    const span = params.spans[spanIndex];
    if (!span || span.start >= visibleEnd) {
      break;
    }
    if (span.end <= visibleStart) {
      continue;
    }
    const overlapStart = Math.max(span.start, visibleStart) - visibleStart;
    const overlapEnd = Math.min(span.end, visibleEnd) - visibleStart;
    if (overlapStart > localCursor) {
      result.push(
        cloneToken(params.TokenType, token, token.content.slice(localCursor, overlapStart)),
      );
    }
    if (overlapEnd > overlapStart) {
      result.push(
        annotatedToken(
          params.TokenType,
          token,
          token.content.slice(overlapStart, overlapEnd),
          span,
        ),
      );
    }
    localCursor = overlapEnd;
  }
  if (localCursor < token.content.length) {
    result.push(cloneToken(params.TokenType, token, token.content.slice(localCursor)));
  }
  return result;
}

function annotateInlineChildren(TokenType: typeof Token, children: Token[]): Token[] {
  const projection = visibleTokensProjection(children);
  const spans = findAssistantTranscriptRoleHeaderSpans(projection.text, projection.excludedRanges);
  if (spans.length === 0) {
    return children;
  }

  const result: Token[] = [];
  let visibleCursor = 0;
  let spanCursor = 0;
  for (const token of children) {
    const tokenProjection = visibleTokenProjection(token);
    if (!tokenProjection) {
      result.push(token);
      continue;
    }
    const content = tokenProjection.text;
    for (;;) {
      const span = spans[spanCursor];
      if (!span || span.end > visibleCursor) {
        break;
      }
      spanCursor += 1;
    }
    if (token.type === "text" || token.type === "html_inline") {
      result.push(
        ...splitVisibleToken({
          TokenType,
          token,
          visibleStart: visibleCursor,
          spanStartIndex: spanCursor,
          spans,
        }),
      );
    } else if (token.type === "image") {
      const visibleEnd = visibleCursor + content.length;
      const imageSpans: AssistantTranscriptRoleHeaderSpan[] = [];
      for (let spanIndex = spanCursor; spanIndex < spans.length; spanIndex += 1) {
        const span = spans[spanIndex];
        if (!span || span.start >= visibleEnd) {
          break;
        }
        if (span.end <= visibleCursor) {
          continue;
        }
        imageSpans.push({
          ...span,
          start: Math.max(span.start, visibleCursor) - visibleCursor,
          end: Math.min(span.end, visibleEnd) - visibleCursor,
        });
      }
      if (imageSpans.length > 0) {
        token.meta = {
          ...(token.meta && typeof token.meta === "object" ? token.meta : {}),
          assistantTranscriptRoleImage: { text: content, spans: imageSpans },
        } satisfies AssistantTranscriptRoleImageMeta;
      }
      result.push(token);
    } else {
      result.push(token);
    }
    visibleCursor += content.length;
  }
  return removeLinksContainingAssistantTranscriptRoles(result);
}

function removeLinksContainingAssistantTranscriptRoles(tokens: Token[]): Token[] {
  const openLinks: Array<{ token: Token; containsRole: boolean }> = [];
  const suppressedLinks = new Set<Token>();
  for (const token of tokens) {
    if (token.type === "link_open") {
      openLinks.push({ token, containsRole: false });
      continue;
    }
    const imageMeta = (token.meta as AssistantTranscriptRoleImageMeta | undefined)
      ?.assistantTranscriptRoleImage;
    if (token.type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE || imageMeta?.spans.length) {
      for (const link of openLinks) {
        link.containsRole = true;
      }
      continue;
    }
    if (token.type !== "link_close") {
      continue;
    }
    const openLink = openLinks.pop();
    if (!openLink?.containsRole) {
      continue;
    }
    suppressedLinks.add(openLink.token);
    suppressedLinks.add(token);
  }

  const result: Token[] = [];
  for (const token of tokens) {
    if (suppressedLinks.has(token)) {
      continue;
    }
    const previous = result.at(-1);
    if (
      previous?.type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE &&
      token.type === ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE
    ) {
      previous.content += token.content;
      continue;
    }
    result.push(token);
  }
  return result;
}

function annotateHtmlBlock(TokenType: typeof Token, token: Token): Token[] {
  const spans = findAssistantTranscriptRoleHeaderSpans(token.content);
  if (spans.length === 0) {
    return [token];
  }
  return splitVisibleToken({ TokenType, token, visibleStart: 0, spanStartIndex: 0, spans });
}

/** Adds semantic transcript-role tokens to assistant-authored Markdown only. */
export function markdownItAssistantTranscriptRoles(md: MarkdownIt): void {
  md.core.ruler.after("text_join", "assistant_transcript_roles", (state) => {
    if (state.env?.assistantTranscriptRoleHeaders !== true) {
      return;
    }
    const tokens: Token[] = [];
    for (const token of state.tokens) {
      if (token.type === "inline" && token.children) {
        token.children = annotateInlineChildren(state.Token, token.children);
        tokens.push(token);
        continue;
      }
      if (token.type === "html_block") {
        tokens.push(...annotateHtmlBlock(state.Token, token));
        continue;
      }
      tokens.push(token);
    }
    state.tokens = tokens;
  });
}
