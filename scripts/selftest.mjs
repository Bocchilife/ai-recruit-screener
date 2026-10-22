/**
 * 现场自检：不起服务，直接把样例简历跑完"解析 → 判定 → 打分"全流程并打印结果。
 * 面试前 10 秒确认：文件没坏、pdfjs 能跑、打分逻辑正常。运行：npm run demo:check
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, currentMode } from '../server/config.js';
import { SAMPLE_JD } from '../server/llm/prompts.js';
import { decomposeJD } from '../server/pipeline/jd.js';
import { parseResumeBuffer } from '../server/pipeline/resume-parse.js';
import { ruleProfile, ruleSummary, ruleVerdicts, scoreCandidate, verifyEvidence } from '../server/scoring/rules.js';

const pad = (s, n) => {
  const str = String(s);
  const width = [...str].reduce((w, ch) => w + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
};

async function main() {
  console.log(`\n自检开始 | 模式：${currentMode()}\n`);

  const jd = await decomposeJD(SAMPLE_JD);
  console.log(`岗位：${jd.role}（拆解方式：${jd.mode}）`);
  console.log(`评估项 ${jd.rubrics.length} 条：`);
  for (const r of jd.rubrics) console.log(`  ${pad(r.group, 8)} ${pad(r.weight, 3)} ${r.label}`);
  if (jd.warning) console.log(`  ⚠ ${jd.warning}`);
  console.log();

  const files = fs
    .readdirSync(config.samplesDir)
    .filter((f) => /\.(pdf|docx|txt)$/i.test(f))
    .sort();

  const rows = [];
  for (const name of files) {
    const buffer = fs.readFileSync(path.join(config.samplesDir, name));
    try {
      const parsed = await parseResumeBuffer(buffer, name);
      const profile = ruleProfile(parsed.text);
      const verdicts = ruleVerdicts(jd.rubrics, { rawText: parsed.text, profile });
      const score = scoreCandidate(jd.rubrics, verdicts);
      const items = score.items.map((i) => ({ ...i, evidence: verifyEvidence(i.evidenceRaw, parsed.text).evidence }));
      const summary = ruleSummary({ role: jd.role, profile, score });
      rows.push({
        file: name,
        name: profile.name,
        chars: parsed.chars,
        pct: score.confirmedPct,
        cov: score.coveragePct,
        decision: score.decision.label,
        stats: `合${score.stats.met}/部${score.stats.partial}/不${score.stats.missing}/待${score.stats.unknown}`,
        mustMissing: score.mustMissing.map((i) => i.label).join('、') || '-',
        q: summary.questions.length,
        evOk: items.filter((i) => i.evidence.length > 0 && i.evidence.every((e) => e.verified)).length,
      });
    } catch (err) {
      rows.push({ file: name, name: '—', error: `${err.code || 'ERR'}: ${err.message}` });
    }
  }

  console.log(`${pad('文件', 34)}${pad('姓名', 12)}${pad('字', 6)}${pad('匹配%', 7)}${pad('覆盖%', 7)}${pad('结论', 26)}判定分布`);
  console.log('-'.repeat(110));
  for (const r of rows) {
    if (r.error) {
      console.log(`${pad(r.file, 34)}${pad('解析失败', 12)} ${r.error}`);
      continue;
    }
    console.log(
      `${pad(r.file, 34)}${pad(r.name, 12)}${pad(r.chars, 6)}${pad(r.pct, 7)}${pad(r.cov, 7)}${pad(r.decision, 26)}${r.stats}`,
    );
  }
  console.log();
  for (const r of rows) {
    if (!r.error && r.mustMissing !== '-') console.log(`  · ${r.file} 硬性缺口：${r.mustMissing}`);
  }

  const ok = rows.filter((r) => !r.error).length;
  console.log(`\n✓ 自检完成：${ok}/${rows.length} 份解析成功`);
  if (ok < rows.length) {
    // 07 是故意放进来的扫描件，解析失败属于预期；这里只提示，不算失败
    console.log('  （扫描件读不出文本是预期结果，用来演示"读不出来的简历会被单独标出"）\n');
  }
  const fatal = rows.some((r) => r.error && !/SCANNED_PDF|DOC_UNSUPPORTED|TOO_SHORT/.test(String(r.error.code || r.error)));
  process.exit(fatal ? 1 : 0);
}

main().catch((err) => {
  console.error('自检失败：', err);
  process.exit(1);
});
