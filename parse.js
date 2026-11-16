// A fast, dependency-free Markdown renderer whose parse() returns exactly the
// HTML that marked 18.1.3 renders with its default options (GFM on, breaks
// off, pedantic off, async off). Written from the CommonMark 0.31.2 and GFM
// 0.29 specifications plus marked's observable behaviour on those examples.
//
// Structure: parse() normalises line endings, splits the input into lines,
// runs a line based block parser (containers: block quotes, lists, list
// items; leaves: paragraphs, headings, code, HTML blocks, tables), collects
// link reference definitions, then renders each block, parsing inline
// markup (code spans, emphasis, links, autolinks, entities, escapes) with a
// delimiter stack. Nothing is cached between parse() calls.

const AMP = 38, LT = 60, GT = 62, QUOT = 34, APOS = 39, HASH = 35, SLASH = 47;
const BACKSLASH = 92, BACKTICK = 96, STAR = 42, UNDER = 95, TILDE = 126;
const LBRACK = 91, RBRACK = 93, BANG = 33, SPACE = 32, TAB = 9, NL = 10;

// ASCII punctuation, per CommonMark: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const PUNCT_RE = /^[\p{P}\p{S}]$/u;
const WS_RE = /^\s$/;
// Is the single character string ch Unicode whitespace?
function isWsCh(ch) {
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    (c > 127 && WS_RE.test(ch));
}
// Is the single character string ch Unicode punctuation?
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(ch);
}

// Decode a numeric character reference body (without the leading "&#" and
// trailing ";"). Decimal bodies hold at most 7 digits, hexadecimal at most
// 6; anything longer is not a reference. Returns the replacement string,
// or null when the body is not a valid numeric reference.
function decodeNumeric(body) {
  let v = 0;
  if (body.length === 0) return null;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) { // x or X
    if (body.length === 1 || body.length > 7) return null;
    for (let i = 1; i < body.length; i++) {
      const c = body.charCodeAt(i);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      if (d < 0) return null;
      v = v * 16 + d;
    }
  } else {
    if (body.length > 7) return null;
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c < 48 || c > 57) return null;
      v = v * 10 + (c - 48);
    }
  }
  if (v === 0 || (v >= 0xD800 && v <= 0xDFFF) || v > 0x10FFFF) return '\uFFFD';
  return String.fromCodePoint(v);
}

// Escape one character that is special in HTML text or in an attribute.
function escChar(c) {
  switch (c) {
    case 38: return '&amp;';
    case 60: return '&lt;';
    case 62: return '&gt;';
    case 34: return '&quot;';
    case 39: return '&#39;';
    default: return String.fromCharCode(c);
  }
}

// Escape a slice of text for HTML output. A "&" that begins a named entity
// (&name;) passes through unchanged, and a numeric reference (&#123; or
// &#x1f;) is decoded to its character (which is then escaped if special).
// Every other "&", "<", ">", '"' and "'" is escaped. This matches marked:
// named entities are never decoded, numeric ones are.
function escText(s, a, b) {
  let out = '';
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      // Try an entity: &...;
      let j = i + 1;
      if (j < b && s.charCodeAt(j) === HASH) {
        j++;
        const start = j;
        while (j < b) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70) || d === 120 || d === 88) j++;
          else break;
        }
        if (j > start && j < b && s.charCodeAt(j) === 59) {
          const dec = decodeNumeric(s.slice(start, j));
          if (dec !== null) {
            for (let k = 0; k < dec.length; k++) {
              const dc = dec.charCodeAt(k);
              out += (dc === 38 || dc === 60 || dc === 62 || dc === 34 || dc === 39) ? escChar(dc) : dec[k];
            }
            i = j + 1;
            continue;
          }
        }
        out += '&amp;';
        i++;
        continue;
      }
      // Named entity: &[A-Za-z][A-Za-z0-9]*;
      if (j < b) {
        const c0 = s.charCodeAt(j);
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          j++;
          while (j < b) {
            const d = s.charCodeAt(j);
            if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j++;
            else break;
          }
          if (j < b && s.charCodeAt(j) === 59) {
            out += s.slice(i, j + 1);
            i = j + 1;
            continue;
          }
        }
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    // Fast path: copy a run of plain characters.
    let j = i + 1;
    while (j < b) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Escape for code spans and code blocks: every special character is escaped,
// entities are not recognised (code content is literal).
function escRaw(s, a, b) {
  let out = '';
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      out += escChar(c);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < b) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Turn backslash escapes and numeric character references in a link
// destination or title into their characters. Named entities pass through
// unchanged. Backslash before an ASCII punctuation character drops the
// backslash; before anything else the backslash stays.
function unescape(s) {
  if (s.indexOf('\\') < 0 && s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === BACKSLASH && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === 38) {
      let j = i + 1;
      if (j < n && s.charCodeAt(j) === HASH) {
        j++;
        const start = j;
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70) || d === 120 || d === 88) j++;
          else break;
        }
        if (j > start && j < n && s.charCodeAt(j) === 59) {
          const dec = decodeNumeric(s.slice(start, j));
          if (dec !== null) { out += dec; i = j + 1; continue; }
        }
      }
      out += '&';
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === BACKSLASH || d === 38) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// marked's cleanUrl: percent-encode a URL, then un-escape %25 back to %.
// Returns null when the URL cannot be encoded (lone surrogates).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalise a link reference label: trim, collapse every run of whitespace
// (spaces, tabs, newlines) to one space, and case-fold.
function normalizeLabel(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  // trim leading whitespace
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  let last = n;
  while (last > i) {
    const c = s.charCodeAt(last - 1);
    if (c === 32 || c === 9 || c === 10 || c === 13) last--;
    else break;
  }
  let pendingSpace = false;
  while (i < last) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      pendingSpace = true;
      i++;
      continue;
    }
    if (pendingSpace && out.length > 0) out += ' ';
    pendingSpace = false;
    out += s[i];
    i++;
  }
  // Unicode case folding: ß/ẞ fold to "ss", final sigma ς to σ.
  return out.toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss').replace(/ς/g, 'σ');
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
//
// The scanner walks the text once and builds a node list. Delimiter runs
// (*, _, ~~) are left as nodes and resolved afterwards by processEmphasis,
// which implements the CommonMark delimiter stack: closers look back for the
// nearest opener of the same character, skipping openers the odd-match rule
// forbids, and use two characters for strong (or a del pair) when both sides
// have at least two, else one for emphasis.
//
// Node kinds:
//   0 text (already escaped HTML), 1 code span, 2 hard break, 3 raw HTML,
//   4 delimiter run, 5 link or image (finished HTML), 6 autolink (finished
//   HTML). A delimiter node carries: ch, n (remaining length), canOpen,
//   canClose, openTags (newest first), closeTags (oldest first).

function isLinkChar(c) {
  return c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 11 && c !== 12 && c !== 0;
}

// Find the index of the `]` matching the `[` at `open` in s, skipping code
// spans and backslash escapes. Returns -1 when there is none.
function findMatchingBracket(s, open) {
  const n = s.length;
  let depth = 1;
  let i = open + 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === BACKSLASH && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { i += 2; continue; }
    if (c === BACKTICK) {
      let j = i;
      while (j < n && s.charCodeAt(j) === BACKTICK) j++;
      // A code span in a link label is `+ ... `+ with independent run
      // lengths (marked's label regex does not require equal runs): the
      // span ends at the next backtick run of any length. But backticks
      // sitting right before the closing bracket are label text, not a
      // span opener (marked's ``+(?=\]) alternative) -- and only a run
      // of two or more; a single backtick there cannot close a span, so
      // the label cannot be completed and there is no link here. This
      // check must come first: scanning for a closing run would cross
      // the bracket and swallow the following text.
      if (j < n && s.charCodeAt(j) === RBRACK) {
        if (j - i >= 2) { i = j; continue; }
        return -1;
      }
      let k = j;
      let found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === BACKTICK) { found = k; break; }
        k++;
      }
      if (found < 0) return -1;
      let m = found;
      while (m < n && s.charCodeAt(m) === BACKTICK) m++;
      i = m;
      continue;
    }
    if (c === LBRACK) { depth++; i++; continue; }
    if (c === RBRACK) {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    // A "<" that starts an autolink or an HTML tag consumes everything
    // up to its ">", so a "]" inside it is not the link's closing
    // bracket (e.g. [foo <bar attr="](baz)"> has no link at all).
    if (c === LT) {
      const auto = matchAutolink(s, i);
      if (auto) { i = auto.end; continue; }
      const htmlEnd = matchInlineHtml(s, i);
      if (htmlEnd >= 0) { i = htmlEnd; continue; }
    }
    i++;
  }
  return -1;
}

// Skip spaces, tabs and newlines starting at i. Returns the new index.
function skipInlineWs(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// Parse an inline link destination starting at i (just after the "(").
// On success returns {dest, title, end} where end is the index just past
// the closing ")". On failure returns null.
function parseInlineDest(s, i) {
  const n = s.length;
  i = skipInlineWs(s, i);
  if (i >= n) return null;
  let dest = '';
  if (s.charCodeAt(i) === LT) {
    // <...> destination: no "<" or newline inside, escapes honoured.
    let j = i + 1;
    let raw = '';
    let ok = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 10 || c === LT) break;
      if (c === GT) { ok = true; break; }
      if (c === BACKSLASH && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
        raw += s[j] + s[j + 1];
        j += 2;
        continue;
      }
      raw += s[j];
      j++;
    }
    if (!ok) return null;
    dest = raw;
    i = j + 1;
  } else {
    // Bare destination: no spaces or controls, parentheses balanced.
    let j = i;
    let depth = 0;
    let raw = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0) break;
      if (c === 40) { depth++; raw += s[j]; j++; continue; } // (
      if (c === 41) { // )
        if (depth === 0) break;
        depth--;
        raw += s[j];
        j++;
        continue;
      }
      if (c === BACKSLASH && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
        raw += s[j] + s[j + 1];
        j += 2;
        continue;
      }
      raw += s[j];
      j++;
    }
    if (depth !== 0) return null;
    dest = raw;
    i = j;
  }
  // Optional title, then ")".
  let k = skipInlineWs(s, i);
  let title = null;
  if (k < n) {
    const q = s.charCodeAt(k);
    if (q === 34 || q === 39 || q === 40) { // " ' (
      const close = q === 40 ? 41 : q;
      let j = k + 1;
      let raw = '';
      let ok = false;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === close) { ok = true; break; }
        if (c === 10 && j + 1 < n && s.charCodeAt(j + 1) === 10) break; // blank line ends it
        if (q === 40 && c === 40) break; // no nested ( in a (...) title
        if (c === BACKSLASH && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
          raw += s[j] + s[j + 1];
          j += 2;
          continue;
        }
        raw += s[j];
        j++;
      }
      if (!ok) return null;
      title = raw;
      k = j + 1;
    }
  }
  k = skipInlineWs(s, k);
  if (k >= n || s.charCodeAt(k) !== 41) return null;
  return { dest, title, end: k + 1 };
}

