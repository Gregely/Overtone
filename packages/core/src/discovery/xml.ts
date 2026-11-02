/**
 * A small, dependency-free XML parser for the Torznab/RSS subset that
 * Prowlarr, Jackett and Torznab indexers emit. It produces a plain element
 * tree (no DTD, no external entities, no XInclude) so it is safe against XXE
 * and runs identically in Node and the browser.
 *
 * It is intentionally not a general-purpose XML parser: it does not resolve
 * namespaces, and it concatenates all text (including CDATA) into one string.
 * Attribute and element names keep their namespace prefix (e.g. "torznab:attr")
 * so callers can match the Torznab attributes by local name.
 */

export interface XmlElement {
  /** Qualified name, e.g. "item" or "torznab:attr". */
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data and CDATA of this element. */
  text: string;
}

const NAME = /[A-Za-z_][A-Za-z0-9._:-]*/;

/** Local name without a namespace prefix ("torznab:attr" → "attr"). */
export function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/** First child whose local name matches. */
export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => localName(c.name) === name);
}

/** All children whose local name matches. */
export function children(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => localName(c.name) === name);
}

/** Attribute value looked up by local name (case-sensitive, like XML). */
export function attr(el: XmlElement, name: string): string | undefined {
  for (const [k, v] of Object.entries(el.attributes)) if (localName(k) === name) return v;
  return undefined;
}

/** Trimmed text content of the first matching child, or undefined. */
export function childText(el: XmlElement, name: string): string | undefined {
  const c = child(el, name);
  return c ? c.text.trim() : undefined;
}

export function parseXml(input: string): XmlElement {
  const p = new Parser(input);
  return p.parse();
}

class Parser {
  readonly #s: string;
  #i = 0;

  constructor(s: string) {
    this.#s = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }

  parse(): XmlElement {
    const root = this.#element();
    return root;
  }

  #skipWs(): void {
    while (this.#i < this.#s.length && isWs(this.#s[this.#i]!)) this.#i++;
  }

  #peek(): string | undefined {
    return this.#s[this.#i];
  }

  #starts(s: string): boolean {
    return this.#s.startsWith(s, this.#i);
  }

  /** Skip a declaration, comment, or other <!...> / <?...> construct. */
  #skipMisc(): void {
    for (;;) {
      this.#skipWs();
      if (this.#starts('<?')) {
        this.#seek('?>');
        this.#i += 2;
      } else if (this.#starts('<!')) {
        this.#seek('>');
        this.#i += 1;
      } else {
        return;
      }
    }
  }

  #seek(s: string): void {
    const j = this.#s.indexOf(s, this.#i);
    if (j < 0) throw new Error('Malformed XML: unterminated construct');
    this.#i = j;
  }

  #element(): XmlElement {
    this.#skipMisc();
    if (this.#peek() !== '<') throw new Error('Malformed XML: expected an element');
    this.#i++; // '<'
    this.#skipWs();
    const m = NAME.exec(this.#s.slice(this.#i));
    if (!m) throw new Error('Malformed XML: bad tag name');
    const name = m[0]!;
    this.#i += name.length;

    const attributes: Record<string, string> = {};
    for (;;) {
      this.#skipWs();
      const c = this.#peek();
      if (c === '>' || c === '/' || c === undefined) break;
      const am = NAME.exec(this.#s.slice(this.#i));
      if (!am) throw new Error('Malformed XML: bad attribute name');
      const an = am[0]!;
      this.#i += an.length;
      this.#skipWs();
      if (this.#peek() !== '=') throw new Error('Malformed XML: expected "="');
      this.#i++;
      this.#skipWs();
      const q = this.#peek();
      if (q !== '"' && q !== "'") throw new Error('Malformed XML: unquoted attribute');
      this.#i++;
      const end = this.#s.indexOf(q, this.#i);
      if (end < 0) throw new Error('Malformed XML: unterminated attribute');
      attributes[an] = decodeEntities(this.#s.slice(this.#i, end));
      this.#i = end + 1;
    }

    const el: XmlElement = { name, attributes, children: [], text: '' };

    if (this.#peek() === '/') {
      // self-closing
      this.#i++;
      this.#expectClose();
      return el;
    }
    if (this.#peek() !== '>') throw new Error('Malformed XML: expected ">"');
    this.#i++; // '>'

    for (;;) {
      const c = this.#peek();
      if (c === undefined) throw new Error('Malformed XML: unexpected end of input');
      if (c !== '<') {
        const j = this.#s.indexOf('<', this.#i);
        el.text += decodeEntities(this.#s.slice(this.#i, j < 0 ? this.#s.length : j));
        this.#i = j < 0 ? this.#s.length : j;
        continue;
      }
      if (this.#starts('</')) {
        this.#i += 2;
        this.#skipWs();
        const cm = NAME.exec(this.#s.slice(this.#i));
        if (!cm || cm[0] !== name) throw new Error(`Malformed XML: mismatched close tag (expected </${name}>)`);
        this.#i += cm[0].length;
        this.#skipWs();
        if (this.#peek() !== '>') throw new Error('Malformed XML: expected ">"');
        this.#i++;
        return el;
      }
      if (this.#starts('<!--')) {
        this.#seek('-->');
        this.#i += 3;
        continue;
      }
      if (this.#starts('<![CDATA[')) {
        this.#i += 9;
        const j = this.#s.indexOf(']]>', this.#i);
        if (j < 0) throw new Error('Malformed XML: unterminated CDATA');
        el.text += this.#s.slice(this.#i, j);
        this.#i = j + 3;
        continue;
      }
      if (this.#starts('<?') || this.#starts('<!')) {
        this.#skipMisc();
        continue;
      }
      el.children.push(this.#element());
    }
  }

  #expectClose(): void {
    this.#skipWs();
    if (this.#peek() !== '>') throw new Error('Malformed XML: expected ">"');
    this.#i++;
  }
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Decode the five XML predefined entities, &nbsp;, and numeric references. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body] ?? whole;
  });
}
