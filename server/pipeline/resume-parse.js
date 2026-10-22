import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';

export class ParseError extends Error {
  constructor(message, { code = 'PARSE_ERROR', hint = '' } = {}) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
    this.hint = hint;
  }
}

const MIN_CHARS = 60;

/** PDF：用 pdfjs 提取文本层。没有文本层 = 扫描件，明确报错而不是静默返回空。 */
export async function extractPdfText(buffer) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
      page.cleanup();
    }
    return { text: pages.join('\n\n').replace(/\n{3,}/g, '\n\n').trim(), pages: doc.numPages };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

export async function extractDocxText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return { text: String(value || '').trim() };
}

/**
 * 统一入口：文件名 → 文本。支持 .pdf / .docx / .txt / .md
 * @returns {Promise<{text:string, kind:string, chars:number, pages?:number}>}
 */
export async function parseResumeBuffer(buffer, fileName = '') {
  const ext = path.extname(fileName).toLowerCase();

  if (!buffer || buffer.length === 0) {
    throw new ParseError('文件内容为空', { code: 'EMPTY_FILE' });
  }

  if (ext === '.pdf') {
    let result;
    try {
      result = await extractPdfText(buffer);
    } catch (err) {
      throw new ParseError(`PDF 解析失败：${err.message}`, { code: 'PDF_BROKEN' });
    }
    if (result.text.length < MIN_CHARS) {
      throw new ParseError('这份 PDF 没有文本层（疑似扫描件/图片导出）', {
        code: 'SCANNED_PDF',
        hint: '需要 OCR 才能读取，可以先用文本版简历或手动粘贴内容',
      });
    }
    return { text: result.text, kind: 'pdf', chars: result.text.length, pages: result.pages };
  }

  if (ext === '.docx') {
    try {
      const { text } = await extractDocxText(buffer);
      if (text.length < MIN_CHARS) {
        throw new ParseError('Word 文档内容过少，可能不是简历正文', { code: 'DOCX_EMPTY' });
      }
      return { text, kind: 'docx', chars: text.length };
    } catch (err) {
      if (err instanceof ParseError) throw err;
      throw new ParseError(`Word 解析失败：${err.message}`, { code: 'DOCX_BROKEN' });
    }
  }

  if (ext === '.doc') {
    throw new ParseError('不支持旧版 .doc 格式', {
      code: 'DOC_UNSUPPORTED',
      hint: '请用 Word 另存为 .docx 后重试',
    });
  }

  if (ext === '.txt' || ext === '.md' || ext === '') {
    const text = buffer.toString('utf8').trim();
    if (text.length < MIN_CHARS) {
      throw new ParseError('文本内容过短，无法作为简历分析', { code: 'TXT_EMPTY' });
    }
    return { text, kind: 'txt', chars: text.length };
  }

  throw new ParseError(`不支持的文件类型：${ext}`, {
    code: 'UNSUPPORTED_TYPE',
    hint: '目前支持 PDF / DOCX / TXT',
  });
}
