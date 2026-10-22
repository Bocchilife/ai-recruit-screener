/**
 * 前端逻辑（原生 ES Module，无构建步骤）
 * 数据流：JD → 拆解 rubric → 上传/选样例 → 轮询批次 → 点开某人看「判定 + 证据」
 */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 规则模式全是毫秒级，别显示成 "0.0s"
const ms = (v) => {
  const n = Number(v) || 0;
  return n < 1000 ? `${Math.max(1, Math.round(n))}ms` : `${(n / 1000).toFixed(1)}s`;
};

const DECISION = {
  review: { label: '建议进入人工复核', cls: 'review', color: '#067647' },
  pending: { label: '待定 · 建议补充信息', cls: 'pending', color: '#b54708' },
  reject: { label: '暂缓考虑', cls: 'reject', color: '#b42318' },
  insufficient: { label: '信息不足 · 需补充简历', cls: 'insufficient', color: '#475467' },
};
const VERDICT = {
  met: { label: '符合', cls: 'met' },
  partial: { label: '部分符合', cls: 'partial' },
  missing: { label: '不符合', cls: 'missing' },
  unknown: { label: '待确认', cls: 'unknown' },
};
// 四态的默认折算系数，用来判断某项是否用了更细的加权（如院校层次 985=1 / 211=0.75 / 双一流=0.5）
const VERDICT_SCORE = { met: 1, partial: 0.6, missing: 0, unknown: 0 };
const GROUP = { must: '硬性要求', nice: '加分项', redline: '红线' };

const state = {
  mode: 'rule',
  jd: null, // 后端拆解后的 JD
  run: null,
  candidates: [],
  selectedId: null,
  sort: 'score',
  filter: 'all',
  detail: null,
  pollTimer: null,
  busy: false,
};

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

function toast(msg, isErr = false) {
  // 单槽位：新提示直接顶掉旧的，避免连点按钮时在屏幕上堆一叠。
  const box = $('#toasts');
  box.querySelectorAll('.toast').forEach((old) => old.remove());
  const node = el('div', `toast${isErr ? ' err' : ''}`, esc(msg));
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s ease, transform .3s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 320);
  }, isErr ? 4200 : 2600);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (isJson && (body.error || body.message)) || `请求失败（${res.status}）`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return body;
}

function setBusy(btn, busy, textWhileBusy) {
  if (!btn) return;
  if (busy) {
    btn.dataset.original = btn.textContent;
    btn.disabled = true;
    if (textWhileBusy) btn.textContent = textWhileBusy;
  } else {
    btn.disabled = false;
    if (btn.dataset.original) btn.textContent = btn.dataset.original;
  }
}

// ---------------------------------------------------------------------------
// 启动：拿一下模式（LLM / 规则）
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const health = await api('/api/health');
    const llm = health.llm || {};
    state.mode = llm.mode || health.mode;
    const badge = $('#modeBadge');
    badge.textContent = state.mode === 'llm' ? `LLM 模式 · ${llm.model || '自定义模型'}` : '规则模式（未配置 API Key）';
    badge.className = `mode-badge ${state.mode}`;
    badge.title =
      state.mode === 'llm'
        ? '正在调用真实大模型做逐条判定，分数仍由代码计算'
        : '没有 API Key，自动降级为规则引擎，流程完整可跑';
  } catch (err) {
    $('#modeBadge').textContent = '服务未连接';
    toast(`连不上本地服务：${err.message}`, true);
  }

  const cached = localStorage.getItem('jd-text');
  if (cached) $('#jdInput').value = cached;
  $('#jdInput').addEventListener('input', () => localStorage.setItem('jd-text', $('#jdInput').value));

  await refreshSampleInfo();
}

async function refreshSampleInfo() {
  try {
    const { samples } = await api('/api/samples');
    $('#btnSamples').textContent = `用内置样例简历跑一遍（${samples.length} 份）`;
  } catch {
    /* 样例不可用不影响主流程 */
  }
}

// ---------------------------------------------------------------------------
// 第 1 栏：JD 拆解
// ---------------------------------------------------------------------------