// Strip HTML tags from a rendered inline string (for image alt text).
function stripTags(html) {
  if (html.indexOf('<') < 0) return html;
  let out = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html.charCodeAt(i) === LT) {
      const j = html.indexOf('>', i);
      if (j < 0) { out += html.slice(i); break; }
      // An <img> tag contributes its alt text (a nested image's alt
      // becomes part of the outer image's alt).
      if (html.slice(i, i + 4).toLowerCase() === '<img') {
        const tag = html.slice(i, j);
        const m = tag.match(/alt=(?:"([^"]*)"|'([^']*)')/);
        if (m) out += m[1] !== undefined ? m[1] : m[2];
      }
      i = j + 1;
    } else {
      let j = html.indexOf('<', i);
      if (j < 0) j = n;
      out += html.slice(i, j);
      i = j;
    }
  }
  return out;
}

// Try to match an inline HTML tag, comment, processing instruction,
// declaration or CDATA section at position i. Returns the end index
// (exclusive) or -1.
function matchInlineHtml(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) { // ! -- comment, declaration, CDATA
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> are complete (empty) comments on their own.
      if (s.startsWith('<!-->', i)) return i + 5;
      if (s.startsWith('<!--->', i)) return i + 6;
      const end = s.indexOf('-->', i + 4);
      if (end < 0) return -1;
      return end + 3;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end < 0) return -1;
      return end + 3;
    }
    // <!A ...> declaration: letter after <!
    if (i + 2 < n) {
      const c2 = s.charCodeAt(i + 2);
      if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
        const end = s.indexOf('>', i + 3);
        if (end < 0) return -1;
        return end + 1;
      }
    }
    return -1;
  }
  if (c1 === 63) { // <? ... ?>
    const end = s.indexOf('?>', i + 2);
    if (end < 0) return -1;
    return end + 2;
  }
  // Tag: <name ...> or </name ...>
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === SLASH) { closing = true; j++; }
  if (j >= n) return -1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) j++;
    else break;
  }
  // Attributes.
  while (true) {
    // skip whitespace; an attribute must be separated from the tag name
    // (or the previous attribute) by whitespace.
    let skippedWs = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13) { j++; skippedWs = true; }
      else break;
    }
    if (j >= n) return -1;
    const c = s.charCodeAt(j);
    if (c === GT) return j + 1;
    if (c === SLASH) {
      if (closing) return -1;
      if (j + 1 < n && s.charCodeAt(j + 1) === GT) return j + 2;
      return -1;
    }
    // A closing tag takes no attributes.
    if (closing) return -1;
    // An attribute name must follow whitespace.
    if (!skippedWs) return -1;
    // attribute name
    const a0 = s.charCodeAt(j);
    if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return -1;
    j++;
    while (j < n) {
      const d = s.charCodeAt(j);
      if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) ||
        d === 95 || d === 58 || d === 45 || d === 46) j++;
      else break;
    }
    // Whitespace around "=" is allowed, but if there is no "=", the
    // whitespace belongs to the separator before the next attribute,
    // so do not consume it here.
    const afterName = j;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 32 || d === 9 || d === 10 || d === 13) j++;
      else break;
    }
    if (j < n && s.charCodeAt(j) === 61) { // =
      j++;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 32 || d === 9 || d === 10 || d === 13) j++;
        else break;
      }
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        const end = s.indexOf(String.fromCharCode(q), j);
        if (end < 0) return -1;
        j = end + 1;
      } else {
        // unquoted value: no space, ", ', =, <, >, `
        let k = j;
        while (k < n) {
          const d = s.charCodeAt(k);
          if (d === 32 || d === 9 || d === 10 || d === 13 || d === 34 || d === 39 ||
            d === 61 || d === 60 || d === 62 || d === 96) break;
          k++;
        }
        if (k === j) return -1;
        j = k;
      }
    } else {
      j = afterName;
    }
  }
}

// Try to match a <...> autolink at i. Returns {href, text, end} or null.
function matchAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // scan the inside: no space, < or newline; backslash escapes honoured
  let inner = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === LT) return null;
    if (c === GT) break;
    if (c === BACKSLASH && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1)) && s.charCodeAt(j + 1) !== GT) {
      // A backslash escape, except that ">" always closes the autolink
      // (the backslash stays part of the URL).
      inner += s[j] + s[j + 1];
      j += 2;
      continue;
    }
    inner += s[j];
    j++;
  }
  if (j >= n || s.charCodeAt(j) !== GT || inner.length === 0) return null;
  // scheme:...  (2-32 chars: letter, then letters/digits/+/-/. )
  const colon = inner.indexOf(':');
  if (colon >= 1) {
    const scheme = inner.slice(0, colon);
    if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}$/.test(scheme)) {
      return { href: inner, text: inner, end: j + 1 };
    }
  }
  // email address
  if (/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(inner)) {
    return { href: 'mailto:' + inner, text: inner, end: j + 1 };
  }
  return null;
}

// Characters in marked's backpedal punctuation set: ?!.,:;*_'\"~()&
function isBackpedalPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === STAR || c === UNDER || c === 39 || c === 34 || c === TILDE ||
    c === 40 || c === 41 || c === 38;
}

// The backpedal's trailing-punctuation set: the same, minus ( and &.
function isBackpedalTrail(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === STAR || c === UNDER || c === 39 || c === 34 || c === TILDE || c === 41;
}

// Trim an extended autolink candidate the way marked's _backpedal does:
// keep the longest prefix made of normal-character runs, balanced (...)
// groups, a lone & (not an &...; entity at the end), and trailing
// punctuation runs that are not at the very end. An unmatched ( stops
// the link there; a trailing ) that is not part of a balanced group is
// dropped. Returns the trimmed end index.
function trimAutolinkEnd(s, a, b) {
  let end = a;
  while (end < b) {
    const c = s.charCodeAt(end);
    if (!isBackpedalPunct(c)) {
      while (end < b && !isBackpedalPunct(s.charCodeAt(end))) end++;
      continue;
    }
    if (c === 40) { // ( : a balanced group, else stop
      let k = end + 1;
      while (k < b && s.charCodeAt(k) !== 41) k++;
      if (k < b) { end = k + 1; continue; }
      break;
    }
    if (c === 38) { // & : stop before an &...; entity at the end
      let k = end + 1;
      while (k < b && ((s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) ||
        (s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) ||
        (s.charCodeAt(k) >= 97 && s.charCodeAt(k) <= 122))) k++;
      if (k < b && k > end + 1 && s.charCodeAt(k) === 59 && k + 1 === b) break;
      end++;
      continue;
    }
    if (isBackpedalTrail(c)) {
      let k = end;
      while (k < b && isBackpedalTrail(s.charCodeAt(k))) k++;
      if (k < b) { end = k; continue; }
      break; // trailing punctuation at the end: drop it
    }
    break;
  }
  return end;
}

// Try to match an extended (bare) autolink starting at i: www.*,
// scheme://*, or an email address. `prevOk` says the preceding character
// allows an autolink here. Returns {href, text, end} or null.
function matchExtendedAutolink(s, i, prevOk) {
  if (!prevOk) return null;
  const n = s.length;
  // www.
  if (s.startsWith('www.', i)) {
    let j = i + 4;
    let lastDot = -1;
    let hasLabel = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 45 || c === 95 || c === 46) {
        if (c === 46) lastDot = j;
        else hasLabel = true;
        j++;
      } else break;
    }
    // continue over path characters after the domain
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === LT || c === GT) break;
      j++;
    }
    if (!hasLabel) return null;
    const end = trimAutolinkEnd(s, i, j);
    if (end <= i + 4) return null;
    // the domain part must end in a label character, not a dot
    let e = end;
    while (e > i + 4 && s.charCodeAt(e - 1) === 46) e--;
    const text = s.slice(i, e);
    if (text.length <= 4) return null;
    return { href: 'http://' + text, text, end: e };
  }
  // mailto: / xmpp: + email (lowercase scheme only, per marked). xmpp:
  // may carry one path segment of [A-Za-z0-9@.].
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const isXmpp = s.charCodeAt(i) === 120; // x
    const eStart = i + (isXmpp ? 5 : 7);
    const eEnd = matchEmailAt(s, eStart);
    if (eEnd >= 0) {
      let end = eEnd;
      if (isXmpp && end < n && s.charCodeAt(end) === 47) {
        let k = end + 1;
        while (k < n) {
          const c = s.charCodeAt(k);
          if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64 || c === 46) k++;
          else break;
        }
        if (k > end + 1) end = k;
      }
      const text = s.slice(i, end);
      return { href: text, text, end };
    }
    return null;
  }
  // scheme://
  const m = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\//.exec(s.slice(i, i + 36));
  if (m) {
    let j = i + m[0].length;
    let hasLabel = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === LT || c === GT) break;
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) hasLabel = true;
      j++;
    }
    if (!hasLabel) return null;
    const end = trimAutolinkEnd(s, i, j);
    if (end <= i + m[0].length) return null;
    const text = s.slice(i, end);
    return { href: text, text, end };
  }
  // email: local@domain
  if (i > 0) {
    const pc = s.charCodeAt(i - 1);
    if (!((pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122) ||
      pc === 46 || pc === 95 || pc === 45)) {
      // local part must start at a word character; the scan starts at i
      // which the caller only does for plausible starts
    }
  }
  return null;
}

// Match the domain part of an email starting just after the "@" (at is
// the "@" index). Returns the end index of the domain, or -1. Mirrors
// marked's email domain: labels of [A-Za-z0-9-_], at least one dot, the
// last label ends with an alphanumeric, and the character after the
// address must not be a word character or a hyphen.
function matchEmailDomain(s, at) {
  const n = s.length;
  let j = at + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 46 || c === 95) j++;
    else break;
  }
  let end = j;
  while (end > at + 1 && s.charCodeAt(end - 1) === 46) end--;
  if (end <= at + 1) return -1;
  if (s.charCodeAt(at + 1) === 46) return -1; // leading dot
  const lastCh = s.charCodeAt(end - 1);
  if (!((lastCh >= 48 && lastCh <= 57) || (lastCh >= 65 && lastCh <= 90) || (lastCh >= 97 && lastCh <= 122))) return -1;
  let hasDot = false;
  for (let k = at + 1; k < end; k++) {
    if (s.charCodeAt(k) === 46) {
      hasDot = true;
      if (k + 1 < end && s.charCodeAt(k + 1) === 46) return -1; // ..
    }
  }
  if (!hasDot) return -1;
  if (end < n) {
    const c = s.charCodeAt(end);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45) return -1;
  }
  return end;
}

// Match a full email address starting at i (the local part). Returns the
// end index, or -1. Local part is [A-Za-z0-9._+-]+.
function matchEmailAt(s, i) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return -1;
  return matchEmailDomain(s, j);
}

