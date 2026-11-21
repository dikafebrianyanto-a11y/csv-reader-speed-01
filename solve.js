// csv-reader-fast: a faster drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. The reading rules are csv-reader's own (see the kit's
// RULES.txt): a U+FEFF at the start is dropped; a record ends at LF or CRLF; a line
// left with no characters is no record; a CR outside quotes that is not followed by
// LF is dropped (stray_cr); a field opening with a quote runs to the next quote that
// is not doubled ("" inside is one quote; CRLF or a lone CR inside reads as LF);
// what follows the closing quote up to the next comma or line break is appended as
// it stands (quote_junk, when the field ends); a quote that never closes is a
// literal character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal character.
// Fields stay strings, never trimmed or converted. columns is the first record when
// header is true, else null; rows holds the records after it, each padded with ""
// (short_row) or cut (long_row) to the first record's width. Each error is
// {code, line, row}, in the order met; line is the 1-based line its record starts
// on, row its record's index in rows (null for the header).
//
// Speed comes from never reading the text one character at a time and never
// running a regex: the common record (no quotes, no stray CR) is split by native
// String.split after one indexOf finds its line end, and every other field jumps
// to its next delimiter with indexOf scans. An unquoted field ends at the nearer
// of the next comma and the next LF, and a stray CR inside it is found by one
// short indexOf on the field's own slice. A quoted field's close is found by
// indexOf('"') skipping doubled quotes, and its content is one slice unless it
// holds doubled quotes or a line break. Only a quoted field holding doubled
// quotes or a line break, and an unquoted field holding a stray CR, fall back to
// a short character loop, and those are a few percent of fields.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // One scan up front: a file with no quote or no CR at all can skip the
  // per-record checks below (and a file with no CR can never meet a stray CR).
  const anyQuote = text.indexOf('"') !== -1;
  const anyCR = text.indexOf('\r') !== -1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // The next line break, and whether this record is a plain one: no quote
    // before it, and no CR but the CRLF's own just before it.
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = n;
    let plain = false;
    if (!anyQuote && !anyCR) {
      plain = true;
    } else {
      let hasQuote = false;
      let hasMidCR = false;
      if (anyQuote) {
        const q = text.indexOf('"', pos);
        hasQuote = q !== -1 && q < lineEnd;
      }
      if (anyCR) {
        const r = text.indexOf('\r', pos);
        hasMidCR = r !== -1 && (lineEnd === n || r < lineEnd - 1);
      }
      plain = !hasQuote && !hasMidCR;
    }

    let fields;
    let ended;
    let quoted = false;
    // The next LF at or after this record's start, for the unquoted scan to
    // reuse: it stays the record's line end until a quoted field spans a line
    // break inside it, which is the only way a field crosses it.
    let recNL = lineEnd;
    let nlStale = false;
    if (plain) {
      // A plain record: split its line on commas in one native call. A CRLF
      // ending leaves its CR out of the segment; a lone CR at the very end of
      // the text is not plain (hasMidCR above), so it never reaches here.
      let segEnd = lineEnd;
      if (lineEnd !== n && text.charCodeAt(lineEnd - 1) === 13) segEnd = lineEnd - 1;
      fields = text.slice(pos, segEnd).split(',');
      if (lineEnd === n) {
        pos = n;
        ended = END;
      } else {
        pos = lineEnd + 1;
        line += 1;
        ended = LINE_BREAK;
      }
    } else {
      fields = [];
      do {
        let value;
        let checkJunk = false;
        if (text.charCodeAt(pos) === 34) {
          // A field that opens with a quote: its close is the next quote that
          // is not doubled (a quote followed by another quote is one quote).
          const open = pos;
          const openLine = line;
          let close = text.indexOf('"', pos + 1);
          let doubled = false;
          while (close !== -1 && text.charCodeAt(close + 1) === 34) {
            doubled = true;
            close = text.indexOf('"', close + 2);
          }
          if (close === -1) {
            // The quote never closes: it is a literal character, and the text
            // after it is read again as unquoted (unterminated_quote).
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            line = openLine;
            value = '"';
            quoted = true;
          } else {
            const content = text.slice(open + 1, close);
            const hasNL = content.indexOf('\n') !== -1;
            const hasCR = content.indexOf('\r') !== -1;
            if (hasNL) nlStale = true;
            let clean = content;
            if (doubled || hasNL || hasCR) {
              // Doubled quotes collapse to one, and each CRLF or lone CR
              // inside reads as one LF (counting the line it ends). The
              // stretches between them are copied as whole slices, not one
              // character at a time.
              clean = '';
              let i = 0;
              let segStart = 0;
              const m = content.length;
              while (i < m) {
                const c = content.charCodeAt(i);
                if (c === 34) {
                  clean += content.slice(segStart, i) + '"';
                  i += 2;
                  segStart = i;
                } else if (c === 13) {
                  clean += content.slice(segStart, i) + '\n';
                  line += 1;
                  i += content.charCodeAt(i + 1) === 10 ? 2 : 1;
                  segStart = i;
                } else if (c === 10) {
                  clean += content.slice(segStart, i) + '\n';
                  line += 1;
                  i += 1;
                  segStart = i;
                } else {
                  i += 1;
                }
              }
              clean += content.slice(segStart);
            }
            pos = close + 1;
            quoted = true;
            if (pos >= n) {
              fields.push(clean);
              ended = END;
              continue;
            }
            const c = text.charCodeAt(pos);
            if (c === 44) {
              fields.push(clean);
              pos += 1;
              ended = COMMA;
              continue;
            }
            if (c === 10) {
              fields.push(clean);
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
              continue;
            }
            if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              fields.push(clean);
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
              continue;
            }
            // What follows the closing quote is appended as it stands, up to
            // the next comma or line break (quote_junk, when the field ends).
            value = clean;
            checkJunk = true;
          }
        } else {
          value = '';
          quoted = false;
        }
        // Read unquoted characters onto `value` up to the next comma or line
        // break: the field ends at the nearer of the two, and a CR inside it
        // that is not the CRLF's own is dropped (stray_cr). The line end is
        // the record's own, recomputed only after a quoted field spanned it.
        if (nlStale) {
          recNL = text.indexOf('\n', pos);
          if (recNL === -1) recNL = n;
          nlStale = false;
        }
        const comma = text.indexOf(',', pos);
        let end;
        if (comma !== -1 && comma < recNL) {
          end = comma;
          ended = COMMA;
        } else if (recNL !== n) {
          end = recNL;
          ended = LINE_BREAK;
        } else {
          end = n;
          ended = END;
        }
        let segEnd = end;
        if (ended === LINE_BREAK && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
        const seg = text.slice(pos, segEnd);
        const cr = anyCR ? seg.indexOf('\r') : -1;
        if (cr === -1) {
          value += seg;
          if (checkJunk) {
            if (seg.length > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
          pos = ended === COMMA ? end + 1 : ended === LINE_BREAK ? end + 1 : n;
          if (ended === LINE_BREAK) line += 1;
        } else {
          // A stray CR (or several) inside the field: drop each one, count
          // the error, and keep the rest as it stands.
          let stray = 0;
          for (let j = 0, m = seg.length; j < m; j++) {
            if (seg.charCodeAt(j) === 13) stray += 1;
          }
          for (let k = 0; k < stray; k++) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          const kept = seg.replaceAll('\r', '');
          value += kept;
          if (checkJunk && kept.length > 0) {
            errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
          pos = ended === COMMA ? end + 1 : ended === LINE_BREAK ? end + 1 : n;
          if (ended === LINE_BREAK) line += 1;
        }
        fields.push(value);
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
