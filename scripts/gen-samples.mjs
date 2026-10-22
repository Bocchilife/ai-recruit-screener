/**
 * 生成 10 份中文样例简历 PDF（虚构数据，仅用于 Demo）。
 * 运行：npm run samples
 *
 * 刻意覆盖：强匹配 / 学历专业不符 / 关键信息缺口 / 转专业自学 / 英文简历 /
 *          外贸跨界 / 扫描件（无文本层）/ 信息极简 / 站内消息式短文本 / 可实习时长不足
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'samples');

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
];
const FONT = FONT_CANDIDATES.find((f) => fs.existsSync(f));

const A4 = { size: 'A4', margin: 54 };
const WIDTH = 595.28 - 108;

/** 中英混排按显示宽度折行（pdfkit 默认只按空格断行，中文会溢出） */
function wrapLines(doc, text, width) {
  const tokens = String(text).match(/[\u4e00-\u9fa5]|[A-Za-z0-9@._+#/:%()\-–—]+|\s+|[^\s]/g) || [];
  const lines = [];
  let cur = '';
  for (const token of tokens) {
    const next = cur + token;
    if (cur && doc.widthOfString(next) > width) {
      lines.push(cur.trimEnd());
      cur = token === ' ' ? '' : token;
    } else {
      cur = next;
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

function paragraph(doc, text, { size = 10, gap = 4, color = '#222' } = {}) {
  doc.fontSize(size).fillColor(color);
  for (const line of wrapLines(doc, text, WIDTH)) doc.text(line, { lineGap: 1.5 });
  doc.moveDown(gap / 6);
}

function sectionTitle(doc, title) {
  doc.moveDown(0.45);
  doc.fontSize(11.5).fillColor('#0b6b5e').text(title);
  doc
    .moveTo(doc.page.margins.left, doc.y + 2)
    .lineTo(doc.page.margins.left + WIDTH, doc.y + 2)
    .lineWidth(0.8)
    .strokeColor('#cfe6e1')
    .stroke();
  doc.moveDown(0.35);
}

function renderResume(doc, resume) {
  doc.fontSize(19).fillColor('#111').text(resume.name);
  doc.moveDown(0.15);
  doc.fontSize(9.5).fillColor('#555').text(resume.contact);
  doc.moveDown(0.2);

  for (const block of resume.blocks) {
    sectionTitle(doc, block.title);
    for (const item of block.items) {
      if (item.startsWith('##')) {
        paragraph(doc, item.slice(2).trim(), { size: 10.5, color: '#111', gap: 2 });
      } else if (item.startsWith('- ')) {
        paragraph(doc, `· ${item.slice(2)}`, { size: 9.8, color: '#333', gap: 2 });
      } else {
        paragraph(doc, item, { size: 9.8, color: '#333', gap: 3 });
      }
    }
  }
}

function writePdf(fileName, resume) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(A4);
    const stream = fs.createWriteStream(path.join(OUT_DIR, fileName));
    doc.pipe(stream);
    if (FONT) doc.registerFont('cn', FONT);
    doc.font(FONT ? 'cn' : 'Helvetica');
    renderResume(doc, resume);
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

/** 扫描件：只有图形与色块，没有文本层 → 用于演示"需要 OCR"的分支 */
function writeScannedPdf(fileName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument(A4);
    const stream = fs.createWriteStream(path.join(OUT_DIR, fileName));
    doc.pipe(stream);
    doc.rect(0, 0, 595.28, 841.89).fill('#f3f1ec');
    doc.rect(54, 60, 180, 16).fill('#c9c5bb');
    doc.rect(54, 90, 320, 9).fill('#d8d5cc');
    doc.rect(54, 104, 260, 9).fill('#d8d5cc');
    doc.rect(54, 140, 90, 9).fill('#b9d3cd');
    for (let i = 0; i < 7; i++) {
      doc.rect(54, 165 + i * 15, 380 - i * 12, 8).fill('#dcd9d0');
    }
    doc.rect(54, 300, 90, 9).fill('#b9d3cd');
    for (let i = 0; i < 9; i++) {
      doc.rect(54, 325 + i * 15, 420 - (i % 3) * 30, 8).fill('#dcd9d0');
    }
    doc.rect(430, 60, 110, 140).fill('#e2ded4');
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

const RESUMES = [
  {
    file: '01-张思远-AI工作流强匹配.pdf',
    name: '张思远',
    contact: '男 | 2003.06 | 13800138001 | zhangsiyuan@example.com | 现居武汉',
    blocks: [
      {
        title: '教育背景',
        items: [
          '##2023.09 - 2027.06  华中科技大学  计算机科学与技术  本科（在读，2027 届）',
          '- GPA 3.6/4.0，主修数据结构、数据库系统、机器学习导论',
        ],
      },
      {
        title: '实习经历',
        items: [
          '##2025.07 - 2025.10  深圳恒通跨境贸易有限公司  运营实习生',
          '- 用 Coze 搭建多语言客服问答机器人，覆盖 6 个海外站点，人工回复量下降约 40%',
          '- 用 n8n 与 Python 抓取海关及竞品数据，自动生成周报，每周节省约 3 小时',
        ],
      },
      {
        title: '项目经历',
        items: [
          '##2025.03 - 2025.06  AI 外贸选品助手（个人项目）',
          '- Python + FastAPI + OpenAI API 实现选品分析：输入关键词自动输出市场容量、竞品价格带与切入建议',
          '- 用 LangChain 编排检索、比价、文案三个 Agent，单次分析耗时 3 分钟',
        ],
      },
      {
        title: '技能与语言',
        items: [
          '- 编程：Python、JavaScript、SQL，熟悉 Git 与 Linux 基础操作',
          '- AI：熟练使用 Claude、GPT 做信息整理与文案生成，累计搭建 12 个 n8n / Coze 工作流',
          '- 设计：Figma 基础，能出简单原型与视觉素材',
          '- 语言：英语 CET-6（578 分），可参与英文周会',
        ],
      },
      {
        title: '实习安排',
        items: ['- 2026 年 2 月起可连续实习 6 个月，每周到岗 4 天'],
      },
    ],
  },
  {
    file: '02-李佳怡-专业与技能不符.pdf',
    name: '李佳怡',
    contact: '女 | 2004.11 | 13900139002 | lijy@example.com | 现居武汉',
    blocks: [
      {
        title: '教育背景',
        items: ['##2023.09 - 2026.06  武汉职业技术学院  市场营销  大专（在读）'],
      },
      {
        title: '实习经历',
        items: [
          '##2025.06 - 2025.09  武汉星禾电商有限公司  新媒体运营实习生',
          '- 负责小红书与抖音账号内容策划，单条最高播放 12 万',
          '- 用 ChatGPT 辅助写短视频脚本与商品文案',
        ],
      },
      {
        title: '技能',
        items: [
          '- 熟练使用 Excel 做商品数据统计，会用剪映做短视频剪辑',
          '- 无编程基础，没有接触过 Python，也没写过代码',
          '- 英语一般，能读写简单邮件',
        ],
      },
      { title: '实习安排', items: ['- 可实习 3 个月，每周 5 天'] },
    ],
  },
  {
    file: '03-王浩然-关键信息缺口.pdf',
    name: '王浩然',
    contact: '男 | 2003.01 | 13700137003 | wanghaoran@example.com | 现居南京',
    blocks: [
      {
        title: '教育背景',
        items: ['##2022.09 - 2026.06  南京理工大学  软件工程  本科（在读，2026 届）'],
      },
      {
        title: '项目经历',
        items: [
          '##2025.04 - 2025.08  多智能体研报生成器',
          '- Python + LangGraph 实现检索 → 摘要 → 交叉验证 → 输出研报，单篇耗时从 4 小时降到 20 分钟',
          '- 用 Dify 搭了一套客户询盘自动分类与回复建议流程，在合作的外贸公司试用',
          '##2024.11 - 2025.02  校园二手交易平台',
          '- React + Node.js 全栈开发，注册用户 1200 人，日均订单 30 单',
        ],
      },
      {
        title: '技能与语言',
        items: [
          '- Python、JavaScript、SQL、LangChain、LangGraph、Dify、n8n、Git',
          '- 英语 CET-6 已通过，读写流利',
        ],
      },
    ],
  },
  {
    file: '04-陈子墨-转专业自学.pdf',
    name: '陈子墨',
    contact: '男 | 2003.08 | 13600136004 | chenzimo@example.com | 现居合肥',
    blocks: [
      {
        title: '教育背景',
        items: ['##2022.09 - 2026.06  合肥工业大学  机械设计制造及其自动化  本科（在读，2026 届）'],
      },
      {
        title: '自学经历',
        items: [
          '- 2024.03 起系统自学 Python，完成 Coursera《Python for Everybody》全部课程',
          '- 用 Cursor 与 Claude 从零做了小红书爆款标题生成器，累计 800 次以上使用',
        ],
      },
      {
        title: '项目经历',
        items: [
          '##2025.05 - 2025.09  展会客户线索自动清洗工具',
          '- Python + Playwright 抓取公开展会名录，用大模型判断公司是否为目标行业，输出可跟进名单',
          '- 结果写入飞书多维表格，销售团队可直接使用',
        ],
      },
      {
        title: '技能与语言',
        items: ['- Python（熟练）、Playwright、飞书开放平台、Coze 基础、Excel 数据透视', '- 英语 CET-4（512 分）'],
      },
      { title: '实习安排', items: ['- 可实习 3 个月，每周 3 天，春季学期课程少时可增加到 5 天'] },
    ],
  },
  {
    file: '05-Emily Chen-英文简历.pdf',
    name: 'EMILY CHEN',
    contact: 'Shanghai | +86 135 0013 5005 | emily.chen@example.com',
    blocks: [
      {
        title: 'EDUCATION',
        items: [
          '##2022.09 - 2026.06  Fudan University  Bachelor of Science in Computer Science (expected)',
          '- GPA 3.8/4.0; coursework: Data Structures, Databases, Machine Learning',
        ],
      },
      {
        title: 'INTERNSHIP',
        items: [
          '##2025.06 - 2025.09  Riverbay Trading (Shanghai)  Cross-border Operations Intern',
          '- Built a competitor-monitoring workflow in n8n pulling 40+ Amazon listings daily, cutting manual research from 6h to 20min per week',
          '- Drafted English product briefs for the Middle East market, reviewed by the sales director',
        ],
      },
      {
        title: 'PROJECTS',
        items: [
          '##2025.01 - 2025.04  Recruiting Screening Prototype',
          '- Python + OpenAI API: JD-to-rubric parser with evidence-grounded verdicts, 30 resumes in 4 minutes',
          '- Used LangChain and Claude to auto-generate follow-up questions for missing information',
        ],
      },
      {
        title: 'SKILLS & LANGUAGES',
        items: [
          '- Python, TypeScript, SQL, LangChain, n8n, Figma, Git',
          '- IELTS 7.5 (2025); Mandarin native; English professional working proficiency',
        ],
      },
      { title: 'AVAILABILITY', items: ['- Available for a 6-month internship starting Feb 2026, 4 days per week'] },
    ],
  },
  {
    file: '06-刘婷-外贸业务跨界.pdf',
    name: '刘婷',
    contact: '女 | 1999.05 | 13400134006 | liuting@example.com | 现居义乌',
    blocks: [
      {
        title: '教育背景',
        items: ['##2017.09 - 2021.06  浙江外国语学院  英语  本科'],
      },
      {
        title: '工作经历',
        items: [
          '##2021.07 - 2024.12  义乌市博远进出口有限公司  外贸业务员',
          '- 独立维护 30 个以上中东与东南亚客户，年销售额 320 万美元',
          '- 用 Coze 搭建客户询盘自动分类与报价模板生成流程，回复时效从 4 小时缩短到 30 分钟',
          '- 用 Python 与 openpyxl 写过订单数据自动汇总脚本，每周节省 2 小时',
        ],
      },
      {
        title: '技能与语言',
        items: ['- 英语专业八级（TEM-8），可独立与海外客户谈判', '- Python 基础、openpyxl、Excel 高级函数、Coze、剪映'],
      },
      { title: '实习安排', items: ['- 已离职，2025 年起可连续实习 6 个月，可全职投入'] },
    ],
  },
  {
    file: '07-扫描件简历-需OCR.pdf',
    scanned: true,
  },
  {
    file: '08-赵一鸣-信息极简.pdf',
    name: '赵一鸣',
    contact: '男 2003 | 13700137008',
    blocks: [
      {
        title: '基本情况',
        items: ['##南京理工大学  计算机科学与技术  本科  2026 届', '- 技能：Python、Excel'],
      },
    ],
  },
  {
    file: '10-周牧-可实习时长不足.pdf',
    name: '周牧',
    contact: '男 | 2003.03 | 13300133010 | zhoumu@example.com | 现居深圳',
    blocks: [
      {
        title: '教育背景',
        items: ['##2022.09 - 2026.06  深圳大学  人工智能  本科（在读，2026 届）'],
      },
      {
        title: '实习经历',
        items: [
          '##2025.05 - 2025.08  深圳云汇 SaaS 有限公司  AI 应用实习生',
          '- 用 Dify 搭建内部知识库问答，服务 200 名以上员工，答案采纳率 78%',
          '- 用 Python 封装 OpenAI API 做批量合同要素提取，处理 5000 份以上合同',
        ],
      },
      {
        title: '项目经历',
        items: [
          '##2025.01 - 2025.03  外贸询盘自动回复 Agent',
          '- LangGraph + 飞书机器人，按客户所在国家自动切换语气与货币单位',
        ],
      },
      {
        title: '技能与语言',
        items: ['- Python、JavaScript、LangChain、LangGraph、Dify、n8n、Figma', '- 英语 CET-6，雅思 6.5'],
      },
      { title: '实习安排', items: ['- 目前课程安排较满，只能连续实习 2 个月，每周到岗 2 天'] },
    ],
  },
];

const TXT_RESUME = {
  file: '09-孙悦-站内消息.txt',
  content: `你好，我是孙悦，2026 届毕业生，目前人在杭州。

本科读的是信息管理与信息系统专业，学过 Python 和 SQL，做过一个用 ChatGPT 批量改写商品标题的小工具，也帮学院老师整理过海外期刊的数据。

之前在一家货代公司实习过两个月，主要做单证整理和客户邮件回复，英语能读写但不能深聊。

看到你们这个 AI 自动化实习岗位很感兴趣，想了解一下具体做什么、需要什么基础。我每周可以到岗 3 天，能实习 4 个月左右。谢谢！
`,
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!FONT) {
    console.warn('⚠ 未找到中文字体，生成的 PDF 中文可能显示异常');
  }
  let count = 0;
  for (const resume of RESUMES) {
    if (resume.scanned) await writeScannedPdf(resume.file);
    else await writePdf(resume.file, resume);
    count++;
  }
  fs.writeFileSync(path.join(OUT_DIR, TXT_RESUME.file), TXT_RESUME.content, 'utf8');
  count++;
  console.log(`✓ 已生成 ${count} 份样例简历到 samples/`);
}

main().catch((err) => {
  console.error('生成失败：', err);
  process.exit(1);
});