// A bare email whose domain is followed by _ links only when that _
// closes an emphasis span: marked parses the emphasis first, so the _
// is gone before the email is matched. A trailing - never links, and a
// _ with no matching opener does not link either. `nodes` are the
// delimiter nodes built so far in this scan.
function matchBareEmailEmphasis(s, start, at, nodes) {
  const n = s.length;
  const local = s.slice(start, at);
  if (local.length === 0) return null;
  for (let k = 0; k < local.length; k++) {
    const c = local.charCodeAt(k);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45)) return null;
  }
  let j = at + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 46 || c === 95) j++;
    else break;
  }
  let end = j;
  while (end > at + 1 && (s.charCodeAt(end - 1) === 46 || s.charCodeAt(end - 1) === 95)) end--;
  if (end <= at + 1) return null;
  if (s.charCodeAt(at + 1) === 46) return null;
  const lastCh = s.charCodeAt(end - 1);
  if (!((lastCh >= 48 && lastCh <= 57) || (lastCh >= 65 && lastCh <= 90) || (lastCh >= 97 && lastCh <= 122))) return null;
  // The trimmed tail must be a _ (the emphasis closer), followed by a
  // non-word character so it can close.
  if (end >= j || s.charCodeAt(end) !== 95) return null;
  if (end + 1 < n) {
    const after = s.charCodeAt(end + 1);
    if ((after >= 48 && after <= 57) || (after >= 65 && after <= 90) || (after >= 97 && after <= 122)) return null;
  }
  let hasDot = false;
  for (let k = at + 1; k < end; k++) {
    if (s.charCodeAt(k) === 46) {
      hasDot = true;
      if (k + 1 < end && s.charCodeAt(k + 1) === 46) return null;
    }
  }
  if (!hasDot) return null;
  for (let q = 0; q < nodes.length; q++) {
    const nd = nodes[q];
    if (nd.t === 4 && nd.ch === '_' && nd.canOpen && nd.n > 0) {
      const text = s.slice(start, end);
      return { href: 'mailto:' + text, text, end };
    }
  }
  return null;
}

// Try to match a bare email address ending at the "@" the scanner is on.
// `start` is the beginning of the local part. Returns {href, text, end}.
function matchBareEmail(s, start, at) {
  const local = s.slice(start, at);
  if (local.length === 0) return null;
  for (let k = 0; k < local.length; k++) {
    const c = local.charCodeAt(k);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45)) return null;
  }
  const end = matchEmailDomain(s, at);
  if (end < 0) return null;
  const text = s.slice(start, end);
  return { href: 'mailto:' + text, text, end };
}

// Resolve the delimiter stack into emphasis, strong emphasis and
// strikethrough. Delimiter nodes are visited left to right; a node that can
// close looks back through the stack of still-open delimiters for the
// nearest opener of the same character, skipping openers the odd-match rule
// forbids (one of the two runs can both open and close and their lengths
// sum to a multiple of three, unless both are multiples of three) and
// openers with nothing between them and the closer. A match uses two
// characters when both sides still have at least two (one for a del pair
// is always two), else one.
function processEmphasis(nodes) {
  // Simulate marked's emStrong remaining-opener count (m) and skipped
  // closer length (f) for the pairing of opener oi with closer i, over
  // the completed pairs strictly between them. A pair adds its opener
  // length when the opener is a real opener (preceded by a space or
  // punctuation) and subtracts its closer length unless the closer is
  // a group-6 closer skipped by the odd-match rule (y % 3 != 0 and
  // (y + b) % 3 == 0). The pairing is blocked only when the closer
  // cannot bring m to zero. Returns { blocked, m, f }; m and f feed
  // the closer-consumption rule b' = min(b, b + m + f) below.
  const isWordCh = (c) => c !== undefined && !isWsCh(c) && !isPunctCh(c);
  const simulateEmStrong = (oi, i) => {
    const y = nodes[oi].orig;
    const ch = nodes[i].ch;
    let m = nodes[oi].n;
    let f = 0;
    let anyInner = false;
    if (y % 3 !== 0) {
      for (let k = oi + 1; k < i; k++) {
        const mid = nodes[k];
        if (mid.t !== 4 || mid.ch !== ch) continue;
        if (mid.closeTags.length === 0 || !mid.openers || mid.openers.length === 0) continue;
        if (mid.openers[0] === oi) continue; // same opener as the outer
        // pair: its consumption is already in nodes[oi].n, so counting
        // it again would double-count.
        anyInner = true;
        const op2Idx = mid.openers[0];
        const before = nodes[op2Idx - 1];
        const beforeCh = before ? (before.t === 0 ? before.s[before.s.length - 1] : before.ch) : undefined;
        const openerAdds = !isWordCh(beforeCh);
        const prev = nodes[k - 1];
        const next = nodes[k + 1];
        const prevCh = prev ? (prev.t === 0 ? prev.s[prev.s.length - 1] : prev.ch) : undefined;
        const nextCh = next ? (next.t === 0 ? next.s[0] : next.ch) : undefined;
        const closerGroup6 = isWordCh(prevCh) && isWordCh(nextCh);
        const closerSkipped = closerGroup6 && (y + mid.orig) % 3 === 0;
        if (openerAdds) m += nodes[op2Idx].orig;
        if (closerSkipped) f += mid.orig;
        else m -= mid.orig;
      }
    }
    const blocked = anyInner && m - nodes[i].n > 0;
    return { blocked, m, f };
  };
  const stack = [];
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.t !== 4) continue;
    if (nd.canClose && nd.n > 0) {
      while (nd.n > 0) {
        let found = -1;
        let foundSim = null;
        for (let s = stack.length - 1; s >= 0; s--) {
          const oi = stack[s];
          const op = nodes[oi];
          if (op.ch !== nd.ch || op.n === 0) continue;
          if (oi === i - 1) continue; // nothing between opener and closer
          if (op.canClose || nd.canOpen) {
            const sum = op.n + nd.n;
            if (sum % 3 === 0 && !(op.n % 3 === 0 && nd.n % 3 === 0)) continue;
          }
          if (nd.ch !== '~') {
            const sim = simulateEmStrong(oi, i);
            if (sim.blocked) continue;
            foundSim = sim;
          }
          found = s;
          break;
        }
        if (found < 0) break;
        const oi = stack[found];
        const op = nodes[oi];
        const use = (op.n >= 2 && nd.n >= 2) ? 2 : 1;
        if (nd.ch === '~') {
          op.openTags.unshift('<del>');
          nd.closeTags.push('</del>');
        } else if (use === 2) {
          op.openTags.unshift('<strong>');
          nd.closeTags.push('</strong>');
        } else {
          op.openTags.unshift('<em>');
          nd.closeTags.push('</em>');
        }
        if (!nd.openers) nd.openers = [];
        nd.openers.push(oi);
        // Marked consumes b' = min(b, b + m + f) of the closer run into
        // the span, where b is the closer's run length and m/f come from
        // the emStrong scan. When b' exceeds the delimiter count used,
        // the extra characters are literal text inside the span, just
        // before the close tag (e.g. **a *b*c*** keeps one * inside).
        // This only applies when the opener is fully consumed by this
        // pairing: otherwise the closer's remainder can still pair
        // again (***foo*** forms em around strong, not a literal *).
        if (foundSim && nd.n === nd.orig && op.n - use === 0) {
          const bPrime = Math.min(nd.orig, nd.orig + (foundSim.m - nd.orig) + foundSim.f);
          const extra = bPrime - use;
          if (extra > 0) {
            nd.innerBefore = (nd.innerBefore || 0) + extra;
            nd.n -= extra;
          }
        }
        op.n -= use;
        nd.n -= use;
        // Delimiters between the opener and the closer are inside the
        // completed span: drop them from the stack so a later closer
        // cannot pair with one of them and overlap this emphasis.
        stack.splice(found + 1);
        if (op.n === 0) stack.splice(found, 1);
      }
    }
    if (nd.canOpen && nd.n > 0) stack.push(i);
  }
}

// Render one node to HTML.
function renderNode(nd, out) {
  switch (nd.t) {
    case 0: out.push(nd.s); break;
    case 1: out.push('<code>', nd.s, '</code>'); break;
    case 2: out.push('<br>'); break;
    case 3: out.push(nd.s); break;
    case 4:
      // Extra closer characters consumed into the span by marked's
      // b' rule render as literal text just before the close tag.
      if (nd.innerBefore) out.push(nd.ch.repeat(nd.innerBefore));
      if (nd.closeTags.length) out.push(nd.closeTags.join(''));
      if (nd.n > 0) out.push(nd.ch.repeat(nd.n));
      if (nd.openTags.length) out.push(nd.openTags.join(''));
      break;
    default: out.push(nd.s); break; // 5 and 6 hold finished HTML
  }
}

// Compute flanking flags for a delimiter run at s[i..j). Returns
// [canOpen, canClose] for '*'/'~' style; the '_' restrictions are applied
// by the caller. At the start/end of the string there is no adjacent
// character, which counts as whitespace (the beginning/end of a line
// are treated as whitespace for flanking).
function flanking(s, i, j) {
  const n = s.length;
  let prevWs = true, prevPunct = false, nextWs = true, nextPunct = false;
  if (i > 0) {
    const p = s[i - 1];
    prevWs = isWsCh(p);
    prevPunct = isPunctCh(p);
  }
  if (j < n) {
    const q = s[j];
    nextWs = isWsCh(q);
    nextPunct = isPunctCh(q);
  }
  const left = !nextWs && (!nextPunct || prevWs || prevPunct);
  const right = !prevWs && (!prevPunct || nextWs || nextPunct);
  return [left, right];
}

// Document-wide inLink state: marked's lexer sets state.inLink when it
// sees an <a ...> tag and clears it on </a>, and the state persists for
// the whole document. An unclosed <a> therefore suppresses extended
// autolinks and bare emails in every later block. Reset in parse().
let docInLink = false;

// Update docInLink from an inline HTML tag's text, mirroring marked's
// tag tokenizer exactly: it sets inLink only on `<a ` (an <a> followed
// by a space -- a bare <a> or a self-closing <a/> does not count) and
// clears it only on </a> (exactly, no space before the >).
function updateDocInLink(tag) {
  let j = 1;
  let closing = false;
  if (j < tag.length && tag.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= tag.length) return;
  const c = tag.charCodeAt(j);
  if (c !== 97 && c !== 65) return; // not 'a'
  if (closing) {
    if (j + 1 < tag.length && tag.charCodeAt(j + 1) === 62) docInLink = false;
  } else {
    if (j + 1 < tag.length && tag.charCodeAt(j + 1) === 32) docInLink = true;
  }
}

