import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide,
  scoreCandidate,
  verifyEvidence,
  hasAffirmative,
  buildQuestions,
  ruleVerdictFor,
  detectAvailability,
} from '../server/scoring/rules.js';

const R = (id, group, over = {}) => ({
  id,
  group,
  type: 'skill',
  label: `要求 ${id}`,
  weight: 8,
  ...over,
});

// ---------------------------------------------------------------------------
// 结论短路：顺序本身就是业务规则，改顺序等于改产品
// ---------------------------------------------------------------------------

test('判定顺序：红线 > 多项硬性不满足 > 信息不足 > 单项硬性不满足', () => {
  const base = { confirmed: 0.9, coverage: 1, mustMissing: [], mustPartial: [], mustUnknown: [] };

  assert.equal(decide({ ...base, redlineHits: [{ label: '不接受远程' }] }).code, 'reject');

  const twoMissing = decide({ ...base, mustMissing: [{ label: 'A' }, { label: 'B' }] });
  assert.equal(twoMissing.code, 'reject');
  assert.match(twoMissing.reason, /2 项明确不满足/);

  // 覆盖率过低排在"单项硬性不满足"之前：信息太少时不该下"不满足"的结论
  const thin = decide({ ...base, confirmed: 0.2, coverage: 0.3, mustMissing: [{ label: 'A' }] });
  assert.equal(thin.code, 'insufficient');
});

test('单项硬性不满足：看整体匹配度决定暂缓还是待定', () => {
  const base = { coverage: 1, mustPartial: [], mustUnknown: [] };
  assert.equal(decide({ ...base, confirmed: 0.3, mustMissing: [{ label: 'A' }] }).code, 'reject');
  assert.equal(decide({ ...base, confirmed: 0.6, mustMissing: [{ label: 'A' }] }).code, 'pending');
});

test('只有全部无缺口才给"建议进入人工复核"', () => {
  const perfect = { confirmed: 0.82, coverage: 1, mustMissing: [], mustPartial: [], mustUnknown: [] };
  assert.equal(decide(perfect).code, 'review');

  // 0.82 分但有一项硬性"待确认" —— 没写不等于没有，但也不能算符合
  assert.equal(decide({ ...perfect, mustUnknown: [{ label: 'A' }] }).code, 'pending');
  assert.equal(decide({ ...perfect, mustPartial: [{ label: 'A' }] }).code, 'pending');
  assert.equal(decide({ ...perfect, confirmed: 0.7 }).code, 'pending');
});

// ---------------------------------------------------------------------------
// 打分：分数由代码算，模型只给四态判定
// ---------------------------------------------------------------------------

test('加权得分：partial 按 0.6 折算，unknown 不计分但要扣覆盖率', () => {
  const rubrics = [R('a', 'must', { weight: 8 }), R('b', 'nice', { weight: 2 })];
  const s = scoreCandidate(rubrics, [
    { rubric_id: 'a', verdict: 'met' },
    { rubric_id: 'b', verdict: 'partial' },
  ]);
  assert.equal(s.confirmed, (8 * 1 + 2 * 0.6) / 10);
  assert.equal(s.coverage, 1);
  assert.equal(s.confirmedPct, 92);

  const u = scoreCandidate(rubrics, [
    { rubric_id: 'a', verdict: 'unknown' },
    { rubric_id: 'b', verdict: 'met' },
  ]);
  assert.ok(Math.abs(u.confirmed - 0.2) < 1e-9);
  assert.ok(Math.abs(u.coverage - 0.2) < 1e-9); // 8 分权重无法判断 → 覆盖率 20%
  assert.equal(u.stats.unknown, 1);
  assert.equal(u.decision.code, 'insufficient');
});

test('红线项不参与权重分母，但命中即暂缓', () => {
  const rubrics = [R('a', 'must', { weight: 10 }), R('x', 'redline', { weight: 10 })];
  const s = scoreCandidate(rubrics, [
    { rubric_id: 'a', verdict: 'met' },
    { rubric_id: 'x', verdict: 'missing' },
  ]);
  assert.equal(s.confirmed, 1);
  assert.equal(s.redlineHits.length, 1);
  assert.equal(s.decision.code, 'reject');
});

test('模型漏返回某条判定时按 unknown 处理，绝不默认符合', () => {
  const s = scoreCandidate([R('a', 'must'), R('b', 'nice')], [{ rubric_id: 'a', verdict: 'met' }]);
  const b = s.items.find((i) => i.id === 'b');
  assert.equal(b.verdict, 'unknown');
  assert.equal(s.coveragePct, 50);
});

// ---------------------------------------------------------------------------
// 举证：模型引用的原文必须真的在简历里
// ---------------------------------------------------------------------------