$('#btnSampleJD').addEventListener('click', async () => {
  try {
    const { jd } = await api('/api/sample-jd');
    $('#jdInput').value = jd;
    localStorage.setItem('jd-text', jd);
    toast('已填入示例 JD，点「拆解成评估项」');
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btnParseJD').addEventListener('click', async (e) => {
  const text = $('#jdInput').value.trim();
  if (text.length < 20) return toast('JD 太短了，至少贴一段岗位职责和任职要求', true);
  const btn = e.currentTarget;
  setBusy(btn, true, '拆解中…');
  try {
    const data = await api('/api/jd/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jd: text }),
    });
    state.jd = data;
    renderRubrics(data);
    toast(`已拆出 ${data.rubrics.length} 个评估项`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(btn, false);
  }
});

function renderRubrics(jd) {
  const panel = $('#rubricPanel');
  panel.classList.remove('hidden');
  panel.style.animation = 'none';
  void panel.offsetWidth;
  panel.style.animation = '';

  const list = $('#rubricList');
  list.innerHTML = '';

  for (const group of ['must', 'nice', 'redline']) {
    const items = jd.rubrics.filter((r) => r.group === group);
    if (items.length === 0) continue;
    list.append(el('div', 'rubric-group-title', `${GROUP[group]} · ${items.length}`));
    for (const item of items) {
      const row = el('div', `rubric-row ${group}`);
      row.dataset.id = item.id;

      const label = el('div', 'r-label');
      label.innerHTML = `${esc(item.label)}${item.probe ? `<span class="r-probe">追问点：${esc(item.probe)}</span>` : ''}`;

      const weight = el('input', 'w-input');
      weight.type = 'number';
      weight.min = '1';
      weight.max = '10';
      weight.value = String(item.weight);
      weight.title = '权重 1-10，分数按权重加权';
      weight.addEventListener('change', () => {
        const v = Math.max(1, Math.min(10, Number(weight.value) || 1));
        weight.value = String(v);
        item.weight = v;
        updateTotal();
      });

      const del = el('button', 'r-del', '×');
      del.title = '删掉这条';
      del.addEventListener('click', () => {
        jd.rubrics = jd.rubrics.filter((r) => r.id !== item.id);
        renderRubrics(jd);
      });

      const right = el('div');
      right.style.display = 'flex';
      right.style.gap = '4px';
      right.style.alignItems = 'center';
      if (group !== 'redline') right.append(weight);
      right.append(del);

      row.append(el('span', 'dim', group === 'must' ? '必' : group === 'nice' ? '加' : '线'), label, right);
      list.append(row);
    }
  }

  updateTotal();
  const skipped = jd.softSkipped || [];
  const soft = skipped.length ? `已剔除 ${skipped.length} 条无法判定的软性要求。` : '';
  const warn = jd.warning ? ` ${jd.warning}` : '';
  const note = $('#rubricNote');
  note.textContent = `分数 = 权重 × 系数（符合 1 / 部分 0.6 / 其它 0）。${soft}${warn}`;
  // 完整名单放进 tooltip，正文只留一句结论
  if (skipped.length) note.title = `未参与判定的软性要求：${skipped.join('、')}`;
  // 空态文案跟着当前进度走：JD 还没拆 / 已拆但还没简历，提示的下一步不一样
  const empty = $('#emptyList');
  if (empty) {
    const [title, sub] = empty.querySelectorAll('p');
    title.textContent = '评估表已就绪，还没有候选人。';
    sub.textContent = '把简历拖到上方，或点「用内置样例简历跑一遍」。';
  }

  $('#jdHint').textContent = '权重可改、条目可删，改完直接筛选';
}

function updateTotal() {
  const rubrics = state.jd?.rubrics || [];
  const total = rubrics.filter((r) => r.group !== 'redline').reduce((s, r) => s + r.weight, 0);
  $('#totalWeight').textContent = `硬性 ${rubrics.filter((r) => r.group === 'must').length} 条 · 合计权重 ${total}`;
}

// ---------------------------------------------------------------------------
// 第 2 栏：上传 / 样例 / 轮询
// ---------------------------------------------------------------------------

const dz = $('#dropzone');
dz.addEventListener('click', () => $('#fileInput').click());
dz.addEventListener('dragover', (e) => {
  e.preventDefault();
  dz.classList.add('drag');
});
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) submitFiles(files);
});
$('#fileInput').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  if (files.length) submitFiles(files);
  e.target.value = '';
});

