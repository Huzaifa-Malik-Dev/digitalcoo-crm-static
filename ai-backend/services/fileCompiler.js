const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { filesDir } = require('../config/env');

const filesRoot = path.join(__dirname, '..', filesDir);
if (!fs.existsSync(filesRoot)) fs.mkdirSync(filesRoot, { recursive: true });

// Hand-rolled and narrow rather than a general CommonMark parser - the prompts in
// aiReportController.js only ever ask the model for '#'/'##'/'###' headings, plain paragraphs,
// and '-'/'1.' lists with occasional **bold** spans, so that's all this needs to recognize. Any
// line that doesn't match one of those falls through to a plain paragraph, so nothing is ever
// dropped even if the model drifts from the expected shape - worst case a stray '#' or '-'
// appears literally, which is what every format did for every line before this.
function parseInlineSpans(line) {
  const spans = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index), bold: false });
    spans.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < line.length) spans.push({ text: line.slice(last), bold: false });
  return spans.length ? spans : [{ text: line, bold: false }];
}

const BULLET_RE = /^\s*[-*]\s+/;
const NUMBERED_RE = /^\s*\d+[.)]\s+/;

// Collects consecutive list-item lines starting at `start`, tolerating a blank line *between*
// items (the model frequently puts one there, e.g. between numbered recommendations) without
// treating it as the end of the list - only a blank line NOT followed by another item line ends
// it. Returns the parsed items and the index to resume scanning from.
function collectListItems(lines, start, itemRe) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && itemRe.test(lines[j])) {
        i = j;
        continue;
      }
      break;
    }
    if (!itemRe.test(lines[i])) break;
    items.push(parseInlineSpans(lines[i].replace(itemRe, '').trim()));
    i++;
  }
  return { items, next: i };
}

function parseBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s*(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseInlineSpans(heading[2].trim()) });
      i++;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const { items, next } = collectListItems(lines, i, BULLET_RE);
      blocks.push({ type: 'bullet', items });
      i = next;
      continue;
    }

    if (NUMBERED_RE.test(line)) {
      const { items, next } = collectListItems(lines, i, NUMBERED_RE);
      blocks.push({ type: 'numbered', items });
      i = next;
      continue;
    }

    // Plain paragraph - the model often hard-wraps prose at some column; join consecutive lines
    // into one flowing block instead of preserving those arbitrary mid-sentence breaks.
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i]) && !BULLET_RE.test(lines[i]) && !NUMBERED_RE.test(lines[i])) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', spans: parseInlineSpans(paraLines.join(' ')) });
  }
  return blocks;
}

// Re-serializes the parsed blocks back into clean, consistently-spaced markdown (blank line
// between every block, uniform '- '/'1.' markers) - the .md download is then guaranteed
// well-formed regardless of whatever inconsistent spacing the model actually produced.
function blocksToMarkdown(blocks) {
  const spansToMd = (spans) => spans.map((s) => (s.bold ? `**${s.text}**` : s.text)).join('');
  const out = [];
  for (const block of blocks) {
    if (block.type === 'heading') out.push(`${'#'.repeat(block.level)} ${spansToMd(block.spans)}`);
    else if (block.type === 'paragraph') out.push(spansToMd(block.spans));
    else if (block.type === 'bullet') block.items.forEach((spans) => out.push(`- ${spansToMd(spans)}`));
    else if (block.type === 'numbered') block.items.forEach((spans, idx) => out.push(`${idx + 1}. ${spansToMd(spans)}`));
    out.push('');
  }
  return `${out.join('\n').trim()}\n`;
}

async function compileMd(jobId, text) {
  const fileName = `${jobId}.md`;
  fs.writeFileSync(path.join(filesRoot, fileName), blocksToMarkdown(parseBlocks(text)), 'utf8');
  return fileName;
}

const PDF_HEADING_SIZE = { 1: 16, 2: 14, 3: 12 };