test('证据校验：逐字或仅空白标点差异算通过，改写过的不算', () => {
  const text = '2023.09 - 2027.06 华中科技大学 计算机科学与技术 本科（在读）';
  const ok = verifyEvidence(['2023.09 - 2027.06 华中科技大学 计算机科学与技术'], text);
  assert.equal(ok.allVerified, true);

  const fuzzy = verifyEvidence(['华中科技大学计算机科学与技术本科在读'], text);
  assert.equal(fuzzy.allVerified, true); // 忽略空白与标点后仍可对上

  const fake = verifyEvidence(['曾在字节跳动负责推荐算法'], text);
  assert.equal(fake.evidence[0].verified, false);
  assert.equal(fake.allVerified, false);
});

test('证据校验：太短的片段不足以作为证据', () => {
  const { evidence } = verifyEvidence(['本科'], '华中科技大学 计算机科学与技术 本科');
  assert.equal(evidence[0].verified, false);
});

// ---------------------------------------------------------------------------
// 否定语境：没有编程基础 ≠ 有编程基础
// ---------------------------------------------------------------------------

test('否定语境不算命中', () => {
  assert.equal(hasAffirmative('本人无编程基础，希望从零学起。', '编程'), false);
  assert.equal(hasAffirmative('没写过代码。', '编程'), false);
  assert.equal(hasAffirmative('熟练掌握 Python，写过爬虫与数据清洗脚本。', 'python'), true);

  const v = ruleVerdictFor(
    R('must_coding', 'must', { type: 'skill', label: '具备一定编程基础（Python / JS / SQL 等）' }),
    { rawText: '市场营销专业，本人无编程基础，希望能从零开始学习。', profile: {} },
  );
  assert.equal(v.verdict, 'missing');
});

// ---------------------------------------------------------------------------
// 规则判定：四条典型路径
// ---------------------------------------------------------------------------

test('专业判定只看教育背景行，不被课程/工具词误伤', () => {
  const rubric = R('must_major', 'must', { type: 'education', label: '计算机 / 软件工程 / IT 相关专业背景' });

  const hit = ruleVerdictFor(rubric, {
    rawText: '教育背景\n2019.09 - 2023.06 南京理工大学 计算机科学与技术 本科',
    profile: {},
  });
  assert.equal(hit.verdict, 'met');

  const miss = ruleVerdictFor(rubric, {
    rawText: '教育背景\n2019.09 - 2022.06 江苏经贸职业技术学院 市场营销 大专',
    profile: {},
  });
  assert.equal(miss.verdict, 'missing');
});

test('实习时长：够就算符合，不够是部分符合，没写是待确认', () => {
  const rubric = R('must_dur', 'must', {
    type: 'availability',
    label: '能连续实习 3-6 个月，时间安排稳定',
  });
  assert.equal(detectAvailability('可连续实习 6 个月，每周 5 天').months, 6);

  assert.equal(ruleVerdictFor(rubric, { rawText: '可实习 6 个月，每周到岗 5 天', profile: {} }).verdict, 'met');
  assert.equal(ruleVerdictFor(rubric, { rawText: '目前只能实习 2 个月', profile: {} }).verdict, 'partial');
  assert.equal(ruleVerdictFor(rubric, { rawText: '本人吃苦耐劳，学习能力强。', profile: {} }).verdict, 'unknown');
});

test('关键词类硬性要求：单命中只给部分符合', () => {
  const rubric = R('must_coding', 'must', { type: 'skill', label: '具备一定编程基础（Python / JS / SQL 等）' });
  const strong = ruleVerdictFor(rubric, { rawText: '熟练使用 Python、JavaScript，写过数据清洗脚本', profile: {} });
  assert.equal(strong.verdict, 'met');
  const weak = ruleVerdictFor(rubric, { rawText: '课程里用过 SQL 查询', profile: {} });
  assert.equal(weak.verdict, 'partial');
});

// ---------------------------------------------------------------------------
// 追问清单：待确认项必须能变成一句可以直接发出去的话
// ---------------------------------------------------------------------------

test('每个待确认/部分符合的硬性项都有一条追问', () => {
  const rubrics = [
    R('must_dur', 'must', { type: 'availability', label: '能连续实习 3-6 个月' }),
    R('must_major', 'must', { type: 'education', label: '计算机相关专业' }),
  ];
  const score = scoreCandidate(rubrics, [
    { rubric_id: 'must_dur', verdict: 'unknown' },
    { rubric_id: 'must_major', verdict: 'partial' },
  ]);
  const questions = buildQuestions(score);
  // 两条缺口各一条追问，覆盖率过低时再加一句"补充完整简历"
  assert.ok(questions.length >= 2);
  assert.ok(questions.some((q) => /实习/.test(q)));
  assert.ok(questions.some((q) => /专业|学历/.test(q)));
  assert.ok(questions.some((q) => /补充/.test(q)));
});