$('#btnSamples').addEventListener('click', async (e) => {
  if (!state.jd) return toast('先在第 1 栏把 JD 拆解成评估项', true);
  const btn = e.currentTarget;
  setBusy(btn, true, '启动中…');
  try {
    const { samples } = await api('/api/samples');
    const res = await api('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jd: state.jd, samples: samples.map((s) => s.name) }),
    });
    startRun(res.runId);
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(btn, false);
  }
});

async function submitFiles(files) {
  if (!state.jd) {
    toast('先在第 1 栏把 JD 拆解成评估项，再上传简历', true);
    $('#jdInput').focus();
    return;
  }
  if (files.length > 20) return toast('一次最多 20 份简历', true);

  const form = new FormData();
  form.append('jd', JSON.stringify(state.jd));
  for (const file of files) form.append('files', file);

  const btn = $('#btnSamples');
  setBusy(btn, true, '上传中…');
  try {
    const res = await api('/api/screen', { method: 'POST', body: form });
    startRun(res.runId);
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(btn, false);
  }
}

function startRun(runId) {
  // 不清空已有结果：新一批简历追加到列表里，前面的仍在（HR 会分批丢简历进来）。
  state.run = { id: runId, status: 'running' };
  $('#runBar').classList.remove('hidden');
  $('#emptyList').classList.add('hidden');
  toast(`已开始处理，结果会追加到下面（当前共 ${state.candidates.length} 位）`);
  poll(runId);
}

/** 按文件名合并新一批结果：不同文件追加，同名文件覆盖（HR 改了简历重传的情况） */
function mergeCandidates(incoming) {
  const previous = state.candidates;
  const byName = new Map(previous.map((c) => [c.fileName, c]));
  for (const c of incoming || []) byName.set(c.fileName, c);
  state.candidates = [...byName.values()];

  // 当前选中的那份若被同名新结果覆盖，跟着切到新 id，否则详情会停在旧数据上
  if (state.selectedId && !state.candidates.some((c) => c.id === state.selectedId)) {
    const oldName = previous.find((c) => c.id === state.selectedId)?.fileName;
    const next = oldName && state.candidates.find((c) => c.fileName === oldName);
    if (next) {
      state.selectedId = next.id;
      refreshDetail(next.id, { silent: true });
    }
  }
}

function stopPoll() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function poll(runId) {
  stopPoll();
  try {
    const run = await api(`/api/run/${runId}`);
    state.run = run;
    mergeCandidates(run.candidates);
    if (state.jd) {
      state.jd.role = run.role || state.jd.role;
    }
    renderRunBar(run);
    renderFilters(state.candidates);
    renderList();

    if (!state.selectedId) {
      const first = state.candidates.find((c) => c.status === 'done');
      if (first) selectCandidate(first.id, { silent: true });
    } else if (state.detail?.status === 'analyzing' || state.detail?.status === 'queued') {
      // 选中的还在跑：随批次刷新
      refreshDetail(state.selectedId, { silent: true });
    }

    if (run.status !== 'done') {
      state.pollTimer = setTimeout(() => poll(runId), 900);
    } else {
      $('#runBar').classList.add('hidden');
      const failed = run.candidates.filter((c) => c.status === 'unparsed' || c.status === 'failed').length;
      toast(
        failed
          ? `本批完成，${failed} 份没能解析，点开看原因`
          : `本批完成：新增 ${run.candidates.length} 份，列表共 ${state.candidates.length} 位候选人`,
      );
    }
  } catch (err) {
    stopPoll();
    $('#runBar').classList.add('hidden');
    toast(`获取进度失败：${err.message}`, true);
  }
}

