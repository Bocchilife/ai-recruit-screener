/**
 * 打分数学 + 规则引擎（纯函数，无 IO，可单测）。
 *
 * 设计要点（详见 docs/specs/2026-10-22-ai-recruit-screener-design.md）：
 *  1) 模型只做「逐条判定 + 举证」，分数由这里的确定性代码计算 → 可复现、可回归。
 *  2) 判定有四态，unknown 表示"简历没写"，不计入已确认分但计入覆盖率损耗。
 *  3) 规则引擎与 LLM 输出同一份 verdict schema，供无 Key / 超时降级使用。
 *  4) 规则引擎的判定刻意保守：单个关键词命中只给 partial，明确否定的语境判 missing。
 */

export const VERDICT_FACTOR = { met: 1, partial: 0.6, missing: 0, unknown: 0 };
export const VERDICT_LABEL = { met: '符合', partial: '部分符合', missing: '不符合', unknown: '待确认' };
export const GROUP_LABEL = { must: '硬性要求', nice: '加分项', redline: '红线' };

const DEGREE_RANK = { 博士: 5, 硕士: 4, 研究生: 4, 本科: 3, 学士: 3, 大专: 2, 专科: 2, 中专: 1, 高中: 1 };

/** IT / 计算机相关专业族（用于判断"专业对不对口"） */
const IT_FAMILY = [
  '计算机', '软件工程', '软件', '信息技术', '信息管理', '信息系统', '人工智能', '数据科学',
  '智能科学', '网络工程', '信息安全', '电子', '通信', '电子信息', '数学', '统计',
  'computer science', 'software engineering', 'information technology', 'data science',
  'information systems', 'informatics', 'computer engineering',
];

const MAJOR_TAIL =
  /(营销|工程|科学与技术|技术|系统|智能|管理|经济|贸易|商务|英语|日语|设计|自动化|通信|电子|统计|会计|金融|教育|文学|法学|医学|数学|物理|化学|生物|新闻|建筑|土木|材料|环境|科学|艺术)$/;

// ---------------------------------------------------------------------------
// 院校层次：985 / 211 / 双一流 是公开的确定事实，交给代码判定，不交给模型猜。
// 清单不追求完整（列的是常见院校），未命中的落到"普通本科 / 专科"，不影响主流程。
// ---------------------------------------------------------------------------

const SCHOOL_985 = [
  '北京大学', '清华大学', '中国人民大学', '北京航空航天大学', '北京理工大学', '中国农业大学',
  '北京师范大学', '中央民族大学', '南开大学', '天津大学', '大连理工大学', '吉林大学',
  '哈尔滨工业大学', '复旦大学', '同济大学', '上海交通大学', '华东师范大学', '南京大学',
  '东南大学', '浙江大学', '中国科学技术大学', '厦门大学', '山东大学', '中国海洋大学',
  '武汉大学', '华中科技大学', '湖南大学', '中南大学', '中山大学', '华南理工大学', '四川大学',
  '电子科技大学', '重庆大学', '西安交通大学', '西北工业大学', '兰州大学', '国防科技大学',
  '东北大学', '西北农林科技大学',
];

const SCHOOL_211 = [
  '北京交通大学', '北京工业大学', '北京科技大学', '北京化工大学', '北京邮电大学', '北京林业大学',
  '北京中医药大学', '北京外国语大学', '中国传媒大学', '中央财经大学', '对外经济贸易大学',
  '北京体育大学', '中央音乐学院', '中国政法大学', '华北电力大学', '天津医科大学', '河北工业大学',
  '太原理工大学', '内蒙古大学', '辽宁大学', '大连海事大学', '延边大学', '东北师范大学',
  '哈尔滨工程大学', '东北农业大学', '东北林业大学', '华东理工大学', '东华大学', '上海外国语大学',
  '上海财经大学', '上海大学', '苏州大学', '南京航空航天大学', '南京理工大学', '中国矿业大学',
  '河海大学', '江南大学', '南京农业大学', '中国药科大学', '南京师范大学', '安徽大学', '合肥工业大学',
  '福州大学', '南昌大学', '中国石油大学', '郑州大学', '中国地质大学', '武汉理工大学', '华中农业大学',
  '华中师范大学', '中南财经政法大学', '湖南师范大学', '暨南大学', '华南师范大学', '海南大学',
  '广西大学', '西南交通大学', '西南财经大学', '四川农业大学', '西南大学', '贵州大学', '云南大学',
  '西藏大学', '西北大学', '西安电子科技大学', '长安大学', '陕西师范大学', '青海大学', '宁夏大学',
  '新疆大学', '石河子大学',
];

const SCHOOL_DFC = [
  '上海科技大学', '南方科技大学', '南京信息工程大学', '南京邮电大学', '南京林业大学', '南京中医药大学',
  '南京医科大学', '宁波大学', '首都师范大学', '首都医科大学', '天津工业大学', '山西大学', '湘潭大学',
  '华南农业大学', '广州中医药大学', '广州医科大学', '成都理工大学', '西南石油大学', '成都中医药大学',
  '北京协和医学院', '外交学院', '中国人民公安大学', '中央美术学院', '中国美术学院', '中国音乐学院',
  '上海海洋大学', '上海中医药大学', '上海体育学院', '上海音乐学院',
];

/** 院校层次 → 该加分项的判定与加权系数（985 拿满，211 拿 3/4，双一流拿一半） */
export const SCHOOL_TIER = {
  '985': { verdict: 'met', factor: 1 },
  '211': { verdict: 'partial', factor: 0.75 },
  双一流: { verdict: 'partial', factor: 0.5 },
  '港澳/海外': { verdict: 'partial', factor: 0.6 },
  普通本科: { verdict: 'missing', factor: 0 },
  专科: { verdict: 'missing', factor: 0 },
};

/** 常见院校的英文写法（留学生的简历就是这么写校名的） */
const SCHOOL_985_EN = [
  /peking university|tsinghua/i,
  /fudan university/i,
  /zhejiang university/i,
  /shanghai (?:jiao\s?tong|jiaotong) university/i,
  /nanjing university(?!\s+of)/i,
  /wuhan university(?!\s+of)/i,
  /sun yat-?sen/i,
  /huazhong university of science and technology/i,
  /university of science and technology of china/i,
  /harbin institute of technology/i,
  /xi'?an jiaotong/i,
  /sichuan university/i,
  /shandong university/i,
  /xiamen university/i,
  /nankai university/i,
  /tongji university/i,
  /southeast university/i,
  /beihang|beijing university of aeronautics/i,
  /beijing institute of technology/i,
  /renmin university|people'?s university of china/i,
  /china agricultural university/i,
  /east china normal university/i,
  /central south university/i,
  /hunan university(?!\s+of)/i,
  /chongqing university(?!\s+of)/i,
  /northwestern polytechnical/i,
  /lanzhou university/i,
  /jilin university/i,
  /dalian university of technology/i,
  /national university of defense technology/i,
];