// Renders a run of {text, bold} spans as one continuous line, switching between the regular and
// bold face per span (pdfkit has no single-call "rich text" - chaining `continued: true` calls is
// its documented way to mix styles within one line).
function renderPdfSpans(doc, spans, textOpts) {
  spans.forEach((span, idx) => {
    doc.font(span.bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(span.text, { ...textOpts, continued: idx < spans.length - 1 });
  });
}

// Temporarily widens the left margin so a bullet/number prefix reads as a proper hanging indent -
// including on wrapped continuation lines, which a one-off `indent` option on a single `.text()`
// call would not cover.
function withLeftIndent(doc, amount, fn) {
  const original = doc.page.margins.left;
  doc.page.margins.left = original + amount;
  doc.x = doc.page.margins.left;
  fn();
  doc.page.margins.left = original;
}

async function compilePdf(jobId, text, title) {
  const fileName = `${jobId}.pdf`;
  const filePath = path.join(filesRoot, fileName);
  const doc = new PDFDocument({ margin: 56 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.font('Helvetica-Bold').fontSize(20).text(title, { underline: true });
  doc.moveDown(1);

  for (const block of parseBlocks(text)) {
    if (block.type === 'heading') {
      doc.moveDown(0.6);
      doc.fontSize(PDF_HEADING_SIZE[block.level] || 12);
      // Headings are always bold regardless of whether the model wrapped the text in **bold** -
      // the heading level itself, not inline markdown, is what makes it a heading.
      renderPdfSpans(doc, block.spans.map((s) => ({ ...s, bold: true })), { lineGap: 2 });
      doc.moveDown(0.3);
    } else if (block.type === 'paragraph') {
      doc.fontSize(11);
      renderPdfSpans(doc, block.spans, { align: 'left', lineGap: 3 });
      doc.moveDown(0.5);
    } else if (block.type === 'bullet') {
      doc.fontSize(11);
      block.items.forEach((spans) => {
        withLeftIndent(doc, 14, () => {
          doc.font('Helvetica').text('•  ', { continued: true });
          renderPdfSpans(doc, spans, { lineGap: 2 });
        });
      });
      doc.moveDown(0.5);
    } else if (block.type === 'numbered') {
      doc.fontSize(11);
      block.items.forEach((spans, idx) => {
        withLeftIndent(doc, 18, () => {
          doc.font('Helvetica').text(`${idx + 1}.  `, { continued: true });
          renderPdfSpans(doc, spans, { lineGap: 2 });
        });
      });
      doc.moveDown(0.5);
    }
  }

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  return fileName;
}

const XLSX_HEADING_SIZE = { 1: 14, 2: 13, 3: 12 };
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };

function spansToRichText(spans, baseFont) {
  return spans.map((s) => ({ text: s.text, font: { ...baseFont, bold: s.bold || !!baseFont.bold } }));
}

// Fallback only - renders the LLM narrative the old way, one wide text column. Used solely if an
// xlsx job somehow has no `tables` data attached, so the file is never just empty.
function compileXlsxFromNarrative(sheet, text, title) {
  sheet.columns = [{ key: 'content', width: 110 }];
  const titleRow = sheet.addRow({ content: title });
  titleRow.font = { bold: true, size: 16 };
  sheet.addRow({});

  for (const block of parseBlocks(text)) {
    if (block.type === 'heading') {
      const row = sheet.addRow({ content: { richText: spansToRichText(block.spans, { bold: true, size: XLSX_HEADING_SIZE[block.level] || 12 }) } });
      row.alignment = { wrapText: true };
    } else if (block.type === 'paragraph') {
      const row = sheet.addRow({ content: { richText: spansToRichText(block.spans, { size: 11 }) } });
      row.alignment = { wrapText: true };
    } else if (block.type === 'bullet') {
      block.items.forEach((spans) => {
        const row = sheet.addRow({ content: { richText: [{ text: '•  ', font: { size: 11 } }, ...spansToRichText(spans, { size: 11 })] } });
        row.alignment = { wrapText: true, indent: 1 };
      });
    } else if (block.type === 'numbered') {
      block.items.forEach((spans, idx) => {
        const row = sheet.addRow({ content: { richText: [{ text: `${idx + 1}.  `, font: { size: 11 } }, ...spansToRichText(spans, { size: 11 })] } });
        row.alignment = { wrapText: true, indent: 1 };
      });
    }
    sheet.addRow({});
  }
}

// The real xlsx path - `tables` is { tables: [{ title, columns: [string,...], rows: [[...],...] }] },
// built server-side by the CRM app from the same structured stats the narrative prompt is built
// from (see aiReportController.js's buildXTable functions). A spreadsheet of prose defeats the
// point of it being a spreadsheet, so this never touches the LLM narrative at all - real numbers
// in real columns, one block per table with its own header row.
function compileXlsxFromTables(sheet, title, tables) {
  const maxCols = Math.max(1, ...tables.map((t) => (t.columns || []).length));
  sheet.columns = Array.from({ length: maxCols }, () => ({ width: 26 }));

  const titleRow = sheet.addRow([title]);
  titleRow.font = { bold: true, size: 16 };
  sheet.addRow([]);

  for (const table of tables) {
    const tableTitleRow = sheet.addRow([table.title]);
    tableTitleRow.font = { bold: true, size: 13 };

    const headerRow = sheet.addRow(table.columns);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFB0B0B0' } } };
    });

    (table.rows || []).forEach((values) => {
      const row = sheet.addRow(values);
      row.alignment = { wrapText: true, vertical: 'top' };
    });

    sheet.addRow([]);
  }
}

async function compileXlsx(jobId, text, title, tables) {
  const fileName = `${jobId}.xlsx`;
  const filePath = path.join(filesRoot, fileName);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');

  if (tables && Array.isArray(tables.tables) && tables.tables.length) {
    compileXlsxFromTables(sheet, title, tables.tables);
  } else {
    compileXlsxFromNarrative(sheet, text, title);
  }

  await workbook.xlsx.writeFile(filePath);
  return fileName;
}

async function compile(jobId, format, text, title, tables) {
  if (format === 'pdf') return compilePdf(jobId, text, title);
  if (format === 'xlsx') return compileXlsx(jobId, text, title, tables);
  return compileMd(jobId, text);
}

module.exports = { compile, filesRoot };