function renderRunBar(run) {
  if (run.status === 'done') return;
  const done = run.done || 0;
  const total = run.total || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#runBar').classList.remove('hidden');
  $('#runBarText').innerHTML = `<span class="processing">解析与判断中…</span><span>${done} / ${total}</span>`;
  $('#progressFill').style.width = `${pct}%`;
}

// ---------------------------------------------------------------------------
// 列表渲染
// ---------------------------------------------------------------------------

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'review', label: '建议复核' },
  { key: 'pending', label: '待定' },
  { key: 'reject', label: '暂缓' },
  { key: 'insufficient', label: '信息不足' },
];

function renderFilters(candidates) {
  const wrap = $('#filters');
  wrap.innerHTML = '';
  for (const f of FILTERS) {
    const n =
      f.key === 'all'
        ? candidates.length
        : candidates.filter((c) => (c.decision?.code || fallbackCode(c)) === f.key).length;
    const chip = el('button', `chip${state.filter === f.key ? ' on' : ''}`, `${f.label}<span class="n">${n}</span>`);
    chip.addEventListener('click', () => {
      state.filter = f.key;
      renderFilters(candidates);
      renderList();
    });
    wrap.append(chip);
  }
  const sortSel = el('select', 'chip');
  sortSel.style.height = '26px';
  sortSel.innerHTML = `
    <option value="score">按匹配度</option>
    <option value="coverage">按信息覆盖</option>
    <option value="name">按文件名</option>`;
  sortSel.value = state.sort;
  sortSel.addEventListener('change', () => {
    state.sort = sortSel.value;
    renderList();
  });
  wrap.append(sortSel);
}

function fallbackCode(c) {
  if (c.status === 'unparsed' || c.status === 'failed') return 'insufficient';
  return 'pending';
}

function sortedFiltered() {
  let list = [...state.candidates];
  if (state.filter !== 'all') list = list.filter((c) => (c.decision?.code || fallbackCode(c)) === state.filter);
  const scoreOf = (c) => (c.status === 'done' ? c.confirmedPct ?? -1 : -2);
  if (state.sort === 'score') list.sort((a, b) => scoreOf(b) - scoreOf(a));
  else if (state.sort === 'coverage') list.sort((a, b) => (b.coveragePct ?? -1) - (a.coveragePct ?? -1));
  else list.sort((a, b) => String(a.fileName).localeCompare(String(b.fileName), 'zh'));
  return list;
}