const SCHOOL_211_EN = [
  /beijing university of posts|bupt/i,
  /nanjing university of (?:aeronautics|posts|science)/i,
  /wuhan university of technology/i,
  /south china university of technology/i,
  /nanjing normal university/i,
  /soochow university/i,
  /xidian university/i,
  /east china university of science and technology/i,
  /beijing university of technology(?!\s+of)/i,
  /donghua university/i,
  /shanghai university(?!\s+of)/i,
  /china university of (?:mining|petroleum|geosciences)/i,
];

/**
 * 只认"明确的境外院校名"，不认"简历里出现了美国/海外"这类泛词——
 * 曾经因为一句"帮学院老师整理海外期刊数据"就把深圳大学判成了港澳/海外院校。
 */
const OVERSEAS_SCHOOL_RE =
  /香港(?:中文|科技|理工|城市|浸会|岭南|教育|都会)大学|澳门(?:科技)?大学|台湾大学|新加坡国立大学|南洋理工|海外院校|留学|city university of hong kong|university of hong kong|chinese university of hong kong|hong kong (?:university of science|polytechnic)|national university of singapore|nanyang technological|university of melbourne|university of toronto|university of sydney|imperial college|university college london|new york university/i;

const EDU_LINE_RE = /大学|学院|本科|硕士|博士|大专|专科|届|在读|university|college|bachelor|master|degree/i;

const GENERIC_SCHOOL_RE = /大学|学院|university|college|institute/i;

/** 只看教育背景相关的行，避免"合作大学""客户学院"之类误命中 */
function eduScope(rawText) {
  const text = String(rawText || '');
  const lines = text.split('\n').filter((l) => EDU_LINE_RE.test(l));
  return lines.length ? lines.join('\n') : text;
}

export function detectSchool(rawText) {
  const scope = eduScope(rawText);
  const byList = (list, tier) => {
    const school = list.find((s) => scope.includes(s));
    return school ? { school, tier } : null;
  };
  const byEn = (list, tier) => {
    for (const re of list) {
      const m = scope.match(re);
      if (m) return { school: m[0], tier };
    }
    return null;
  };

  const found =
    byList(SCHOOL_985, '985') ||
    byEn(SCHOOL_985_EN, '985') ||
    byList(SCHOOL_211, '211') ||
    byEn(SCHOOL_211_EN, '211') ||
    byList(SCHOOL_DFC, '双一流') ||
    byEn([OVERSEAS_SCHOOL_RE], '港澳/海外');
  if (found) return found;

  if (/大专|专科|职业技术学院|职业学院|高职/.test(scope)) {
    return { school: schoolNameFrom(scope, /([\u4e00-\u9fa5]{2,12}(?:职业技术学院|职业学院|专科学校|高职院?校?))/), tier: '专科' };
  }
  if (GENERIC_SCHOOL_RE.test(scope) && detectDegree(scope)) {
    return { school: schoolNameFrom(scope), tier: '普通本科' };
  }
  return { school: '', tier: '' };
}

const GENERIC_SCHOOL_NAME_RE = /([\u4e00-\u9fa5]{2,12}(?:大学|学院|学校))/;

/** 从教育经历行里抠出校名（专科/普通本科这类没进清单的学校，让原因文案里也能写出名字） */
function schoolNameFrom(scope, re = GENERIC_SCHOOL_NAME_RE) {
  const s = String(scope || '');
  // "也帮学院老师整理数据" 这种不是校名：名字里带上这些虚词/动词就跳过
  const unsafe = /[帮在于是的了到和与或及其该每各从对把被让给将为以所而]/;
  const global = new RegExp(re.source, 'g');
  for (const m of s.matchAll(global)) {
    if (!unsafe.test(m[1])) return m[1];
  }
  return '';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 去掉空白与常见标点，用于证据做包含性校验 */
export function normalizeForMatch(text) {
  return String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：""''（）()【】\[\]<>《》,.;:!?！？>·\-—_/\\|]/g, '')
    .toLowerCase();
}

/** 证据校验：模型引用的片段必须能在原文中找到，否则标记未验证 */
export function verifyEvidence(evidence = [], rawText = '') {
  const hay = normalizeForMatch(rawText);
  const checked = [];
  for (const item of evidence) {
    const quote = String(item || '').trim();
    if (!quote) continue;
    const needle = normalizeForMatch(quote);
    const ok = needle.length >= 4 && hay.includes(needle);
    checked.push({ quote: quote.slice(0, 160), verified: ok });
  }
  return { evidence: checked, allVerified: checked.length > 0 && checked.every((e) => e.verified) };
}