// Find the ")" matching the "(" at parenIdx, accounting for nested
// parens, backslash escapes and angle-bracket destinations. Returns
// the index of the ")" or -1.
function findDestCloseParen(s, parenIdx) {
  const n = s.length;
  let depth = 1;
  let i = parenIdx + 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === BACKSLASH && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { i += 2; continue; }
    if (c === LT) {
      const end = s.indexOf('>', i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === 40) { depth++; i++; continue; }
    if (c === 41) {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Parse inline markup in s and return its HTML. `refs` maps normalised
// labels to {href, title}. When inLink is true, '[' does not start a link
// (links cannot nest), but images still can.
function scanInline(s, refs, inLink) {
  const nodes = [];
  const n = s.length;
  let i = 0;
  let textStart = 0;
  // Emphasis masking: when an inline link fails to form, marked still
  // hides its whole syntactic span from the emphasis search, so the
  // delimiters inside it stay literal. maskUntil is the end of such a
  // failed span; delimiters before it are literal text. (A failed
  // reference link is not masked unless its ref exists, which is the
  // case that forms a link anyway.)
  let maskUntil = 0;
  // The document-wide <a> state joins the per-call link-text flag. It
  // is read live at each branch below, because an <a> tag earlier in
  // this same scan sets it for the rest of the scan.
  const flush = (upto) => {
    if (upto > textStart) nodes.push({ t: 0, s: escText(s, textStart, upto) });
  };

  while (i < n) {
    const c = s.charCodeAt(i);
    // Backslash escape or hard break.
    if (c === BACKSLASH) {
      if (i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (d === NL) {
          flush(i);
          nodes.push({ t: 2 });
          i += 2;
          // A hard break consumes the spaces/tabs at the start of the
          // next line.
          while (i < n && (s.charCodeAt(i) === SPACE || s.charCodeAt(i) === TAB)) i++;
          textStart = i;
          continue;
        }
        if (isAsciiPunct(d)) {
          flush(i);
          nodes.push({ t: 0, s: escText(s, i + 1, i + 2) });
          i += 2;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // Code span.
    if (c === BACKTICK) {
      let j = i;
      while (j < n && s.charCodeAt(j) === BACKTICK) j++;
      const run = j - i;
      let k = j;
      let found = -1;
      let foundEnd = -1;
      while (k < n) {
        if (s.charCodeAt(k) === BACKTICK) {
          let m = k;
          while (m < n && s.charCodeAt(m) === BACKTICK) m++;
          if (m - k === run) { found = k; foundEnd = m; break; }
          k = m;
        } else k++;
      }
      if (found >= 0) {
        let content = s.slice(j, found);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
          content.charCodeAt(content.length - 1) === 32 &&
          content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flush(i);
        nodes.push({ t: 1, s: escRaw(content, 0, content.length) });
        i = foundEnd;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // Emphasis delimiters.
    if (c === STAR || c === UNDER) {
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      // Inside a masked span (a failed inline link) the delimiters
      // are literal text, not emphasis.
      if (i < maskUntil) { i = j; continue; }
      const [left, right] = flanking(s, i, j);
      let canOpen, canClose;
      if (c === STAR) {
        canOpen = left;
        canClose = right;
      } else {
        canOpen = left && (!right || (i > 0 && isPunctCh(s[i - 1])));
        canClose = right && (!left || (j < n && isPunctCh(s[j])));
      }
      if (canOpen || canClose) {
        flush(i);
        nodes.push({ t: 4, ch: String.fromCharCode(c), n: j - i, orig: j - i, canOpen, canClose, openTags: [], closeTags: [] });
        i = j;
        textStart = i;
        continue;
      }
      i = j;
      continue;
    }
    // Strikethrough delimiters. A run of one or two tildes is a
    // delimiter (a single ~ also strikes through); a run of three or
    // more is literal text.
    if (c === TILDE) {
      let j = i;
      while (j < n && s.charCodeAt(j) === TILDE) j++;
      // Inside a masked span the tildes are literal text.
      if (i < maskUntil) { i = j; continue; }
      if (j - i === 1 || j - i === 2) {
        const [left, right] = flanking(s, i, j);
        if (left || right) {
          flush(i);
          nodes.push({ t: 4, ch: '~', n: j - i, orig: j - i, canOpen: left, canClose: right, openTags: [], closeTags: [] });
          i = j;
          textStart = i;
          continue;
        }
      }
      i = j;
      continue;
    }
    // Link or image.
    if (c === LBRACK || (c === BANG && i + 1 < n && s.charCodeAt(i + 1) === LBRACK)) {
      const isImage = c === BANG;
      const open = isImage ? i + 1 : i;
      const close = findMatchingBracket(s, open);
      if (close < 0) {
        // No matching bracket: the link cannot form. But if the text
        // looks like a link attempt -- a ] followed by ( -- the whole
        // syntactic span is still masked from emphasis (marked hides
        // it when the label's code spans do not resolve, which is what
        // makes findMatchingBracket fail here).
        const rb = s.indexOf(']', open + 1);
        if (rb >= 0 && rb + 1 < n && s.charCodeAt(rb + 1) === 40) {
          const cp = findDestCloseParen(s, rb + 1);
          maskUntil = Math.max(maskUntil, cp >= 0 ? cp + 1 : rb + 1);
        }
        i++;
        continue;
      }
      const text = s.slice(open + 1, close);
      // The link text is parsed on its own, in link context: extended
      // autolinks (www, scheme://, email) do not form inside it, but a
      // link inside it does — and a link whose text contains a link is
      // not a link (the inner one wins instead).
      const innerNodes = inlineParseNodes(text, refs, true);
      const innerHasLink = innerNodes.some((nd) => nd.t === 5 && !nd.img);
      if (!isImage && innerHasLink) { i++; continue; }
      const innerHtml = renderNodesToString(innerNodes);
      let after = close + 1;
      let href = null;
      let title = null;
      if (after < n && s.charCodeAt(after) === 40) { // (
        const dest = parseInlineDest(s, after + 1);
        if (dest) {
          href = unescape(dest.dest);
          title = dest.title === null ? null : unescape(dest.title);
          after = dest.end;
        } else {
          // Not a valid inline destination: fall back to the shortcut
          // reference (e.g. [foo](not a link) with [foo]: /url1).
          const ref = refs.get(normalizeLabel(text));
          if (ref) {
            href = ref.href;
            title = ref.title;
          }
        }
      } else if (after < n && s.charCodeAt(after) === LBRACK) {
        // Full or collapsed reference.
        const close2 = s.indexOf(']', after + 1);
        if (close2 >= 0) {
          const label = close2 === after + 1 ? text : s.slice(after + 1, close2);
          const ref = refs.get(normalizeLabel(label));
          if (ref) {
            href = ref.href;
            title = ref.title;
            after = close2 + 1;
          }
        }
      } else {
        // Shortcut reference.
        const ref = refs.get(normalizeLabel(text));
        if (ref) {
          href = ref.href;
          title = ref.title;
        }
      }
      if (href === null) {
        // The link failed, but if an inline destination was attempted
        // the whole syntactic span is still masked from emphasis: the
        // delimiters inside it stay literal.
        if (after < n && s.charCodeAt(after) === 40) {
          const cp = findDestCloseParen(s, after);
          if (cp >= 0) maskUntil = Math.max(maskUntil, cp + 1);
          else maskUntil = Math.max(maskUntil, close + 1);
        }
        i++;
        continue;
      }
      const clean = cleanUrl(href);
      if (clean === null) {
        // A parsed link with an unusable URL is masked the same way.
        maskUntil = Math.max(maskUntil, after);
        i++;
        continue;
      }
      flush(i);
      let html;
      if (isImage) {
        const altRaw = stripTags(innerHtml);
        const alt = escText(altRaw, 0, altRaw.length);
        html = '<img src="' + escText(clean, 0, clean.length) + '" alt="' + alt + '"' +
          (title === null ? '' : ' title="' + escText(title, 0, title.length) + '"') + '>';
        nodes.push({ t: 5, s: html, img: true });
      } else {
        html = '<a href="' + escText(clean, 0, clean.length) + '"' +
          (title === null ? '' : ' title="' + escText(title, 0, title.length) + '"') + '>' +
          innerHtml + '</a>';
        nodes.push({ t: 5, s: html, img: false });
      }
      i = after;
      textStart = i;
      continue;
    }
    // Autolink, inline HTML, or a literal "<".
    if (c === LT) {
      const auto = matchAutolink(s, i);
      if (auto) {
        flush(i);
        const rawHref = cleanUrl(auto.href) ?? '';
        const href = escText(rawHref, 0, rawHref.length);
        const text = escText(auto.text, 0, auto.text.length);
        nodes.push({ t: 6, s: '<a href="' + href + '">' + text + '</a>' });
        i = auto.end;
        textStart = i;
        continue;
      }
      const htmlEnd = matchInlineHtml(s, i);
      if (htmlEnd >= 0) {
        flush(i);
        updateDocInLink(s.slice(i, htmlEnd));
        nodes.push({ t: 3, s: s.slice(i, htmlEnd) });
        i = htmlEnd;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Hard or soft line break. A soft break keeps the newline in the text
    // run; a hard break (two trailing spaces) drops them and emits <br>.
    if (c === NL) {
      // Count trailing spaces in the pending text run.
      let k = i;
      while (k > textStart && s.charCodeAt(k - 1) === SPACE) k--;
      if (i - k >= 2) {
        flush(k);
        nodes.push({ t: 2 });
        i++;
        // A hard break consumes the spaces/tabs at the start of the
        // next line.
        while (i < n && (s.charCodeAt(i) === SPACE || s.charCodeAt(i) === TAB)) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // Extended autolink: www. or scheme:// at a word start. Inside link
    // text these do not form (marked suppresses its url tokenizer there);
    // a <...> autolink still does, so that branch is not gated.
    if (c === 119 && !(inLink || docInLink) && s.startsWith('www.', i)) { // w
      const prevOk = i === 0 || (() => {
        const p = s.charCodeAt(i - 1);
        return p === 32 || p === 9 || p === 10 || p === 13 || p === STAR || p === UNDER || p === TILDE || p === 40 || p === LT;
      })();
      const auto = matchExtendedAutolink(s, i, prevOk);
      if (auto) {
        flush(i);
        const href = escText(cleanUrl(auto.href) ?? auto.href, 0, (cleanUrl(auto.href) ?? auto.href).length);
        const text = escText(auto.text, 0, auto.text.length);
        nodes.push({ t: 6, s: '<a href="' + href + '">' + text + '</a>' });
        i = auto.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      // Possible scheme:// autolink at a word start.
      const prevOk = i === 0 || (() => {
        const p = s.charCodeAt(i - 1);
        return p === 32 || p === 9 || p === 10 || p === 13 || p === STAR || p === UNDER || p === TILDE || p === 40 || p === LT;
      })();
      if (prevOk && !(inLink || docInLink)) {
        const auto = matchExtendedAutolink(s, i, true);
        if (auto) {
          flush(i);
          const href = escText(cleanUrl(auto.href) ?? auto.href, 0, (cleanUrl(auto.href) ?? auto.href).length);
          const text = escText(auto.text, 0, auto.text.length);
          nodes.push({ t: 6, s: '<a href="' + href + '">' + text + '</a>' });
          i = auto.end;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // Bare email address: the "@" ends the local part. The local part
    // for a bare email is [A-Za-z0-9._+-]+.
    if (c === 64) { // @
      let start = i - 1;
      while (start >= textStart) {
        const d = s.charCodeAt(start);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) ||
          d === 46 || d === 95 || d === 43 || d === 45) start--;
        else break;
      }
      start++;
      if (start < i) {
        const prevOk = start === 0 || (() => {
          const p = s.charCodeAt(start - 1);
          return p === 32 || p === 9 || p === 10 || p === 13 || p === STAR || p === UNDER || p === TILDE || p === 40;
        })();
        if (prevOk && !(inLink || docInLink)) {
          const mail = matchBareEmail(s, start, i) || matchBareEmailEmphasis(s, start, i, nodes);
          if (mail) {
            flush(start);
            const href = escText(mail.href, 0, mail.href.length);
            const text = escText(mail.text, 0, mail.text.length);
            nodes.push({ t: 6, s: '<a href="' + href + '">' + text + '</a>' });
            i = mail.end;
            textStart = i;
            continue;
          }
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flush(n);
  return nodes;
}

// Parse inline markup in s and return its HTML.
function inlineParse(s, refs, inLink) {
  const nodes = scanInline(s, refs, inLink);
  processEmphasis(nodes);
  const out = [];
  for (const nd of nodes) renderNode(nd, out);
  return out.join('');
}

// Scan inline markup and return the node list with emphasis resolved
// (used for link text, where the caller must know whether a link formed).
function inlineParseNodes(s, refs, inLink) {
  const nodes = scanInline(s, refs, inLink);
  processEmphasis(nodes);
  return nodes;
}

function renderNodesToString(nodes) {
  const out = [];
  for (const nd of nodes) renderNode(nd, out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------
//
// Lines are processed top to bottom. Open containers (block quotes, lists,
// list items) are matched first; the remaining text is then handled by the
// open leaf (paragraph, fenced/indented code, HTML block, table) or starts
// a new block. Paragraph lines keep their leading spaces: only container
// markers and list item indents are removed.

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Columns of leading whitespace in s from index i, where s[i] is at
// column base of the original line (a tab advances to the next multiple
// of four). The base matters: after a strip, a surviving tab still has
// its original width, so widths are always measured from the original
// line, not from the stripped remainder.
function colsOf(s, i, base) {
  let c = base;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { c++; i++; }
    else if (ch === 9) { c += 4 - (c % 4); i++; }
    else break;
  }
  return c - base;
}

// Remove n columns of leading whitespace from s, where s[0] is at column
// base of the original line. A tab that is only partly consumed leaves
// spaces behind.
function stripCols(s, n, base) {
  let c = base;
  let i = 0;
  while (i < s.length && c - base < n) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { c++; i++; }
    else if (ch === 9) {
      const next = c + 4 - (c % 4);
      if (next - base <= n) { c = next; i++; }
      else return ' '.repeat(next - (base + n)) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Expand leading tabs to spaces, measuring from column base: a tab at
// column c becomes 4 - (c % 4) spaces. Marked expands a tab that survives
// container stripping (list item indent, block quote marker) to the spaces
// its column calls for; a tab at column 0 of a top-level line is left
// alone, so this runs only right after a container strip, never on raw
// top-level content.
function expandLeadingTabs(s, base) {
  let c = base;
  let i = 0;
  let out = '';
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) { out += ' '; c++; i++; }
    else if (ch === 9) { const n = 4 - (c % 4); out += ' '.repeat(n); c += n; i++; }
    else break;
  }
  if (i === 0) return s;
  return out + s.slice(i);
}

// The block tags of CommonMark HTML block type 6.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup ' +
  'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
  'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav ' +
  'noframes ol optgroup option p param section source summary table tbody td tfoot th thead ' +
  'title tr track ul').split(' '));

// Split a table row line into cell strings. Escaped pipes do not split.
// Leading and trailing pipes (and the empty cells they imply) are dropped.
function splitRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // skip leading spaces, then an optional leading pipe
  let j = 0;
  while (j < n && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let start = j;
  if (j < n && line.charCodeAt(j) === 124) { start = j + 1; }
  i = start;
  let end = n;
  // drop a trailing pipe (after trailing spaces)
  let k = n - 1;
  while (k >= start && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k--;
  if (k >= start && line.charCodeAt(k) === 124) end = k;
  while (i < end) {
    const c = line.charCodeAt(i);
    if (c === BACKSLASH && i + 1 < end && line.charCodeAt(i + 1) === 124) {
      // An escaped pipe is a literal pipe in the cell content; the
      // backslash is consumed by the split, even inside a code span.
      cur += '|';
      i += 2;
      continue;
    }
    if (c === 124) {
      cells.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

// Parse a table delimiter row. Returns the alignment array, or null when
// the line is not a delimiter row.
function parseDelimiter(line) {
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    if (cell.charCodeAt(0) === 58 && cell.charCodeAt(cell.length - 1) === 58) align.push('center');
    else if (cell.charCodeAt(0) === 58) align.push('left');
    else if (cell.charCodeAt(cell.length - 1) === 58) align.push('right');
    else align.push(null);
  }
  return align;
}

// Match an ATX heading. `s` starts at the first non-space character.
// Returns {level, text} or null.
function atxMatch(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return null;
  const level = i;
  if (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++; // one separator space or tab
  }
  let text = s.slice(i);
  // strip trailing spaces, then a closing sequence of hashes preceded by a
  // space, then the spaces before it; then leading spaces.
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  let hs = end;
  while (hs > 0 && text.charCodeAt(hs - 1) === 35) hs--;
  if (hs < end && (hs === 0 || text.charCodeAt(hs - 1) === 32 || text.charCodeAt(hs - 1) === 9)) {
    end = hs;
    while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  }
  text = text.slice(0, end);
  let start = 0;
  while (start < text.length && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
  return { level, text: text.slice(start) };
}

// Match a fenced code block opening. Returns {ch, len, info} or null.
function fenceMatch(s) {
  if (s.length < 3) return null;
  const ch = s.charCodeAt(0);
  if (ch !== BACKTICK && ch !== 126) return null;
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  if (i < 3) return null;
  const info = s.slice(i).trim();
  if (ch === BACKTICK && info.indexOf('`') >= 0) return null;
  return { ch: String.fromCharCode(ch), len: i, info };
}

// Is s a thematic break?
function isThematic(s) {
  let i = 0;
  const n = s.length;
  let marker = -1;
  let count = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (marker < 0) {
      if (c === 42 || c === 45 || c === 95) { marker = c; count = 1; i++; continue; }
      return false;
    }
    if (c === marker) { count++; i++; continue; }
    return false;
  }
  return marker >= 0 && count >= 3;
}

// Match a list marker at the start of s, where s[0] is at column
// colBase of the original line. Returns null, or {ordered, bullet,
// delim, start, markerChars, spacesAfter, empty, content} where content
// is the text after the marker and its spacing.
function listMarker(s, colBase) {
  const n = s.length;
  let i = 0;
  const c0 = s.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    // bullet
    i = 1;
    if (i < n) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9) return null;
    }
    return finishMarker(s, i, { ordered: false, bullet: String.fromCharCode(c0), start: 0 }, colBase);
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = 0;
    while (j < n && j < 9) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      j++;
    }
    if (j === 0) return null;
    const d = s.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    i = j + 1;
    if (i < n) {
      const c = s.charCodeAt(i);
      if (c !== 32 && c !== 9) return null;
    }
    return finishMarker(s, i, {
      ordered: true, delim: String.fromCharCode(d),
      start: parseInt(s.slice(0, j), 10), startText: s.slice(0, j),
    }, colBase);
  }
  return null;
}

function finishMarker(s, afterMarker, props, colBase) {
  const n = s.length;
  // Columns of whitespace after the marker; the marker starts at column
  // colBase of the original line, so its end column is
  // colBase + afterMarker.
  let col = colBase + afterMarker;
  let i = afterMarker;
  let spaces = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { spaces++; col++; i++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      spaces += next - col;
      col = next;
      i++;
    } else break;
  }
  const empty = i >= n;
  let contentIndent;
  let content;
  let contentBase;
  if (empty) {
    contentIndent = afterMarker + 1;
    content = '';
    contentBase = colBase + afterMarker + 1;
  } else if (spaces >= 5) {
    contentIndent = afterMarker + 1;
    // only one space of the run is the separator; the rest is content
    content = stripCols(s.slice(afterMarker), 1, colBase + afterMarker);
    contentBase = colBase + afterMarker + 1;
  } else {
    contentIndent = afterMarker + spaces;
    content = s.slice(i);
    contentBase = colBase + afterMarker + spaces;
  }
  return { ...props, markerChars: afterMarker, spacesAfter: spaces, empty, contentIndent, content, contentBase };
}

// Match a block quote prefix at the start of s. Returns the remainder
// after ">" and one optional space, or null.
function quotePrefix(s) {
  if (s.length === 0 || s.charCodeAt(0) !== 62) return null;
  let i = 1;
  if (i < s.length && s.charCodeAt(i) === 32) i++;
  else if (i < s.length && s.charCodeAt(i) === 9) {
    // a tab after ">" counts as one space, leaving the rest of the tab
    return '  ' + s.slice(i + 1);
  }
  return s.slice(i);
}

// Detect an HTML block start. Returns {type, endMarkers} or null.
// Types 1-5 end at a marker line; types 6-7 end at a blank line.
function htmlStart(s) {
  if (s.length === 0 || s.charCodeAt(0) !== 60) return null;
  const lower = s.toLowerCase();
  // Type 1: script, pre, style, textarea
  const m1 = /^<(script|pre|style|textarea)(?:[ \t>]|\/|$)/.exec(lower);
  if (m1) {
    return { type: 1, endMarkers: ['</' + m1[1]] };
  }
  if (lower.startsWith('<!--')) return { type: 2, endMarkers: ['-->'] };
  if (lower.startsWith('<?')) return { type: 3, endMarkers: ['?>'] };
  if (lower.length > 2 && lower.charCodeAt(1) === 33) {
    const c2 = lower.charCodeAt(2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      return { type: 4, endMarkers: ['>'] };
    }
    if (lower.startsWith('<![cdata[')) return { type: 5, endMarkers: [']]>'] };
  }
  // Type 6: a block tag, opening or closing, followed by space, tab, ">",
  // "/" or the end of the line.
  const m6 = /^<\/?([a-z][a-z0-9-]*)/.exec(lower);
  if (m6) {
    const name = m6[1];
    const after = lower.charCodeAt(m6[0].length);
    if (BLOCK_TAGS.has(name) && (isNaN(after) || after === 32 || after === 9 || after === 62 || after === 47)) {
      return { type: 6, endMarkers: null };
    }
    // Type 7: any other complete tag alone on the line.
    const tagEnd = matchInlineHtml(s, 0);
    if (tagEnd >= 0) {
      let rest = s.slice(tagEnd);
      if (isBlankStr(rest)) return { type: 7, endMarkers: null };
    }
  }
  return null;
}

// A lazy paragraph continuation line has four leading spaces stripped
// when it has four or more (the indented-code amount); fewer are kept.
// This applies only to lazy lines: a line that matched the containers
// keeps its spaces.
function stripParaCont(line) {
  if (colsOf(line, 0, 0) >= 4) return stripCols(line, 4, 0);
  return line;
}

// Does the line start any block (for lazy continuation: any list marker
// counts, not only one that could interrupt a paragraph)?
function startsAnyBlock(s, base) {
  const ind = colsOf(s, 0, base);
  if (ind > 3) return false;
  const content = stripCols(s, ind, base);
  if (content.length === 0) return false;
  if (atxMatch(content)) return true;
  if (fenceMatch(content)) return true;
  const h = htmlStart(content);
  if (h && h.type <= 6) return true;
  if (isThematic(content)) return true;
  if (content.charCodeAt(0) === 62) return true; // block quote
  if (listMarker(content, base + ind)) return true;
  return false;
}

// Does the line start a block that ends a table (or interrupts a
// paragraph)? `forPara` excludes indented code, which cannot interrupt a
// paragraph but does end a table. `inItem` says the open paragraph sits
// inside a list item: there, an ordered list interrupts it whatever its
// starting number is (a nested list), while at the top level only a list
// starting with 1 can interrupt.
function startsBlock(s, forPara, base, inItem) {
  const ind = colsOf(s, 0, base);
  if (ind > 3) return !forPara; // indented code ends a table only
  const content = stripCols(s, ind, base);
  if (content.length === 0) return false;
  if (atxMatch(content)) return true;
  if (fenceMatch(content)) return true;
  const h = htmlStart(content);
  if (h && h.type <= 6) return true;
  if (isThematic(content)) return true;
  if (content.charCodeAt(0) === 62) return true; // block quote
  const lm = listMarker(content, base + ind);
  if (lm) {
    if (!lm.ordered) return !lm.empty;
    return (inItem || lm.startText === '1') && !lm.empty;
  }
  return false;
}

// Parse a link reference definition from s: the remainder of the current
// line plus the remainders of following lines joined with '\n'. A
// definition may span lines — the destination and the title can each be
// on a following line, and a title can span lines. Returns
// {key, href, title, lines} or null; `lines` is how many source lines
// the definition spans.
function tryDef(s) {
  const n = s.length;
  if (n === 0 || s.charCodeAt(0) !== 91) return null;
  let i = 1;
  let label = '';
  let lines = 1;
  // Label: no unescaped '[', ends at ']'. A newline is allowed unless
  // the following line is blank.
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 93) break;
    if (c === 91) return null;
    if (c === 10) {
      let j = i + 1;
      while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
      if (j >= n || s.charCodeAt(j) === 10) return null;
      label += '\n';
      lines++;
      i++;
      continue;
    }
    if (c === 92 && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { label += s[i] + s[i + 1]; i += 2; continue; }
    label += s[i];
    i++;
  }
  if (i >= n || s.charCodeAt(i) !== 93) return null;
  const key = normalizeLabel(label);
  if (key.length === 0 || key.length > 999) return null;
  i++;
  // ':' after optional spaces/tabs
  while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i >= n || s.charCodeAt(i) !== 58) return null;
  i++;
  // Destination: spaces/tabs, then at most one newline (plus spaces/tabs)
  // before it; the line after the newline must not be blank.
  while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i < n && s.charCodeAt(i) === 10) {
    let j = i + 1;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) j++;
    if (j >= n || s.charCodeAt(j) === 10) return null;
    i = j;
    lines++;
  }
  if (i >= n) return null;
  // Destination.
  let dest = '';
  if (s.charCodeAt(i) === 60) { // <
    i++;
    let raw = '';
    let ok = false;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 10 || c === 60) break;
      if (c === 62) { ok = true; break; }
      if (c === 92 && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { raw += s[i] + s[i + 1]; i += 2; continue; }
      raw += s[i];
      i++;
    }
    if (!ok) return null;
    dest = raw;
    i++;
  } else {
    let depth = 0;
    let raw = '';
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 40) { depth++; raw += s[i]; i++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        raw += s[i];
        i++;
        continue;
      }
      if (c === 92 && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) { raw += s[i] + s[i + 1]; i += 2; continue; }
      raw += s[i];
      i++;
    }
    if (depth !== 0 || raw.length === 0) return null;
    dest = raw;
  }
  // Optional title. It must be separated from the destination by spaces
  // and/or a newline: spaces then optionally a newline, or spaces then a
  // newline. With no separator at all there is no title (so
  // "[foo]: <bar>(baz)" is not a definition). If the title does not parse
  // cleanly, or is followed by anything but spaces, the definition falls
  // back to having no title.
  let title = null;
  let titleEnd = 0;
  let titleLines = lines;
  {
    let j = i;
    let jLines = lines;
    let hasSep = false;
    let sp = 0;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9)) { j++; sp++; }
    if (j < n && s.charCodeAt(j) === 10) {
      let k = j + 1;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (k < n && s.charCodeAt(k) !== 10) {
        j = k;
        jLines = lines + 1;
        hasSep = true;
      }
    } else if (sp > 0) {
      hasSep = true;
    }
    if (hasSep && j < n) {
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39 || q === 40) {
        const close = q === 40 ? 41 : q;
        let k = j + 1;
        let raw = '';
        let ok = false;
        let tLines = jLines;
        while (k < n) {
          const c = s.charCodeAt(k);
          if (c === close) { ok = true; break; }
          if (c === 10) {
            // A single-quoted title may span lines but not blank lines;
            // double-quoted and parenthesised titles may span anything.
            if (q === 39 && k + 1 < n && s.charCodeAt(k + 1) === 10) break;
            raw += s[k];
            k++;
            tLines++;
            continue;
          }
          if (q === 40 && (c === 40 || c === 41)) break;
          if (c === 92 && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) { raw += s[k] + s[k + 1]; k += 2; continue; }
          raw += s[k];
          k++;
        }
        if (ok) {
          title = raw;
          titleEnd = k + 1;
          titleLines = tLines;
        }
      }
    }
  }
  // Use the title only when it is followed by spaces to the end of the
  // line; otherwise the definition has no title.
  let endPos = i;
  let endLines = lines;
  if (title !== null) {
    let k = titleEnd;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
    if (k >= n || s.charCodeAt(k) === 10) {
      endPos = titleEnd;
      endLines = titleLines;
    } else {
      title = null;
    }
  }
  // Only spaces/tabs to the end of the line.
  let k = endPos;
  while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
  if (k < n && s.charCodeAt(k) !== 10) return null;
  return { key, href: unescape(dest), title: title === null ? null : unescape(title), lines: endLines };
}

// Render one block node to HTML.
function renderBlock(nd, refs, out) {
  switch (nd.k) {
    case 'para':
      out.push('<p>', inlineParse(nd.lines.join('\n'), refs, false), '</p>\n');
      break;
    case 'head': {
      const text = nd.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      out.push('<h', nd.level, '>', inlineParse(text, refs, false), '</h', nd.level, '>\n');
      break;
    }
    case 'code': {
      out.push('<pre><code');
      if (nd.lang) out.push(' class="language-', escText(nd.lang, 0, nd.lang.length), '"');
      out.push('>', escRaw(nd.text, 0, nd.text.length), '</code></pre>\n');
      break;
    }
    case 'html':
      out.push(nd.text);
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const ch of nd.children) renderBlock(ch, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      out.push(nd.ordered ? '<ol' : '<ul');
      if (nd.ordered && nd.start !== 1) out.push(' start="', String(nd.start), '"');
      out.push('>\n');
      for (const item of nd.items) renderItem(item, !nd.loose, refs, out);
      out.push(nd.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let c = 0; c < nd.head.length; c++) {
        out.push('<th');
        if (nd.align[c]) out.push(' align="', nd.align[c], '"');
        out.push('>', inlineParse(nd.head[c], refs, false), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (nd.rows.length > 0) {
        out.push('<tbody>');
        for (const row of nd.rows) {
          out.push('<tr>\n');
          for (let c = 0; c < nd.head.length; c++) {
            out.push('<td');
            if (nd.align[c]) out.push(' align="', nd.align[c], '"');
            out.push('>', inlineParse(row[c] !== undefined ? row[c] : '', refs, false), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

function checkboxHtml(task) {
  return task === 'checked'
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

function renderItem(item, tight, refs, out) {
  out.push('<li>');
  let first = true;
  for (const ch of item.children) {
    if (ch.k === 'para') {
      let html = inlineParse(ch.lines.join('\n'), refs, false);
      if (first && item.task) html = checkboxHtml(item.task) + html;
      if (tight) out.push(html);
      else out.push('<p>', html, '</p>\n');
    } else {
      if (first && item.task) out.push(checkboxHtml(item.task), ' ');
      renderBlock(ch, refs, out);
    }
    first = false;
  }
  out.push('</li>\n');
}

// The block parser: lines (no newlines), trailingNL, refs (filled in).
// Returns the top-level block nodes.
function parseBlocks(lines, trailingNL, refs) {
  const root = { k: 'doc', children: [] };
  const stack = [root];
  let leaf = null;

  const hasNL = (i) => i < lines.length - 1 || trailingNL;

  // The child block list a frame holds: the document's own list, or its
  // node's list for quotes and list items.
  function frameChildren(fr) {
    return fr.k === 'doc' ? fr.children : fr.node.children;
  }

  function appendNode(nd) {
    frameChildren(stack[stack.length - 1]).push(nd);
  }

  function closeLeaf() {
    if (!leaf) return;
    if (leaf.k === 'para') {
      if (leaf.lines.length > 0) appendNode({ k: 'para', lines: leaf.lines });
    } else if (leaf.k === 'fence' || leaf.k === 'icode') {
      const ls = leaf.lines;
      if (leaf.k === 'icode') {
        // An indented code block drops all of its trailing blank lines.
        while (ls.length > 0 && ls[ls.length - 1] === '') ls.pop();
      } else if (ls.length > 0 && ls[ls.length - 1] === '') {
        // A fenced code block drops exactly one trailing blank line.
        ls.pop();
      }
      appendNode({ k: 'code', lang: leaf.lang || '', text: ls.length ? ls.join('\n') + '\n' : '' });
    } else if (leaf.k === 'html') {
      let text = leaf.lines.join('\n');
      if (hasNL(leaf.lastIdx)) text += '\n';
      if (leaf.lastIdx + 1 < lines.length) {
        const nextLine = lines[leaf.lastIdx + 1];
        // The block's last line loses its newline when the block ends
        // because a blank line follows, or because the next line is
        // outside this block's containers (a sibling list item, the end
        // of a quote). A new block at the same level keeps the newline.
        // Only a truly empty next line counts as blank here: a line of
        // spaces or tabs keeps the newline -- except for a type 6 block
        // (a <div>, <table> and the like), which always loses it when
        // the block ends, blank line or not.
        if (leaf.type === 6 || nextLine.length === 0 || stripContainers(nextLine) === null) {
          if (text.endsWith('\n')) text = text.slice(0, -1);
        }
      }
      appendNode({ k: 'html', text });
    } else if (leaf.k === 'table') {
      appendNode({ k: 'table', align: leaf.align, head: leaf.head, rows: leaf.rows });
    }
    leaf = null;
  }

  function closeFramesFrom(f) {
    closeLeaf();
    for (let g = stack.length - 1; g >= f; g--) {
      const fr = stack[g];
      const parent = stack[g - 1];
      if (fr.k === 'quote') frameChildren(parent).push(fr.node);
      else if (fr.k === 'item') {
        const list = parent.node;
        list.items.push(fr.node);
      } else if (fr.k === 'list') {
        frameChildren(parent).push(fr.node);
      }
    }
    stack.length = f;
  }

  // A blank line was seen since the last block started. It makes a list
  // loose when it separates two of its items, or two blocks of one item.
  // pendingBlank is for blank lines at the item's level; blankInItem also
  // counts a blank line nested inside a quote, which separates two
  // paragraphs of the item just the same but must not make the list loose
  // when the next thing is a new item.
  let pendingBlank = false;
  let blankInItem = false;
  // A blank line that separates two items of the same list, where the
  // line only carried a quote marker (a bare ">" line). Set only when
  // the blank line is at the item's own level -- the innermost frame is
  // the item (or its list) -- not when it is nested inside a quote or
  // another block within the item, where it does not separate items.
  let blankBetweenItems = false;

  // A new block is starting inside the innermost open list item (if any).
  // A pending blank line between two blocks of that item makes its list
  // loose. Clears the pending blank either way.
  function noteBlockStart() {
    if (!pendingBlank && !blankInItem) return;
    pendingBlank = false;
    blankInItem = false;
    blankBetweenItems = false;
    // Only a block that is a direct child of a list item can make the
    // list loose (a block inside a nested quote does not).
    const top = stack[stack.length - 1];
    if (top.k !== 'item') return;
    if (top.node.children.length > 0) stack[stack.length - 2].node.loose = true;
  }

  // Strip the open containers from a raw line, without mutating the stack.
  // Returns [remainder, baseColumn], or null when the line does not belong
  // inside the innermost container.
  function stripContainers(raw) {
    let rem = raw;
    let remCol = 0;
    for (let f = 1; f < stack.length; f++) {
      const fr = stack[f];
      if (fr.k === 'quote') {
        const ind = colsOf(rem, 0, remCol);
        if (ind > 3) return null;
        const content = stripCols(rem, ind, remCol);
        const r = quotePrefix(content);
        if (r === null) return null;
        // Tab expansion after a quote marker is measured from the
        // marker, not from the absolute column: marked re-bases columns
        // at each container level, so a tab after "> " expands as if it
        // were at column (indent + marker + separator).
        const qbase = ind + 1 + ((content.length > 1 && (content.charCodeAt(1) === 32 || content.charCodeAt(1) === 9)) ? 1 : 0);
        remCol += qbase;
        rem = r;
        rem = expandLeadingTabs(rem, qbase);
      } else if (fr.k === 'list') {
        // nothing to strip
      } else if (fr.k === 'item') {
        const ind = colsOf(rem, 0, remCol);
        if (ind >= fr.contentIndent) {
          rem = stripCols(rem, fr.contentIndent, remCol);
          remCol += fr.contentIndent;
          rem = expandLeadingTabs(rem, remCol);
        } else return null;
      }
    }
    return [rem, remCol];
  }

  // Lazy continuation: a line that does not match the open containers can
  // still continue an open paragraph, as long as it is not blank and does
  // not start a new block. Returns true when the line was consumed.
  function tryLazy(rem, remCol) {
    if (!leaf || leaf.k !== 'para') return false;
    if (isBlankStr(rem)) return false;
    if (startsAnyBlock(rem, remCol)) return false;
    const ind = colsOf(rem, 0, remCol);
    if (ind <= 3) {
      const t = stripCols(rem, ind, remCol);
      // A table delimiter line ends the paragraph (it would form a
      // table), unless its cell count does not match the header's.
      const delim = parseDelimiter(t);
      if (delim) {
        const lastLine = leaf.lines[leaf.lines.length - 1];
        const header = splitRow(lastLine);
        if (header.length === delim.length && header.length > 0) return false;
      }
      // A lazy line that is a setext underline is indented by four spaces
      // so it stays paragraph text instead of becoming a heading — but
      // only inside a block quote, and only when the paragraph's previous
      // line was itself lazy (a setext line directly after a quoted line
      // stays as it is). Inside a plain list item it never gets the
      // indent.
      if (/^([=-]+)[ \t]*$/.test(t)) {
        let inQuote = false;
        for (let g = 1; g < stack.length; g++) if (stack[g].k === 'quote') { inQuote = true; break; }
        if (inQuote && leaf.lastLazy) {
          leaf.lines.push('    ' + t);
          leaf.lastLazy = true;
          return true;
        }
      }
    }
    leaf.lines.push(stripParaCont(rem));
    leaf.lastLazy = true;
    return true;
  }

  function processLine(raw, idx) {
    const blank = isBlankStr(raw);
    // A blank line is content for fenced/indented code and for HTML blocks
    // of types 1-5 — but only when it does not end a block quote: a blank
    // line with no quote marker ends any open quote (and so the block
    // inside it). A blank line inside a list item does not end the item,
    // so it stays part of the code block there. Otherwise the blank line
    // closes the leaf and any open block quotes, and is remembered for
    // loose-list detection.
    if (blank) {
      // A tab-only line inside a table is an empty row (marked keeps it
      // as a row of empty cells); a spaces-only line ends the table.
      if (leaf && leaf.k === 'table' && raw.indexOf('\t') >= 0) {
        leaf.rows.push(splitRow(raw));
        return 0;
      }
      if (leaf && (leaf.k === 'fence' || leaf.k === 'icode' || (leaf.k === 'html' && leaf.type <= 5))) {
        let hasQuote = false;
        for (let g = 1; g < stack.length; g++) if (stack[g].k === 'quote') { hasQuote = true; break; }
        if (!hasQuote) {
          if (leaf.k === 'icode' || leaf.k === 'fence') {
            const sc = stripContainers(raw);
            if (sc) {
              const n = leaf.k === 'icode' ? 4 : Math.min(colsOf(sc[0], 0, sc[1]), leaf.fenceIndent);
              leaf.lines.push(stripCols(sc[0], n, sc[1]));
            } else {
              leaf.lines.push('');
            }
          } else {
            leaf.lines.push('');
          }
          if (leaf.k === 'html') leaf.lastIdx = idx;
          return 0;
        }
      }
      closeLeaf();
      // A blank line with no quote marker ends the innermost
      // blockquote, even when a list or list item sits above it on the
      // stack: the list inside the quote ends at the blank line, and a
      // following ">" line opens a fresh quote (marked splits
      // "> 1. one\n> 2. two\n\n> Warning" into two blockquotes).
      let q = -1;
      for (let g = stack.length - 1; g >= 1; g--) {
        if (stack[g].k === 'quote') { q = g; break; }
      }
      if (q >= 1) closeFramesFrom(q);
      else {
        while (stack.length > 1 && stack[stack.length - 1].k === 'quote') {
          closeFramesFrom(stack.length - 1);
        }
      }
      pendingBlank = true;
      blankInItem = true;
      return 0;
    }
    // Match open containers. remCol is the column of the original line
    // where rem starts, so tab widths stay measured from the original
    // line after every strip. matchedQuote records whether the line
    // carried a quote marker: a line that did is a line inside the quote
    // even when what follows the marker is blank.
    let rem = raw;
    let remCol = 0;
    let matchedQuote = false;
    let f = 1;
    while (f < stack.length) {
      const fr = stack[f];
      if (fr.k === 'quote') {
        const ind = colsOf(rem, 0, remCol);
        if (ind > 3) { if (tryLazy(rem, remCol)) return 0; closeFramesFrom(f); break; }
        const content = stripCols(rem, ind, remCol);
        const r = quotePrefix(content);
        if (r === null) { if (tryLazy(rem, remCol)) return 0; closeFramesFrom(f); break; }
        matchedQuote = true;
        // Tab expansion after a quote marker is measured from the
        // marker, not from the absolute column (see stripContainers).
        const qbase = ind + 1 + ((content.length > 1 && (content.charCodeAt(1) === 32 || content.charCodeAt(1) === 9)) ? 1 : 0);
        remCol += qbase;
        rem = r;
        rem = expandLeadingTabs(rem, qbase);
        f++;
        continue;
      }
      if (fr.k === 'list') { f++; continue; }
      if (fr.k === 'item') {
        const ind = colsOf(rem, 0, remCol);
        // An empty item that a blank line has intervened after cannot
        // gain content: the line is not part of it.
        if (ind >= fr.contentIndent && !(fr.empty && pendingBlank)) {
          rem = stripCols(rem, fr.contentIndent, remCol);
          remCol += fr.contentIndent;
          rem = expandLeadingTabs(rem, remCol);
          f++;
          continue;
        }
        // A sibling item marker? It is a sibling when its indent is
        // inside the current item's content indent (so it is not a
        // nested list) and within three spaces of the list's start.
        // A line that is a thematic break (e.g. "* * *") is a break,
        // not a new item, even though it starts with a list marker.
        if (ind < fr.contentIndent && ind <= stack[f - 1].indent + 3) {
          const content = stripCols(rem, ind, remCol);
          const lm = listMarker(content, remCol + ind);
          const listNode = stack[f - 1].node;
          if (lm && !isThematic(content) && listMatches(lm, listNode)) {
            closeFramesFrom(f);
            break;
          }
        }
        // Not content of this item and not a sibling: the line may still
        // be a lazy continuation of the item's paragraph.
        // A fenced code block inside a list item also keeps a plain-text
        // line that does not match the item's indent: it is a lazy
        // continuation of the code block (marked keeps such lines as code
        // content). A line that starts a block ends the item instead.
        // But only once the fence already has content: a non-indented
        // line directly after the fence opens ends the item, because
        // marked stops the item there (its fence-begin check on the
        // previous line fires) and the fence is left empty.
        if (leaf && leaf.k === 'fence' && leaf.lines.length > 0 && !isBlankStr(rem) && !startsAnyBlock(rem, remCol)) {
          leaf.lines.push(stripCols(rem, Math.min(colsOf(rem, 0, remCol), leaf.fenceIndent), remCol));
          return 0;
        }
        if (tryLazy(rem, remCol)) return 0;
        // A blank remainder that carried a quote marker is a blank line
        // inside the quote, not the end of the item.
        if (isBlankStr(rem) && matchedQuote) break;
        // Otherwise the item and its list both end here. Closing only the
        // item would leave the list frame on top of the stack, and
        // appending a block to a list frame crashes (a list has items,
        // not children).
        closeFramesFrom(f - 1);
        break;
      }
      f++;
    }
    // What is left after the containers is only spaces. When there are
    // spaces left (a quote marker followed by spaces, say) it is a line
    // of content, not a blank line: a paragraph keeps it as a line, code
    // keeps the spaces beyond its indent. A truly empty remainder is a
    // blank line inside the containers: it closes the leaf, but it does
    // not close a quote the line carried a marker for, and it does not
    // count as a blank line between list items.
    if (isBlankStr(rem)) {
      // A fenced code block keeps a blank line even when the remainder
      // is truly empty (a bare ">" line inside a quote, or a list marker
      // with nothing after it): it is a blank line of code content, not
      // the end of the fence.
      if (leaf && leaf.k === 'fence') {
        leaf.lines.push('');
        return 0;
      }
      if (rem.length > 0) {
        if (leaf && leaf.k === 'para') {
          leaf.lines.push(rem);
          leaf.lastLazy = false;
          return 0;
        }
        if (leaf && leaf.k === 'fence') {
          leaf.lines.push(stripCols(rem, Math.min(colsOf(rem, 0, remCol), leaf.fenceIndent), remCol));
          return 0;
        }
        if (leaf && leaf.k === 'icode') {
          leaf.lines.push(stripCols(rem, 4, remCol));
          return 0;
        }
        if (leaf && leaf.k === 'html' && leaf.type <= 5) {
          leaf.lines.push(rem);
          leaf.lastIdx = idx;
          return 0;
        }
      }
      closeLeaf();
      if (!matchedQuote) {
        while (stack.length > 1 && stack[stack.length - 1].k === 'quote') {
          closeFramesFrom(stack.length - 1);
        }
        pendingBlank = true;
      }
      blankInItem = true;
      // A blank line at the item's own level separates its items, even
      // when it only carried a quote marker; nested inside a quote
      // within the item it does not.
      const topFrame = stack[stack.length - 1];
      if (topFrame && (topFrame.k === 'item' || topFrame.k === 'list')) blankBetweenItems = true;
      return 0;
    }
    return processContent(rem, idx, remCol);
  }

  function listMatches(lm, listNode) {
    if (listNode.ordered !== lm.ordered) return false;
    if (lm.ordered) return listNode.delim === lm.delim;
    return listNode.bullet === lm.bullet;
  }

  function openListItem(lm, baseIndent, content) {
    // Find or create the list on top of the stack. A sibling item at a
    // different indent (within three spaces of the list's start, and
    // inside the previous item's content indent) rejoins the same list.
    let listFrame = null;
    if (stack.length > 1) {
      const top = stack[stack.length - 1];
      if (top.k === 'list' && baseIndent < top.lastContentIndent && baseIndent <= top.indent + 3 && listMatches(lm, top.node)) {
        listFrame = top;
      }
    }
    if (!listFrame) {
      const node = {
        k: 'list', ordered: lm.ordered, bullet: lm.ordered ? '' : lm.bullet,
        delim: lm.ordered ? lm.delim : '', start: lm.ordered ? lm.start : 1,
        loose: false, items: [],
      };
      listFrame = { k: 'list', node, indent: baseIndent };
      stack.push(listFrame);
    }
    // A blank line between items makes the list loose. That includes a
    // blank line that only carried a quote marker (a bare ">" line):
    // it still separates the items, even though it is a blank line
    // inside the quote rather than at the item's own level.
    if (pendingBlank || blankBetweenItems) {
      listFrame.node.loose = true;
      pendingBlank = false;
    }
    blankInItem = false;
    blankBetweenItems = false;
    const itemNode = { k: 'item', children: [], task: null };
    const itemFrame = {
      k: 'item', node: itemNode, baseIndent,
      contentIndent: baseIndent + lm.contentIndent, empty: lm.empty,
    };
    stack.push(itemFrame);
    listFrame.lastContentIndent = itemFrame.contentIndent;
    // Task list item: [ ] / [x] / [X] followed by a space and content.
    let rest = content;
    if (rest.length >= 4 && rest.charCodeAt(0) === 91) {
      const c1 = rest.charCodeAt(1);
      const c2 = rest.charCodeAt(2);
      if ((c1 === 32 || c1 === 120 || c1 === 88) && c2 === 93) {
        const after = rest.charCodeAt(3);
        if ((after === 32 || after === 9) && rest.slice(4).trim() !== '') {
          itemNode.task = (c1 === 32) ? 'unchecked' : 'checked';
          rest = rest.slice(3);
        }
      }
    }
    return rest;
  }

  function processContent(rem, idx, remCol) {
    let advance = 0;
    while (true) {
      if (leaf) {
        if (leaf.k === 'para') {
          const ind = colsOf(rem, 0, remCol);
          // Setext underline?
          if (ind <= 3) {
            const t = stripCols(rem, ind, remCol);
            const m = /^([=-]+)[ \t]*$/.exec(t);
            if (m) {
              const text = leaf.lines.join('\n');
              const level = m[1].charCodeAt(0) === 61 ? 1 : 2;
              leaf = null;
              appendNode({ k: 'head', level, text });
              return advance;
            }
          }
          // Table delimiter? The header is the paragraph's last line.
          if (ind <= 3) {
            const delim = parseDelimiter(stripCols(rem, ind, remCol));
            if (delim) {
              const lastLine = leaf.lines[leaf.lines.length - 1];
              const header = splitRow(lastLine);
              if (header.length === delim.length && header.length > 0) {
                leaf.lines.pop();
                if (leaf.lines.length > 0) appendNode({ k: 'para', lines: leaf.lines });
                leaf = { k: 'table', align: delim, head: header, rows: [] };
                return advance;
              }
            }
          }
          // Interrupting block?
          if (startsBlock(rem, true, remCol, stack.some((fr) => fr.k === 'item'))) {
            closeLeaf();
            continue;
          }
          leaf.lines.push(rem);
          leaf.lastLazy = false;
          return advance;
        }
        if (leaf.k === 'fence') {
          const ind = colsOf(rem, 0, remCol);
          if (ind <= 3) {
            const content = stripCols(rem, ind, remCol);
            let j = 0;
            while (j < content.length && content.charCodeAt(j) === leaf.fenceCh.charCodeAt(0)) j++;
            if (j >= leaf.fenceLen) {
              let rest = content.slice(j);
              if (isBlankStr(rest)) { closeLeaf(); return advance; }
            }
          }
          leaf.lines.push(stripCols(rem, Math.min(colsOf(rem, 0, remCol), leaf.fenceIndent), remCol));
          return advance;
        }
        if (leaf.k === 'icode') {
          const ind = colsOf(rem, 0, remCol);
          if (ind >= 4) {
            leaf.lines.push(stripCols(rem, 4, remCol));
            return advance;
          }
          closeLeaf();
          continue;
        }
        if (leaf.k === 'html') {
          leaf.lines.push(rem);
          leaf.lastIdx = idx;
          if (leaf.type <= 5) {
            const low = rem.toLowerCase();
            for (const m of leaf.endMarkers) {
              if (low.indexOf(m) >= 0) { closeLeaf(); return advance; }
            }
          }
          return advance;
        }
        if (leaf.k === 'table') {
          if (!startsBlock(rem, false, remCol)) {
            leaf.rows.push(splitRow(rem));
            return advance;
          }
          closeLeaf();
          continue;
        }
      }
      // No open leaf: start a new block.
      if (isBlankStr(rem)) return advance;
      const ind = colsOf(rem, 0, remCol);
      const content = ind <= 3 ? stripCols(rem, ind, remCol) : rem;
      if (ind <= 3) {
        // A sibling item of the list on top of the stack: it consumes the
        // pending blank line itself (its own list may go loose), and the
        // block it starts is not a new block of the enclosing item.
        const lm0 = listMarker(content, remCol + ind);
        if (lm0 && !isThematic(content)) {
          const top = stack[stack.length - 1];
          if (top.k === 'list' && ind < top.lastContentIndent && ind <= top.indent + 3 && listMatches(lm0, top.node)) {
            const rest = openListItem(lm0, ind, lm0.content);
            rem = rest;
            remCol = lm0.contentBase + (rest === lm0.content ? 0 : 3);
            continue;
          }
        }
      }
      noteBlockStart();
      if (ind <= 3) {
        const atx = atxMatch(content);
        if (atx) {
          appendNode({ k: 'head', level: atx.level, text: atx.text });
          return advance;
        }
        const fence = fenceMatch(content);
        if (fence) {
          const lang = unescape(fence.info.split(/[ \t]/, 1)[0] || '');
          leaf = {
            k: 'fence', fenceCh: fence.ch, fenceLen: fence.len,
            fenceIndent: ind, lang, lines: [],
          };
          return advance;
        }
        const html = htmlStart(content);
        if (html) {
          const linesArr = [rem];
          if (html.type <= 5) {
            const low = rem.toLowerCase();
            let closed = false;
            for (const m of html.endMarkers) {
              if (low.indexOf(m) >= 0) { closed = true; break; }
            }
            if (closed) {
              appendNode({ k: 'html', text: htmlTextOf(linesArr, idx) });
              return advance;
            }
          }
          leaf = { k: 'html', type: html.type, endMarkers: html.endMarkers || [], lines: linesArr, lastIdx: idx };
          return advance;
        }
        if (isThematic(content)) {
          appendNode({ k: 'hr' });
          return advance;
        }
        if (content.charCodeAt(0) === 62) {
          const r = quotePrefix(content);
          if (r !== null) {
            const node = { k: 'quote', children: [] };
            stack.push({ k: 'quote', node });
            remCol += ind + 1 + ((content.length > 1 && (content.charCodeAt(1) === 32 || content.charCodeAt(1) === 9)) ? 1 : 0);
            rem = r;
            continue;
          }
        }
        const lm = listMarker(content, remCol + ind);
        if (lm) {
          const rest = openListItem(lm, ind, lm.content);
          rem = rest;
          remCol = lm.contentBase + (rest === lm.content ? 0 : 3);
          continue;
        }
      }
      if (ind >= 4) {
        leaf = { k: 'icode', lang: '', lines: [stripCols(rem, 4, remCol)] };
        return advance;
      }
      // Link reference definition? A definition may span lines: the
      // destination and the title can each be on a following line, and a
      // title can span lines, so gather the following lines' remainders.
      {
        let defSrc = content;
        for (let k = idx + 1; k < lines.length && k < idx + 12; k++) {
          const sc = stripContainers(lines[k]);
          if (!sc) break;
          defSrc += '\n' + sc[0];
        }
        const def = tryDef(defSrc);
        if (def) {
          if (!refs.has(def.key)) refs.set(def.key, { href: def.href, title: def.title });
          advance = def.lines - 1;
          return advance;
        }
      }
      // Paragraph.
      leaf = { k: 'para', lines: [rem], lastLazy: false };
      return advance;
    }
  }

  function htmlTextOf(linesArr, lastIdx) {
    let text = linesArr.join('\n');
    if (hasNL(lastIdx)) text += '\n';
    if (lastIdx + 1 < lines.length) {
      const nextLine = lines[lastIdx + 1];
      // Only a truly empty next line counts as blank here: a line of
      // spaces or tabs keeps the newline.
      if (nextLine.length === 0 || stripContainers(nextLine) === null) {
        if (text.endsWith('\n')) text = text.slice(0, -1);
      }
    }
    return text;
  }

  for (let i = 0; i < lines.length; i++) {
    i += processLine(lines[i], i);
  }
  closeFramesFrom(1);
  return root.children;
}

export function parse(src) {
  if (typeof src !== 'string') src = String(src);
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  let trailingNL = false;
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
    trailingNL = true;
  }
  const refs = new Map();
  docInLink = false;
  const nodes = parseBlocks(lines, trailingNL, refs);
  const out = [];
  for (const nd of nodes) renderBlock(nd, refs, out);
  return out.join('');
}