function renderList() {
  const list = $('#candList');
  const items = sortedFiltered();
  list.innerHTML = '';
  $('#candCount').textContent = state.candidates.length ? `${state.candidates.length} 份简历` : '';
  $('#emptyList').classList.toggle('hidden', items.length > 0);

  items.forEach((c, idx) => {
    const li = el('li', `cand${state.selectedId === c.id ? ' on' : ''}${c.status === 'unparsed' || c.status === 'failed' ? ' cand-failed' : ''}`);
    li.style.animationDelay = `${Math.min(idx * 28, 240)}ms`;
    li.addEventListener('click', () => selectCandidate(c.id));

    const pending = c.status === 'queued' || c.status === 'parsing' || c.status === 'analyzing';
    const code = c.decision?.code || fallbackCode(c);
    const meta = DECISION[code] || DECISION.pending;
    const pct = c.confirmedPct;

    // 左：分数环（未完成时显示占位）
    const ring = el('div', 'ring');
    if (pending) {
      ring.style.setProperty('--rv', '0');
      ring.style.setProperty('--rc', '#d0d5dd');
      ring.style.setProperty('--rbg', '#eef1f5');
      ring.innerHTML = '<b><i>…</i></b>';
      ring.classList.add('processing');
    } else if (pct === null || pct === undefined) {
      ring.style.setProperty('--rv', '0');
      ring.style.setProperty('--rc', '#d0d5dd');
      ring.style.setProperty('--rbg', '#eef1f5');
      ring.innerHTML = '<b><i>—</i></b>';
    } else {
      ring.style.setProperty('--rv', String(pct));
      ring.style.setProperty('--rc', meta.color);
      ring.style.setProperty('--rbg', '#eef1f5');
      ring.innerHTML = `<b>${pct}<i>%</i></b>`;
    }

    // 中：姓名 + 文件 + 标签
    const main = el('div', 'cand-main');
    const nameRow = el('div', 'cand-name', `${esc(c.name)}`);
    // 只有"本该走模型、却降级成规则"的那份才值得单独标出来，
    // 全批都是规则模式时每行都挂一个"规则"标签只是噪音。
    if (c.degraded && state.mode === 'llm') {
      const tag = el('span', 'mini-tag warn', '已降级');
      tag.title = c.warning || '这份简历的模型判定失败，已用规则引擎给出结果';
      nameRow.append(tag);
    }
    main.append(nameRow);
    main.append(el('div', 'cand-file', esc(c.fileName)));

    const tags = el('div', 'cand-tags');
    if (pending) {
      tags.append(el('span', 'mini-tag', c.status === 'parsing' ? '解析中' : c.status === 'queued' ? '排队中' : '判断中'));
    } else if (c.status === 'unparsed' || c.status === 'failed') {
      tags.append(el('span', 'mini-tag warn', c.error?.code === 'SCANNED_PDF' ? '扫描件 · 无文本层' : '解析失败'));
    } else {
      (c.mustMissing || []).slice(0, 2).forEach((m) => tags.append(el('span', 'mini-tag warn', `缺口：${m.length > 14 ? m.slice(0, 14) + '…' : m}`)));
      if (c.coveragePct !== null && c.coveragePct < 80) tags.append(el('span', 'mini-tag unk', `信息覆盖 ${c.coveragePct}%`));
      (c.skills || []).slice(0, 3).forEach((s) => tags.append(el('span', 'mini-tag', s)));
    }
    main.append(tags);
    if (pending) li.classList.add('processing');

    // 右：结论
    const right = el('div', 'cand-right');
    if (pending) right.append(el('span', 'pill pending', c.status === 'analyzing' ? '判断中' : '处理中'));
    else if (c.status === 'unparsed' || c.status === 'failed') right.append(el('span', 'pill failed', '未解析'));
    else right.append(el('span', `pill ${meta.cls}`, meta.label));

    li.append(ring, main, right);
    list.append(li);
  });
}

// ---------------------------------------------------------------------------
// 第 3 栏：详情
// ---------------------------------------------------------------------------

function detailEmptyNode() {
  const wrap = el('div', 'detail-empty');
  wrap.innerHTML = `
    <div class="de-illu"><span>匹配度</span><b>88%</b><i>每一项都可点开看证据</i></div>
    <h3>选中一位候选人，看他是怎么被判断的</h3>
    <ul class="de-points">
      <li><b>四条判定</b>符合 / 部分符合 / 不符合 / <em>待确认</em></li>
      <li><b>证据溯源</b>每句理由都指向简历原文</li>
      <li><b>追问清单</b>简历没写的不猜，直接生成问题</li>
      <li><b>触达话术</b>一键复制，HR 直接用</li>
    </ul>`;
  return wrap;
}

async function selectCandidate(id, opts = {}) {
  state.selectedId = id;
  renderList();
  $('#detail').innerHTML = '<div class="detail-card"><div class="skeleton" style="height:120px;margin-bottom:12px"></div><div class="skeleton" style="height:26px;width:60%;margin-bottom:10px"></div><div class="skeleton" style="height:160px"></div></div>';
  await refreshDetail(id, opts);
}

async function refreshDetail(id, opts = {}) {
  if (state.selectedId !== id) return;
  try {
    const data = await api(`/api/candidate/${id}`);
    if (state.selectedId !== id) return;
    state.detail = data;
    renderDetail(data);
  } catch (err) {
    if (!opts.silent) toast(err.message, true);
    $('#detail').innerHTML = '';
    $('#detail').append(el('div', 'detail-empty', `<h3>加载失败</h3><p class="dim">${esc(err.message)}</p>`));
  }
}