function splitSentences(text) {
  return String(text || '')
    .split(/[\n。；;!?！？]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function pickEvidence(rawText, keywords, max = 2) {
  const sentences = splitSentences(rawText);
  const keys = (keywords || []).map((k) => String(k || '')).filter(Boolean);
  const hits = [];
  for (const s of sentences) {
    const found = keys.find((k) => s.toLowerCase().includes(k.toLowerCase()));
    if (!found) continue;
    const idx = Math.max(0, s.toLowerCase().indexOf(found.toLowerCase()));
    hits.push(s.slice(Math.max(0, idx - 30), Math.max(0, idx - 30) + 120).trim());
    if (hits.length >= max) break;
  }
  return hits;
}

const NEG_BEFORE = /(未|没|没有|无|不|非|零|缺乏|缺少|暂无|未曾)[^。；\n]{0,4}$/;

/** 关键词是否以肯定语气出现（排除"未/无/没/不"等否定前缀） */
export function hasAffirmative(text, keyword) {
  const hay = String(text || '').toLowerCase();
  const needle = String(keyword || '').toLowerCase();
  if (!needle) return false;
  let idx = hay.indexOf(needle);
  while (idx >= 0) {
    const before = String(text).slice(Math.max(0, idx - 8), idx);
    if (!NEG_BEFORE.test(before)) return true;
    idx = hay.indexOf(needle, idx + 1);
  }
  return false;
}

/** 找出把该关键词写成否定形式的句子，用于"明确不具备"的举证 */
export function findNegatedSentence(text, keyword) {
  const needle = String(keyword || '').toLowerCase();
  if (!needle) return null;
  for (const s of splitSentences(text)) {
    const idx = s.toLowerCase().indexOf(needle);
    if (idx < 0) continue;
    const before = s.slice(Math.max(0, idx - 8), idx);
    if (NEG_BEFORE.test(before)) return s.slice(0, 120);
  }
  return null;
}

// ---------------------------------------------------------------------------
// rubric 规范化
// ---------------------------------------------------------------------------

const ALLOWED_GROUPS = new Set(['must', 'nice', 'redline']);

export function normalizeRubrics(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rubrics) ? raw.rubrics : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label || '').trim();
    if (label.length < 2) continue;
    let id = String(item.id || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
    if (!id || id === '_') id = `item_${out.length + 1}`;
    let n = 2;
    while (seen.has(id)) id = `${id}_${n++}`;
    seen.add(id);
    const group = ALLOWED_GROUPS.has(item.group) ? item.group : 'must';
    const weight = group === 'redline' ? 0 : clamp(Math.round(Number(item.weight) || (group === 'must' ? 7 : 3)), 1, 10);
    out.push({
      id,
      group,
      label,
      weight,
      type: String(item.type || 'other'),
      probe: String(item.probe || '').slice(0, 40),
      keywords: Array.isArray(item.keywords) ? item.keywords.map((k) => String(k)).filter(Boolean) : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 红线极性
//
// 曾经踩过的坑：红线条件写成否定式（"只能实习少于 3 个月""专业无关且无编程证据"），
// 而判定语义是「met = 简历能证明满足」。好简历对否定式条件答 missing（"这条不成立"），
// 却被当成"命中红线"，于是全员被否。
// 现在两层修：① 生成侧一律写正向条件（必须具备什么）；② 打分侧仍按极性兼容否定式表述。
// ---------------------------------------------------------------------------

const NEGATIVE_LABEL_RE =
  /(无关|没有任何|无任何|不具备|不含|未曾|未体现|没有|缺少|缺失|缺乏|不足|低于|少于|不超过|不接受|不允许|不符|不合适|拒绝|非)/;

export function labelPolarity(label) {
  return NEGATIVE_LABEL_RE.test(String(label || '')) ? 'negative' : 'positive';
}

/** 是否符合"命中红线"（正向条件看 missing，否定式条件看 met） */
export function isRedlineHit(item) {
  if (!item || item.group !== 'redline') return false;
  const polarity = item.polarity || labelPolarity(item.label);
  return polarity === 'negative' ? item.verdict === 'met' : item.verdict === 'missing';
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

export function scoreCandidate(rubrics, rawVerdicts = []) {
  const byId = new Map();
  for (const v of Array.isArray(rawVerdicts) ? rawVerdicts : []) {
    if (!v) continue;
    const key = String(v.rubric_id || v.rubricId || v.id || '');
    if (key && !byId.has(key)) byId.set(key, v);
  }

  const items = rubrics.map((r) => {
    const raw = byId.get(r.id) || {};
    const verdict = VERDICT_FACTOR[raw.verdict] === undefined ? 'unknown' : raw.verdict;
    const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : raw.evidence ? [raw.evidence] : [];
    // 每条判定可以自带更细的系数（如院校层次 985=1 / 211=0.75 / 双一流=0.5），
    // 没给就退回四态系数，这样模型只管判定、细粒度加权仍由代码控制。
    const custom = raw.factor === undefined || raw.factor === null ? NaN : Number(raw.factor);
    const factor = Number.isFinite(custom) ? clamp(custom, 0, 1) : VERDICT_FACTOR[verdict];
    return {
      ...r,
      verdict,
      polarity: labelPolarity(r.label),
      confidence: clamp(Number(raw.confidence ?? (verdict === 'unknown' ? 0.3 : 0.6)), 0, 1),
      evidenceRaw: evidenceRaw.map((e) => String(e)).filter(Boolean),
      reason: String(raw.reason || '').slice(0, 120),
      factor,
    };
  });

  const scored = items.filter((i) => i.group !== 'redline');
  const totalWeight = scored.reduce((s, i) => s + i.weight, 0);
  const gotWeight = scored.reduce((s, i) => s + i.weight * i.factor, 0);
  const unknownWeight = scored.filter((i) => i.verdict === 'unknown').reduce((s, i) => s + i.weight, 0);

  const confirmed = totalWeight > 0 ? gotWeight / totalWeight : 0;
  const coverage = totalWeight > 0 ? 1 - unknownWeight / totalWeight : 0;

  const mustItems = scored.filter((i) => i.group === 'must');
  const niceItems = scored.filter((i) => i.group === 'nice');
  const mustMissing = mustItems.filter((i) => i.verdict === 'missing');
  const mustPartial = mustItems.filter((i) => i.verdict === 'partial');
  const mustUnknown = mustItems.filter((i) => i.verdict === 'unknown');
  const redlineItems = items.filter((i) => i.group === 'redline');
  const redlineHits = redlineItems.filter((i) => isRedlineHit(i));
  // 红线"没写"不淘汰（unknown 与"明确不满足"不是一回事），但会进追问清单
  const redlineUnknown = redlineItems.filter((i) => i.verdict === 'unknown');

  const ratio = (arr) => (arr.length === 0 ? 1 : arr.reduce((s, i) => s + i.factor, 0) / arr.length);

  const decision = decide({ confirmed, coverage, mustMissing, mustPartial, mustUnknown, redlineHits });

  return {
    items,
    confirmed,
    coverage,
    confirmedPct: Math.round(confirmed * 100),
    coveragePct: Math.round(coverage * 100),
    mustRatio: ratio(mustItems),
    niceRatio: ratio(niceItems),
    mustMissing,
    mustPartial,
    mustUnknown,
    redlineHits,
    redlineUnknown,
    decision,
    stats: {
      total: items.length,
      met: items.filter((i) => i.verdict === 'met').length,
      partial: items.filter((i) => i.verdict === 'partial').length,
      missing: items.filter((i) => i.verdict === 'missing').length,
      unknown: items.filter((i) => i.verdict === 'unknown').length,
    },
  };
}

/**
 * 结论短路顺序（先后顺序本身是业务规则）：
 *   红线 > ≥2 项硬性不满足 > 覆盖率过低(信息不足) > 单项硬性不满足 > 全部满足才给"建议复核" > 其余待定
 */
export function decide({
  confirmed,
  coverage = 1,
  mustMissing = [],
  mustPartial = [],
  mustUnknown = [],
  redlineHits = [],
}) {
  const pct = Math.round(confirmed * 100);
  if (redlineHits.length > 0) {
    return { code: 'reject', label: '暂缓考虑', reason: `触发红线：${redlineHits.map((r) => r.label).join('、')}` };
  }
  if (mustMissing.length >= 2) {
    return {
      code: 'reject',
      label: '暂缓考虑',
      reason: `硬性要求有 ${mustMissing.length} 项明确不满足：${mustMissing.map((r) => r.label).join('、')}`,
    };
  }
  if (coverage < 0.5) {
    return {
      code: 'insufficient',
      label: '信息不足 · 需补充简历',
      reason: `信息覆盖率仅 ${Math.round(coverage * 100)}%，一半以上的要求无法从简历判断`,
    };
  }
  if (mustMissing.length === 1) {
    return confirmed < 0.5
      ? {
          code: 'reject',
          label: '暂缓考虑',
          reason: `硬性要求不满足（${mustMissing[0].label}），且整体匹配度仅 ${pct}%`,
        }
      : {
          code: 'pending',
          label: '待定 · 建议补充信息',
          reason: `硬性要求有 1 项不满足（${mustMissing[0].label}），其余条件可进一步确认`,
        };
  }
  if (confirmed >= 0.75 && mustPartial.length === 0 && mustUnknown.length === 0) {
    return { code: 'review', label: '建议进入人工复核', reason: '已确认匹配度 ≥75%，硬性要求无缺口、无待确认项' };
  }
  if (mustPartial.length > 0) {
    return {
      code: 'pending',
      label: '待定 · 建议补充信息',
      reason: `硬性要求存在部分满足项（${mustPartial.map((r) => r.label).join('、')}），需确认实际程度`,
    };
  }
  if (mustUnknown.length > 0) {
    return {
      code: 'pending',
      label: '待定 · 建议补充信息',
      reason: `硬性要求有 ${mustUnknown.length} 项简历未体现（${mustUnknown.map((r) => r.label).join('、')}），需向候选人确认`,
    };
  }
  return {
    code: 'pending',
    label: '待定 · 建议补充信息',
    reason: `已确认匹配度 ${pct}%，处于中间区间，需补充关键信息后复评`,
  };
}

// ---------------------------------------------------------------------------
// 追问清单
// ---------------------------------------------------------------------------

const QUESTION_BY_TYPE = {
  education: '你目前的最高学历层次与所学专业是什么？是否已毕业？',
  experience: '关于「{label}」，能否具体说说你在哪段经历里做过、做到什么程度？',
  skill: '简历里没有体现「{label}」，你目前的实际使用深度如何？能举一个具体例子吗？',
  language: '你的英语水平如何？能否直接用英文开会或撰写方案？有相关证书或成绩吗？',
  location: '你目前所在城市是哪里？能否到岗我们这边办公？',
  availability: '你能连续实习多久？每周可到岗几天，最早什么时候可以开始？',
  domain: '关于「{label}」，你之前的经历里有过相关的行业或客户接触吗？',
  other: '关于「{label}」，能补充一些具体情况吗？',
};

export function buildQuestions(score) {
  const questions = [];
  for (const item of score.items) {
    if (item.group === 'redline') {
      if (isRedlineHit(item)) continue; // 已否决，不必再问
      if (item.verdict === 'unknown') {
        questions.push(`岗位有一条硬性门槛「${item.label}」，简历里没有体现，能否确认一下你是否满足？`);
      }
      continue;
    }
    if (item.id === 'nice_school') continue; // 院校层次是确定事实，不必问候选人
    if (item.verdict === 'unknown') {
      const tpl = QUESTION_BY_TYPE[item.type] || QUESTION_BY_TYPE.other;
      questions.push(tpl.replace('{label}', item.label));
    } else if (item.verdict === 'partial') {
      questions.push(`你提到了部分相关经历，能否说明「${item.label}」这一项你实际做到的程度？`);
    }
  }
  if (score.coverage < 0.7) {
    questions.push('简历信息较少，方便的话请补充一份更完整的简历（含实习起止时间与项目细节）？');
  }
  return [...new Set(questions)].slice(0, 5);
}

// ---------------------------------------------------------------------------
// 规则引擎：简历字段抽取
// ---------------------------------------------------------------------------

const SKILL_LEXICON = {
  Python: ['python', 'py3'],
  JavaScript: ['javascript', 'js', 'node.js', 'nodejs'],
  TypeScript: ['typescript'],
  Java: ['java', 'spring'],
  SQL: ['sql', 'mysql', 'postgres', 'postgresql', '数据库'],
  'HTML/CSS': ['html', 'css'],
  React: ['react', 'vue', '前端'],
  'AI Agent': ['agent', '智能体', 'autogpt', 'langchain', 'langgraph', 'manus'],
  '大模型应用': ['大模型', 'llm', 'gpt', 'claude', 'prompt', '提示词', 'deepseek', 'qwen'],
  '工作流自动化': ['工作流', 'workflow', 'zapier', 'n8n', 'make.com', 'coze', '扣子', 'dify'],
  Excel: ['excel', '数据透视'],
  数据分析: ['数据分析', '数据清洗', 'pandas', 'bi', '可视化'],
  Figma: ['figma', 'sketch', 'ui设计'],
  设计: ['photoshop', '剪映', '视频剪辑', 'canva', '海报', '视觉设计'],
  英语: ['英语', 'english', 'cet-6', 'cet6', '六级', '雅思', 'ielts', '托福', 'toefl', '专八', 'tem-8'],
  外贸: ['外贸', 'b2b', '跨境', '出口', '海外市场', '国际站'],
  客户沟通: ['客户', '谈判', 'crm'],
  项目管理: ['项目管理', '敏捷', 'scrum'],
  RPA: ['rpa', 'uipath', '按键精灵', '影刀'],
};

const lower = (s) => String(s || '').toLowerCase();

/** 词表里的任何写法都归一到能力名，用于"命中了几项不同能力"的计数 */
function canonicalSkill(keyword) {
  const lk = lower(keyword);
  for (const [name, syns] of Object.entries(SKILL_LEXICON)) {
    if (lower(name) === lk || syns.some((s) => lower(s) === lk)) return name;
  }
  return lk;
}

// 通用能力名词：用于识别"无编程基础""没有英语成绩"这类否定表述
const CAPABILITY_TERMS = [
  '编程', '代码', '程序', '开发', '英语', '外语', '口语', '实习', '学历', '专业',
  '数据分析', '设计', '工作流', '大模型', 'AI', '外贸', '客户', '经验', '证书', '设计经验',
];

export function detectSkills(rawText) {
  const text = lower(rawText);
  return Object.entries(SKILL_LEXICON)
    .filter(([, syns]) => syns.some((s) => text.includes(s)))
    .map(([name]) => name);
}

export function detectDegree(rawText) {
  const text = String(rawText || '');
  let best = null;
  for (const [word, rank] of Object.entries(DEGREE_RANK)) {
    if (text.includes(word) && (!best || rank > best.rank)) best = { word, rank };
  }
  const en = [
    [/ph\.?\s?d|doctor/i, 5, '博士'],
    [/master|m\.?sc|研究生/i, 4, '硕士'],
    [/bachelor|b\.?sc|undergraduate|本科/i, 3, '本科'],
  ];
  for (const [re, rank, word] of en) {
    if (re.test(text) && (!best || rank > best.rank)) best = { word, rank };
  }
  return best;
}

/** 抽取"专业"，返回空串表示简历没写清楚 */
export function detectMajor(rawText) {
  const t = String(rawText || '');
  const en = t.match(
    /(computer science|software engineering|information technology|data science|information systems|computer engineering|business administration|marketing|english language)/i,
  );
  if (en) return en[0];

  const candidates = [];
  for (const re of [/(?:专业|主修)[:：]?\s*([\u4e00-\u9fa5A-Za-z·]{2,16})/, /([\u4e00-\u9fa5]{2,16})\s*专业/]) {
    for (const m of t.matchAll(new RegExp(re, 'g'))) candidates.push(m[1]);
  }
  for (const cand of candidates) {
    if (/级|技能|证书/.test(cand)) continue;
    if (cand.length >= 2) return cand;
  }

  // 兜底：学历行里找专业名（形如 "XX大学  XX专业名  本科"）
  const lines = t.split('\n').filter((l) => /本科|硕士|大专|专科|学士|大学|学院|bachelor/i.test(l));
  for (const line of lines) {
    const tokens = line.match(/[\u4e00-\u9fa5A-Za-z·]{2,16}/g) || [];
    for (const tok of tokens) {
      if (/大学|学院|本科|硕士|大专|专科|学士|在读|应届|毕业/.test(tok)) continue;
      if (MAJOR_TAIL.test(tok)) return tok;
    }
  }
  return '';
}

export function isITMajor(major) {
  const m = lower(major);
  if (!m) return false;
  return IT_FAMILY.some((k) => m.includes(k.toLowerCase()));
}

export function detectAvailability(rawText) {
  const text = String(rawText || '');
  const months = [...text.matchAll(/(\d+)\s*(?:[-~至到]\s*(\d+))?\s*个月/g)].map((m) => ({
    min: Number(m[1]),
    max: Number(m[2] || m[1]),
  }));
  for (const m of text.matchAll(/(\d+)\s*-?\s*months?\b/gi)) months.push({ min: Number(m[1]), max: Number(m[1]) });
  const days = [
    ...[...text.matchAll(/每周\s*(\d+)\s*天|(\d+)\s*天\s*\/\s*周/g)].map((m) => Number(m[1] || m[2])),
    ...[...text.matchAll(/(\d+)\s*days?\s*(?:per|a|\/)\s*week/gi)].map((m) => Number(m[1])),
  ];
  return {
    months: months.length ? Math.max(...months.map((m) => m.max)) : null,
    daysPerWeek: days.length ? Math.max(...days) : null,
  };
}

export function detectYears(rawText) {
  const text = String(rawText || '');
  const hits = [...text.matchAll(/(\d+(?:\.\d+)?)\s*年(?:以上)?[^\n。]{0,6}?(?:经验|开发|工作|实习)/g)].map((m) =>
    Number(m[1]),
  );
  if (/应届|在校生|无工作经验/.test(text) && hits.length === 0) return 0;
  return hits.length ? Math.max(...hits) : null;
}

export function detectLanguageLevel(rawText) {
  const text = lower(rawText);
  if (/雅思|ielts|托福|toefl|专八|tem-?8|英语专业|cet-?6|六级|英语可作为工作语言|英语流利|native|fluent|professional working proficiency/.test(text))
    return 'strong';
  if (/cet-?4|四级|英语良好|英语读写|英语一般/.test(text)) return 'basic';
  if (/英语|english/.test(text)) return 'mentioned';
  return 'none';
}

export function ruleProfile(rawText) {
  const text = String(rawText || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const phone = (text.match(/1[3-9]\d{9}/) || [''])[0];
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
  const cjkName = lines.find((l) => /^[\u4e00-\u9fa5]{2,4}$/.test(l) && !/简历|求职|个人/.test(l));
  const asciiName = lines.find(
    (l) => /^[A-Za-z][A-Za-z .·]{2,24}$/.test(l) && !/[|@]/.test(l) && !/resume|curriculum/i.test(l),
  );
  const selfIntro = (text.match(/我是([\u4e00-\u9fa5]{2,3})[\s，,。]/) || [])[1];
  const NAME_STOP = /^(你好|您好|简历|个人|求职|基本|信息|姓名|联系方式|男|女)$/;
  const prefixName = (/^[\u4e00-\u9fa5]{2,4}/.exec(lines[0] || '') || [''])[0];
  const degree = detectDegree(text);
  const availability = detectAvailability(text);
  const school = detectSchool(text);
  return {
    name: cjkName || selfIntro || asciiName || (NAME_STOP.test(prefixName) ? '' : prefixName) || '未识别姓名',
    contact: { phone, email },
    education: {
      degree: degree?.word || '',
      school: school.school || (text.match(/([\u4e00-\u9fa5]{2,14}(?:大学|学院))/) || [''])[0],
      tier: school.tier,
      major: detectMajor(text),
      graduation: (text.match(/(20\d{2})\s*年\s*(?:6|7)?\s*月?\s*毕业/) || [''])[0],
      status: /在读|研[一二三]|大[一二三四]|应届|expected/.test(text) ? '在读/应届' : '',
    },
    yearsOfExperience: detectYears(text),
    skills: detectSkills(text),
    languages: detectLanguageLevel(text) === 'none' ? [] : ['英语'],
    availability:
      availability.months || availability.daysPerWeek
        ? [
            availability.months ? `可实习 ${availability.months} 个月` : '',
            availability.daysPerWeek ? `每周 ${availability.daysPerWeek} 天` : '',
          ]
            .filter(Boolean)
            .join('，')
        : '',
    location: (text.match(/(北京|上海|广州|深圳|杭州|成都|武汉|南京|苏州|厦门|义乌|宁波|合肥|西安)/) || [''])[0],
    expectedSalary: '',
    notes: '',
  };
}

// ---------------------------------------------------------------------------
// 规则引擎：逐条判定（与 LLM 同一 schema）
// ---------------------------------------------------------------------------

const REDLINE_CONFLICT = [
  { need: /全职/, deny: /只能兼职|仅周末/ },
  { need: /到岗|坐班/, deny: /只接受远程|仅远程/ },
];

function rubricKeywords(rubric) {
  if (rubric.keywords?.length) return rubric.keywords;
  const out = [];
  const label = String(rubric.label || '');
  for (const [name, syns] of Object.entries(SKILL_LEXICON)) {
    if (label.includes(name) || syns.some((s) => label.toLowerCase().includes(s))) out.push(name, ...syns);
  }
  return [...new Set(out)];
}

export function ruleVerdictFor(rubric, { rawText, profile }) {
  const text = String(rawText || '');
  const label = String(rubric.label || '');
  const base = { rubric_id: rubric.id, confidence: 0.45 };

  // 1) 红线：先处理"明确冲突"的硬证据
  for (const rule of REDLINE_CONFLICT) {
    if (rule.need.test(label) && rule.deny.test(text)) {
      return {
        ...base,
        verdict: labelPolarity(label) === 'negative' ? 'met' : 'missing',
        evidence: pickEvidence(text, ['远程', '兼职', '线上']),
        reason: '简历明确写明与红线条件冲突',
      };
    }
  }
  // 否定式红线（"必须不能……"）规则引擎不做硬判，避免又出现"好简历被判红"；
  // 正向红线继续走下面的通用分支，因为"必须具备"的条件本来就可以逐条判定。
  if (rubric.group === 'redline' && labelPolarity(label) === 'negative') {
    return { ...base, verdict: 'unknown', evidence: [], reason: '否定式红线条件，规则引擎不下硬结论，转人工确认' };
  }

  // 2) 学历门槛（label 里出现了具体学历词才算）
  if (/本科|硕士|博士|研究生|大专|专科|学历|bachelor|master|degree/i.test(label)) {
    const needRank = Math.max(
      ...[...label.matchAll(/博士|硕士|研究生|本科|学士|大专|专科/g)].map((m) => DEGREE_RANK[m[0]] || 0),
      0,
    );
    const have = detectDegree(text);
    if (!have) return { ...base, verdict: 'unknown', evidence: [], reason: '简历中未找到学历信息' };
    const ev = pickEvidence(text, [have.word, '学历', '毕业']);
    if (needRank === 0) return { ...base, verdict: 'met', confidence: 0.5, evidence: ev, reason: '简历含学历信息' };
    if (have.rank >= needRank) {
      return { ...base, verdict: 'met', confidence: 0.7, evidence: ev, reason: `最高学历为${have.word}，满足要求` };
    }
    return { ...base, verdict: 'missing', confidence: 0.75, evidence: ev, reason: `最高学历为${have.word}，低于岗位要求` };
  }

  // 2.5) 院校层次（985 / 211 / 双一流）：确定事实，代码判定，不进模型
  if (rubric.id === 'nice_school' || /985|211|双一流|院校层次|名校/i.test(label)) {
    const { school, tier } = detectSchool(text);
    if (!tier) return { ...base, verdict: 'unknown', evidence: [], reason: '简历没有写清院校' };
    const conf = SCHOOL_TIER[tier];
    return {
      ...base,
      verdict: conf.verdict,
      factor: conf.factor,
      confidence: 0.85,
      evidence: pickEvidence(text, [school || '大学', '本科', '硕士']),
      reason: `${school ? `${school}（${tier}）` : tier}，院校层次加权 ×${conf.factor}`,
    };
  }

  // 3) 专业是否对口
  if (rubric.type === 'education' || /专业|方向|major/i.test(label)) {
    // 只在"教育背景"相关的行里找 IT 专业词，避免"数据统计""电子表格"这类误命中
    const eduLines = text
      .split('\n')
      .filter((l) => /大学|学院|本科|硕士|大专|专科|学历|届|在读|university|college|bachelor|master/i.test(l))
      .join('\n');
    const scope = eduLines || text;
    const itHit = IT_FAMILY.find((k) => hasAffirmative(scope, k));
    if (itHit) {
      return {
        ...base,
        verdict: 'met',
        confidence: 0.7,
        evidence: pickEvidence(scope, [itHit]),
        reason: `教育背景出现「${itHit}」，属于要求的专业方向`,
      };
    }
    const major = profile?.education?.major || detectMajor(text);
    if (!major) return { ...base, verdict: 'unknown', evidence: [], reason: '简历未写明专业' };
    return {
      ...base,
      verdict: 'missing',
      confidence: 0.65,
      evidence: pickEvidence(text, [major, '专业']),
      reason: `专业为${major}，未见计算机相关专业背景`,
    };
  }

  // 4) 可实习时长 / 到岗
  if (/实习.*(?:个月|天)|连续实习|时间安排|到岗|availability|month/i.test(label) || rubric.type === 'availability') {
    const need = label.match(/(\d+)\s*(?:[-~至到]\s*(\d+))?\s*个月/);
    const have = detectAvailability(text);
    if (!have.months && !have.daysPerWeek && !/随时到岗|立即到岗/.test(text)) {
      return { ...base, verdict: 'unknown', evidence: [], reason: '简历未写可实习时长' };
    }
    const ev = pickEvidence(text, ['实习', '个月', '每周', '到岗', 'month']);
    if (need && have.months) {
      const needMin = Number(need[1]);
      return have.months >= needMin
        ? { ...base, verdict: 'met', confidence: 0.7, evidence: ev, reason: `可实习 ${have.months} 个月，满足 ${needMin} 个月要求` }
        : { ...base, verdict: 'partial', confidence: 0.6, evidence: ev, reason: `可实习 ${have.months} 个月，低于要求的 ${needMin} 个月` };
    }
    return { ...base, verdict: 'partial', evidence: ev, reason: '简历提到实习时间但不完整' };
  }

  // 5) 语言能力
  if (/英语|英文|外语|语言|english/i.test(label)) {
    const level = detectLanguageLevel(text);
    const ev = pickEvidence(text, ['英语', 'CET', '六级', '雅思', 'IELTS', 'English']);
    if (level === 'strong') return { ...base, verdict: 'met', confidence: 0.7, evidence: ev, reason: '简历体现较强的英语能力' };
    if (level === 'basic' || level === 'mentioned') {
      return { ...base, verdict: 'partial', confidence: 0.55, evidence: ev, reason: '简历提到英语，但水平表述不足以证明可作工作语言' };
    }
    return { ...base, verdict: 'unknown', evidence: [], reason: '简历未提及英语水平' };
  }

  // 6) 年限
  if (/(\d+)\s*年(?:以上)?/.test(label) || rubric.type === 'experience') {
    const need = Number((label.match(/(\d+)\s*年/) || [])[1] || 0);
    const have = detectYears(text);
    if (have === null) return { ...base, verdict: 'unknown', evidence: [], reason: '简历未写工作/实习年限' };
    const ev = pickEvidence(text, ['经验', '实习', '工作']);
    if (!need) return { ...base, verdict: 'met', confidence: 0.4, evidence: ev, reason: '简历含相关经历' };
    if (have >= need) return { ...base, verdict: 'met', confidence: 0.6, evidence: ev, reason: `相关经验约 ${have} 年` };
    return { ...base, verdict: 'partial', confidence: 0.55, evidence: ev, reason: `相关经验约 ${have} 年，低于 ${need} 年要求` };
  }

  // 7) 技能 / 方向关键词（否定语境单独处理）
  // 按"命中了几个不同能力"计数：词表里有大小写与同义词变体（Python/python、SQL/sql/数据库），
  // 同一个能力被多种写法命中时只算一次，否则一个 SQL 会被算成两点证据。
  const kws = rubricKeywords(rubric);
  const hits = [...new Set(kws.filter((k) => hasAffirmative(text, k)).map(canonicalSkill))];
  if (hits.length >= 2) {
    return {
      ...base,
      verdict: 'met',
      confidence: 0.65,
      evidence: pickEvidence(text, hits.slice(0, 3)),
      reason: `简历多处命中关键词：${hits.slice(0, 3).join('、')}`,
    };
  }
  if (hits.length === 1) {
    return {
      ...base,
      verdict: 'partial',
      confidence: 0.5,
      evidence: pickEvidence(text, hits),
      reason: `仅命中关键词「${hits[0]}」，证据强度不足以判定完全满足`,
    };
  }
  // "本人无编程基础" 这类句子未必带词表里的具体技术词，
  // 所以除了词表，还把标签里的通用能力名词也拿来扫一遍否定语境。
  const negProbes = [...new Set([...kws, ...CAPABILITY_TERMS.filter((t) => label.includes(t))])];
  const negated = negProbes.map((k) => findNegatedSentence(text, k)).find(Boolean);
  if (negated) {
    return { ...base, verdict: 'missing', confidence: 0.65, evidence: [negated], reason: '简历明确写明不具备该项' };
  }
  const soft = kws.filter(
    (k) => String(k).length > 2 && hasAffirmative(text, String(k).slice(0, 2)),
  );
  if (soft.length > 0) {
    return { ...base, verdict: 'partial', confidence: 0.35, evidence: pickEvidence(text, soft.slice(0, 2)), reason: '存在弱相关表述' };
  }
  return { ...base, verdict: 'unknown', evidence: [], reason: '简历未体现该项，需与本人确认' };
}

export function ruleVerdicts(rubrics, { rawText, profile }) {
  return rubrics.map((r) => ruleVerdictFor(r, { rawText, profile }));
}

// ---------------------------------------------------------------------------
// 规则引擎：JD 拆解（条件模板库）
// ---------------------------------------------------------------------------

const CONDITION_LIBRARY = [
  {
    id: 'must_edu',
    test: /本科及以上|硕士及以上|学历要求|大专及以上/,
    group: 'must', weight: 10, type: 'education',
    label: '本科及以上学历',
    probe: '学历层次、毕业时间',
    keywords: [],
  },
  {
    id: 'must_major',
    test: /计算机|软件工程|IT\s*相关|信息工程|理工科|技术专业|专业背景/,
    group: 'must', weight: 9, type: 'education',
    label: '计算机 / 软件工程 / IT 相关专业背景',
    probe: '专业名称、主修课程',
    keywords: [],
  },
  {
    id: 'must_coding',
    test: /编程|写代码|开发能力|Python|Java|SQL|C\+\+|代码/i,
    group: 'must', weight: 8, type: 'skill',
    label: '具备一定编程基础（Python / JS / SQL 等）',
    probe: '项目代码、技术栈、GitHub',
    keywords: ['python', 'javascript', 'typescript', 'java', 'sql', 'c++', '代码', '编程'],
  },
  {
    id: 'must_availability',
    test: /连续实习|[3三]\s*[-~至到]\s*6\s*个月|实习.{0,6}个月|到岗/,
    group: 'must', weight: 8, type: 'availability',
    label: '能连续实习 3-6 个月，时间安排稳定',
    probe: '可实习起止时间、每周天数',
    keywords: [],
  },
  {
    id: 'nice_ai',
    test: /大模型|LLM|AI\s*Agent|GPT|智能体|提示词/i,
    group: 'nice', weight: 5, type: 'skill',
    label: '对大模型 / AI Agent 有实际使用经验',
    probe: 'AI 工具使用与产出',
    keywords: ['大模型', 'llm', 'gpt', 'openai', 'agent', '智能体', 'prompt', '提示词', 'deepseek', 'claude', 'cursor', 'langchain', 'langgraph'],
  },
  {
    id: 'nice_workflow',
    test: /工作流|workflow|自动化|automat|n8n|zapier|coze|扣子|dify|rpa/i,
    group: 'nice', weight: 5, type: 'skill',
    label: '有工作流自动化搭建经验（n8n / Coze / Dify 等）',
    probe: '自动化流程、工具链、产出物',
    keywords: ['工作流', 'workflow', 'n8n', 'coze', '扣子', 'dify', 'zapier', 'rpa', '影刀'],
  },
  {
    id: 'nice_english',
    test: /英语|英文|外语|多语言|跨文化|海外/i,
    group: 'nice', weight: 4, type: 'language',
    label: '英语可作为工作语言',
    probe: 'CET/雅思托福、英文产出',
    keywords: ['英语', 'cet', '六级', '雅思', 'ielts', '托福', 'toefl', '专八', 'english'],
  },
  {
    id: 'nice_cross_border',
    test: /外贸|跨境|B2B|海外市场|国际|客户/i,
    group: 'nice', weight: 3, type: 'domain',
    label: '有外贸 / 跨境 / 海外业务相关经历',
    probe: '行业与客户类型',
    keywords: ['外贸', '跨境', 'b2b', '出口', '海外市场', '国际站'],
  },
  {
    id: 'nice_design',
    test: /视觉|设计|海报|视频|剪映|Figma|原型|Prototype|素材/i,
    group: 'nice', weight: 2, type: 'skill',
    label: '能做基础视觉素材 / 原型',
    probe: '作品链接、设计工具',
    keywords: ['figma', 'photoshop', '剪映', '视频剪辑', '海报', '原型', 'canva', '视觉设计'],
  },
  {
    id: 'nice_data',
    test: /数据|分析|Excel|BI|调研|商业分析/i,
    group: 'nice', weight: 3, type: 'skill',
    label: '有数据分析 / 调研经验',
    probe: '分析工具与结论产出',
    keywords: ['数据分析', 'excel', 'sql', 'pandas', 'bi', '可视化', '调研', '数据清洗'],
  },
];

const SOFT_SKILL_RE = /主动学习|解决问题|沟通能力|抗压|责任心|热情|综合素质|愿意理解业务/;

export const SCHOOL_RUBRIC = {
  id: 'nice_school',
  group: 'nice',
  label: '重点院校背景（985 / 211 / 双一流）',
  weight: 6,
  type: 'education',
  probe: '院校层次',
  keywords: [],
};

/** 院校层次加分项对任何 JD 都成立，先补齐再交给判定 */
export function ensureSchoolRubric(rubrics) {
  const list = Array.isArray(rubrics) ? rubrics : [];
  if (list.some((r) => r?.id === 'nice_school' || /985|211|双一流/.test(String(r?.label || '')))) return list;
  return [...list, SCHOOL_RUBRIC];
}

/**
 * 红线收敛：默认不设红线（一票否决误设的代价最大）。
 * - 最多保留 1 条（MAX_REDLINES）
 * - 在读学生身份 / 在校证明 / 可实习时长 / 学历本科 / 专业 / 编程基础 / 英语 这类常规条件不配当红线
 * 被剔除的红线**降级为 must 或丢弃**：涉及"能实习多久、学历、专业、编程、英语"的转为 must，其余直接丢弃。
 */
const MAX_REDLINES = 1;
const NOT_A_REDLINE_RE = /在读|在校|学生身份|在校证明|实习证明|学历|本科|大专|硕士|专科|专业|编程|代码|英语|外语|口语|实习时长|到岗/;
// 身份/材料类条件（"在读学生""能提供在校证明"）连 must 都不该当：
// 已经毕业的好候选人会被它判成"不符合"，正确做法是直接丢弃。
const IDENTITY_CONDITION_RE = /在读|在校|学生身份|在校证明|实习证明/;
const DOWNGRADE_TO_MUST_RE = /学历|本科|大专|硕士|专科|专业|编程|代码|英语|外语|口语|实习时长|到岗/;

export function capRedlines(rubrics, max = MAX_REDLINES) {
  const list = Array.isArray(rubrics) ? rubrics : [];
  const out = [];
  let kept = 0;
  for (const r of list) {
    if (!r || r.group !== 'redline') {
      out.push(r);
      continue;
    }
    const label = String(r.label || '');
    if (IDENTITY_CONDITION_RE.test(label)) continue; // 身份/材料类条件：既不当红线也不当 must
    if (NOT_A_REDLINE_RE.test(label)) {
      if (DOWNGRADE_TO_MUST_RE.test(label)) {
        out.push({ ...r, group: 'must', weight: Math.min(8, Math.max(5, Number(r.weight) || 6)) });
      }
      continue; // 不配当红线的直接丢弃（不淘汰任何人）
    }
    if (kept >= max) {
      out.push({ ...r, group: 'must', weight: Math.min(8, Math.max(5, Number(r.weight) || 6)) });
      continue;
    }
    kept += 1;
    out.push({ ...r, weight: 0 });
  }
  return out;
}

export function ruleRubricsFromJD(jdText) {
  const text = String(jdText || '');
  const out = [];
  for (const lib of CONDITION_LIBRARY) {
    if (lib.test.test(text)) {
      out.push({
        id: lib.id, group: lib.group, label: lib.label, weight: lib.weight,
        type: lib.type, probe: lib.probe, keywords: lib.keywords,
      });
    }
  }
  if (!out.some((r) => r.group === 'must')) {
    out.unshift(
      { id: 'must_edu', group: 'must', label: '本科及以上学历', weight: 10, type: 'education', probe: '学历与专业', keywords: [] },
      { id: 'must_relevant', group: 'must', label: '有与岗位相关的项目或实习经历', weight: 7, type: 'experience', probe: '相关经历', keywords: [] },
    );
  }
  const softSkipped = SOFT_SKILL_RE.test(text)
    ? ['主动学习与解决问题能力', '沟通与跨文化协作', '对业务的主动性']
    : [];
  return { rubrics: normalizeRubrics(ensureSchoolRubric(out)), softSkipped };
}

// ---------------------------------------------------------------------------
// 规则引擎：结论文案
// ---------------------------------------------------------------------------

export function ruleSummary({ role, profile, score }) {
  const met = score.items.filter((i) => i.verdict === 'met');
  const strengths = met
    .slice(0, 4)
    .map((i) => `${i.label}${i.evidenceRaw?.[0] ? `（${i.evidenceRaw[0].slice(0, 28)}…）` : ''}`);
  const risks = [];
  if (score.mustMissing.length) risks.push(`硬性要求未满足：${score.mustMissing.map((i) => i.label).join('、')}`);
  if (score.mustPartial?.length) risks.push(`硬性要求仅部分满足：${score.mustPartial.map((i) => i.label).join('、')}`);
  if (score.redlineHits.length) risks.push(`触发红线：${score.redlineHits.map((i) => i.label).join('、')}`);
  if (score.redlineUnknown?.length) risks.push(`红线待确认：${score.redlineUnknown.map((i) => i.label).join('、')}`);
  if (score.coveragePct < 80) risks.push(`信息覆盖率 ${score.coveragePct}%，有 ${score.stats.unknown} 项无法从简历确认`);

  const questions = buildQuestions(score);
  const headline =
    score.decision.code === 'review'
      ? `匹配度 ${score.confirmedPct}%，核心要求基本满足`
      : score.decision.code === 'insufficient'
        ? `信息不足，仅 ${score.coveragePct}% 的要求可验证`
        : score.decision.code === 'pending'
          ? `匹配度 ${score.confirmedPct}%，关键项待确认`
          : `匹配度 ${score.confirmedPct}%，硬性条件存在缺口`;

  const top = met[0]?.label || '相关经历';
  const pending = score.items.find((i) => i.verdict === 'unknown') || score.items.find((i) => i.verdict === 'partial');
  const message = `你好，我是公司 HR。看到你在${top}方面有相关经历，和我们「${role || '该岗位'}」比较匹配${
    pending
      ? `。想先确认一下：${pending.type === 'availability' ? '你能连续实习多久、每周可到岗几天' : `关于「${pending.label}」你的具体情况`}`
      : ''
  }？方便的话今天约 10 分钟电话简单聊聊。`;

  return { headline, strengths, risks, questions, message: message.slice(0, 160) };
}

export const __internals = { splitSentences, pickEvidence, rubricKeywords, CONDITION_LIBRARY, detectSchool, isRedlineHit };
