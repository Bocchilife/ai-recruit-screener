import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseResumeBuffer, ParseError } from '../server/pipeline/resume-parse.js';

const SAMPLES = path.resolve(import.meta.dirname, '..', 'samples');

const read = (name) => fs.readFileSync(path.join(SAMPLES, name));

test('PDF 简历能抽出文本与字数', async () => {
  const r = await parseResumeBuffer(read('01-张思远-AI工作流强匹配.pdf'), '01.pdf');
  assert.equal(r.kind, 'pdf');
  assert.ok(r.chars > 300);
  assert.match(r.text, /张思远/);
  assert.ok(r.pages >= 1);
});

test('扫描件没有文本层时抛出 SCANNED_PDF，而不是返回半份空简历', async () => {
  await assert.rejects(
    () => parseResumeBuffer(read('07-扫描件简历-需OCR.pdf'), '07.pdf'),
    (err) => {
      assert.ok(err instanceof ParseError);
      assert.equal(err.code, 'SCANNED_PDF');
      assert.match(err.hint, /OCR/); // hint 要告诉用户下一步该做什么
      return true;
    },
  );
});

test('纯文本简历（站内消息）按 text 读入', async () => {
  const r = await parseResumeBuffer(read('09-孙悦-站内消息.txt'), '09.txt');
  assert.equal(r.kind, 'txt');
  assert.match(r.text, /孙悦/);
});

test('不支持的格式给出明确错误', async () => {
  await assert.rejects(
    () => parseResumeBuffer(Buffer.from('name,age\n'), 'a.csv'),
    (err) => err instanceof ParseError && /不支持/.test(err.message),
  );
});

test('全部样例里只有扫描件解析失败', async () => {
  const files = fs.readdirSync(SAMPLES).sort();
  const results = [];
  for (const f of files) {
    try {
      const r = await parseResumeBuffer(read(f), f);
      results.push({ file: f, ok: true, chars: r.chars });
    } catch (err) {
      results.push({ file: f, ok: false, code: err.code });
    }
  }
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].file, /扫描件/);
  assert.equal(failed[0].code, 'SCANNED_PDF');
});