function renderDetail(c) {
  const box = $('#detail');
  box.innerHTML = '';

  if (c.status === 'unparsed' || c.status === 'failed') {
    const wrap = el('div', 'detail-card');
    wrap.innerHTML = `
      <div class="d-head">
        <div class="d-title"><h3>${esc(c.fileName)}</h3><p>这份简历没有进入打分环节</p></div>
        <span class="pill failed">未解析</span>
      </div>
      <div class="reason-box"><b>${esc(c.error?.code || '解析失败')}</b>：${esc(c.error?.message || '未知错误')}</div>
      ${c.error?.hint ? `<div class="msg-box">${esc(c.error.hint)}</div>` : ''}
      <p class="fineprint">这一条故意留在结果里：真实初筛里"读不出来的简历"必须先被人看到，而不是被静默丢弃。</p>`;
    box.append(wrap);
    return;
  }

  if (!c.score) {
    box.append(el('div', 'detail-card', '<div class="skeleton" style="height:80px;margin-bottom:10px"></div><div class="skeleton" style="height:200px"></div>'));
    return;
  }

  const code = c.score.decision?.code || 'pending';
  const meta = DECISION[code] || DECISION.pending;
  const verified = (c.score.items || []).flatMap((i) => i.evidence || []);
  const okCount = verified.filter((e) => e.verified).length;
  const stats = c.score.stats || {};

  const card = el('div', 'detail-card');

  // 头部
  card.innerHTML = `
    <div class="d-head">
      <div class="d-title">
        <h3>${esc(c.profile?.name || '未识别姓名')}</h3>
        <p>${esc(c.fileName)}</p>
        <div class="d-headline">${esc(c.summary?.headline || '')}</div>
      </div>
      <div class="ring big" style="--rv:${c.score.confirmedPct};--rc:${meta.color};--rbg:#eef1f5">
        <b>${c.score.confirmedPct}<i>%</i></b>
      </div>
    </div>
    <div class="d-meta">
      <span class="pill ${meta.cls}">${meta.label}</span>
      <span class="meta-chip">信息覆盖 <b>${c.score.coveragePct}%</b></span>
      <span class="meta-chip ${okCount === verified.length && verified.length ? 'ok' : okCount ? 'warn' : ''}">证据 <b>${okCount}/${verified.length}</b> 已核验</span>
      <span class="meta-chip">耗时 <b>${ms(c.meta?.elapsedMs)}</b></span>
      <span class="meta-chip">${c.mode === 'llm' && !c.degraded ? 'LLM 判定' : '规则判定'}</span>
    </div>
    <div class="reason-box">结论依据：<b>${esc(c.score.decision?.reason || '')}</b></div>
    ${c.degraded && c.warning ? `<div class="degrade-note">本份已降级为规则判定：${esc(c.warning)}</div>` : ''}
    <div class="d-meta">
      <span class="meta-chip">符合 <b>${stats.met ?? 0}</b></span>
      <span class="meta-chip">部分 <b>${stats.partial ?? 0}</b></span>
      <span class="meta-chip">不符合 <b>${stats.missing ?? 0}</b></span>
      <span class="meta-chip warn">待确认 <b>${stats.unknown ?? 0}</b></span>
    </div>`;
  box.append(card);

  // 判定明细
  const title = el('div', 'section-title', `判定明细<span class="n">${(c.score.items || []).length} 项</span>`);
  card.append(title);

  const groups = ['must', 'nice', 'redline'];
  for (const g of groups) {
    const items = (c.score.items || []).filter((i) => i.group === g);
    if (!items.length) continue;
    card.append(el('div', 'rubric-group-title', GROUP[g]));
    for (const item of items) {
      const v = VERDICT[item.verdict] || VERDICT.unknown;
      const row = el('div', 'verdict-item');
      const head = el('div', 'vi-head');
      head.append(el('span', `verdict ${v.cls}`, v.label));
      head.append(el('span', 'vi-label', esc(item.label)));
      const factor = Number(item.factor);
      const finer = Number.isFinite(factor) && (item.id === 'nice_school' || Math.abs(factor - (VERDICT_SCORE[item.verdict] ?? 0)) > 1e-6);
      if (finer) {
        const chip = el('span', 'vi-weight', `×${factor}`);
        chip.title =
          item.id === 'nice_school'
            ? '院校层次按公开事实加权：985 = 1、211 = 0.75、双一流 = 0.5、港澳/海外 = 0.6、普通本科/专科 = 0'
            : '该项按细分比例计分';
        head.append(chip);
      }
      head.append(el('span', 'vi-weight', g === 'redline' ? '红线' : `权重 ${item.weight}`));
      row.append(head);
      if (item.reason) row.append(el('div', 'vi-reason', esc(item.reason)));

      const evs = item.evidence || [];
      if (evs.length) {
        const ul = el('ul', 'vi-evidence');
        for (const e of evs) {
          const li = el('li', e.verified ? '' : 'unverified');
          li.innerHTML = `<em>${e.verified ? '原文' : '未核验'}</em><span class="q">${esc(e.quote)}</span>`;
          ul.append(li);
        }
        row.append(ul);
      } else if (item.verdict === 'unknown') {
        row.append(el('div', 'vi-reason', '简历里没有对应表述 —— 不下结论，转成追问。'));
      }
      card.append(row);
    }
  }

  // 追问清单
  const qs = c.summary?.questions || [];
  if (qs.length) {
    card.append(el('div', 'section-title', `追问清单<span class="n">${qs.length} 条</span>`));
    const ul = el('ul', 'q-list');
    qs.forEach((q) => ul.append(el('li', '', esc(q))));
    card.append(ul);
  }

  // 优势 / 风险
  const strengths = c.summary?.strengths || [];
  const risks = c.summary?.risks || [];
  if (strengths.length || risks.length) {
    card.append(el('div', 'section-title', '优势与风险'));
    const box2 = el('div', 'reason-box');
    box2.innerHTML = `
      ${strengths.length ? `<div><b>优势</b></div><ul class="de-points" style="margin-top:4px">${strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${risks.length ? `<div style="margin-top:8px"><b>风险</b></div><ul class="de-points" style="margin-top:4px">${risks.map((s) => `<li style="color:var(--amber)">${esc(s)}</li>`).join('')}</ul>` : ''}`;
    card.append(box2);
  }

  // 触达话术
  if (c.summary?.message) {
    card.append(el('div', 'section-title', '触达话术'));
    const msg = el('div', 'msg-box', esc(c.summary.message));
    const copy = el('button', 'copy', '复制');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(c.summary.message);
        copy.textContent = '已复制';
        setTimeout(() => (copy.textContent = '复制'), 1400);
      } catch {
        toast('浏览器不允许剪贴板，手动选一下文字吧', true);
      }
    });
    msg.append(copy);
    card.append(msg);
  }

  // 底部动作
  const actions = el('div', 'd-actions');
  if (qs.length) {
    const copyAll = el('button', 'secondary', '复制追问清单');
    copyAll.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(qs.map((q, i) => `${i + 1}. ${q}`).join('\n'));
        toast('已复制，可直接发给候选人');
      } catch {
        toast('浏览器不允许剪贴板', true);
      }
    });
    actions.append(copyAll);
  }
  card.append(actions);
}

// ---------------------------------------------------------------------------
// 顶栏
// ---------------------------------------------------------------------------

$('#btnReset').addEventListener('click', () => {
  stopPoll();
  state.run = null;
  state.candidates = [];
  state.selectedId = null;
  state.detail = null;
  state.filter = 'all';
  $('#candList').innerHTML = '';
  $('#filters').innerHTML = '';
  $('#candCount').textContent = '';
  $('#runBar').classList.add('hidden');
  $('#emptyList').classList.remove('hidden');
  const detail = $('#detail');
  detail.innerHTML = '';
  detail.append(detailEmptyNode());
  toast('已清空名单，JD 保留');
});

boot();

