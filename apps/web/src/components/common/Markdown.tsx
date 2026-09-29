import { Fragment, type ReactNode } from 'react';

/**
 * The small amount of markdown a task description actually uses.
 *
 * Written out rather than pulled in, for two reasons. A markdown library is a
 * large dependency for headings, lists and bold; and every one of them
 * ultimately hands you HTML, which would mean dangerouslySetInnerHTML and a
 * sanitiser to go with it. This produces React elements, so a description can
 * never inject markup however it is written.
 *
 * Supported: # headings, - and 1. lists, > quotes, ``` fenced code, `code`,
 * **bold**, *italic*, ~~strikethrough~~ and [links](https://example.com).
 */

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{renderBlocks(text)}</div>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] as string;

    // Fenced code: taken literally to the closing fence, or to the end.
    if (line.startsWith('```')) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] as string).startsWith('```')) {
        body.push(lines[index] as string);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={key++} className="my-2 overflow-x-auto rounded-lg bg-surface-muted p-3 text-xs">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const content = renderInline(heading[2] as string);
      const sizes = ['text-lg', 'text-base', 'text-sm', 'text-sm'];
      blocks.push(
        <p key={key++} className={'mt-3 mb-1 font-semibold ' + (sizes[level - 1] ?? 'text-sm')}>
          {content}
        </p>,
      );
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] as string)) {
        body.push((lines[index] as string).replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="my-2 border-l-2 border-border-subtle pl-3 text-ink-muted"
        >
          {renderInline(body.join(' '))}
        </blockquote>,
      );
      continue;
    }

    const bulleted = /^\s*[-*+]\s+/.test(line);
    const numbered = /^\s*\d+[.)]\s+/.test(line);

    if (bulleted || numbered) {
      const items: string[] = [];
      const matches = (candidate: string) =>
        bulleted ? /^\s*[-*+]\s+/.test(candidate) : /^\s*\d+[.)]\s+/.test(candidate);

      while (index < lines.length && matches(lines[index] as string)) {
        items.push(
          (lines[index] as string).replace(bulleted ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/, ''),
        );
        index += 1;
      }

      const rendered = items.map((item, at) => <li key={at}>{renderInline(item)}</li>);
      blocks.push(
        bulleted ? (
          <ul key={key++} className="my-2 list-disc space-y-0.5 pl-5">
            {rendered}
          </ul>
        ) : (
          <ol key={key++} className="my-2 list-decimal space-y-0.5 pl-5">
            {rendered}
          </ol>
        ),
      );
      continue;
    }

    // An ordinary paragraph: consecutive lines belong together.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] as string).trim() !== '' &&
      !/^(#{1,4})\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*>|^```/.test(lines[index] as string)
    ) {
      paragraph.push(lines[index] as string);
      index += 1;
    }
    blocks.push(
      <p key={key++} className="my-2 leading-relaxed">
        {renderInline(paragraph.join(' '))}
      </p>,
    );
  }

  return blocks;
}

/**
 * Inline markers, innermost first.
 *
 * Code spans are taken out before anything else, so `**not bold**` inside
 * backticks stays as it was typed.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(~~[^~]+~~)|(\[[^\]]+\]\([^)]+\))/;

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      parts.push(<Fragment key={key++}>{rest}</Fragment>);
      break;
    }

    if (match.index > 0) parts.push(<Fragment key={key++}>{rest.slice(0, match.index)}</Fragment>);

    const token = match[0];

    if (token.startsWith('`')) {
      parts.push(
        <code key={key++} className="rounded bg-surface-muted px-1 py-0.5 text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      parts.push(
        <strong key={key++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('~~')) {
      parts.push(<s key={key++}>{token.slice(2, -2)}</s>);
    } else if (token.startsWith('*')) {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const href = link?.[2] ?? '';
      parts.push(<SafeLink key={key++} href={href} label={label} />);
    }

    rest = rest.slice(match.index + token.length);
  }

  return parts;
}

/**
 * Only http and https are followed.
 *
 * A javascript: or data: URL in a task description would be a script somebody
 * else typed, so anything that is not plainly a web address is shown as text.
 */
function SafeLink({ href, label }: { href: string; label: string }) {
  const safe = /^https?:\/\//i.test(href);
  if (!safe) return <span>{label}</span>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline underline-offset-2"
    >
      {label}
    </a>
  );
}
