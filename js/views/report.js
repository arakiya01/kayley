import {
  listClientsForMonth, listClientsForMonths, computeArLedger, getRentUtilityEntry, computeUtilityPersonalTotal,
  getOfficerPayEntry, resolveOfficerDeductions, getMeta, getMonthStatus, prevMonth,
  listAttachments, removeAttachment, getClient,
} from '../db.js';
import {
  yen, monthLabel, escapeHtml, fiscalYearStartOf, fiscalYearMonths,
} from '../format.js';
import { renderMonthBar } from './monthbar.js';
import * as gdrive from '../gdrive.js';
import { renderPdfInto } from '../pdfpreview.js';
import { showMask, updateMask, hideMask } from '../uimask.js';
import { fileChipHtml } from '../fileicon.js';

const DEDUCTION_FIELDS = [
  { key: 'health_insurance', label: '健康保険' },
  { key: 'nursing_care_insurance', label: '介護保険' },
  { key: 'pension', label: '厚生年金' },
  { key: 'child_support_levy', label: '子ども・子育て拠出金' },
  { key: 'withholding_tax', label: '源泉所得税' },
];

export function render(container, ctx) {
  const { year, month } = ctx;
  const companyName = getMeta('company_name') || '';
  const clients = listClientsForMonth(year, month);
  const status = getMonthStatus(year, month);
  const finalized = !!(status && status.finalized);
  const prev = prevMonth(year, month);

  const arRows = clients.map((c) => {
    const ledger = computeArLedger(c);
    const row = ledger.find((r) => r.year === year && r.month === month);
    let opening = c.opening_balance || 0;
    for (const r of ledger) {
      if (r.year * 12 + r.month >= year * 12 + month) break;
      opening = r.closing;
    }
    const sales = row ? row.sales : 0;
    const payment = row ? row.payment : 0;
    return { name: c.name, opening, sales, payment, closing: opening + sales - payment };
  });

  const rentEntry = getRentUtilityEntry(year, month);
  const utilityPersonal = rentEntry ? computeUtilityPersonalTotal(rentEntry) : 0;
  const rentPersonal = rentEntry ? rentEntry.rent_personal_fixed : 0;

  const payEntry = getOfficerPayEntry(year, month);
  const deductions = resolveOfficerDeductions(year, month);
  const deductionRows = payEntry ? DEDUCTION_FIELDS.map((f) => ({ label: f.label, value: payEntry[f.key] || 0 })) : [];
  const deductionTotal = (payEntry ? deductionRows.reduce((a, r) => a + r.value, 0) : 0) + deductions.rent_deduction + deductions.utility_deduction;
  const netPay = payEntry ? payEntry.gross_pay - deductionTotal : 0;

  // 税理士向けサマリー: Kayleyに記録されている範囲の主要科目を、今期の月初〜当月分で累計する
  // （税理士から送られてくる「残高試算表・損益計算書」と同じ科目名で突き合わせやすくするため）。
  const fyStartMonth = Number(getMeta('fiscal_year_start_month') || 4);
  const fyStartYear = fiscalYearStartOf(year, month, fyStartMonth);
  const fyMonths = fiscalYearMonths(fyStartYear, fyStartMonth);
  const uptoIndex = fyMonths.findIndex((m) => m.year === year && m.month === month);
  const monthsToDate = uptoIndex >= 0 ? fyMonths.slice(0, uptoIndex + 1) : fyMonths;
  const monthKeysToDate = new Set(monthsToDate.map((m) => `${m.year}-${m.month}`));

  const salesThisMonth = arRows.reduce((a, r) => a + r.sales, 0);
  const arClosingTotal = arRows.reduce((a, r) => a + r.closing, 0);
  let salesFy = 0;
  listClientsForMonths(fyMonths).forEach((c) => {
    computeArLedger(c).forEach((r) => {
      if (monthKeysToDate.has(`${r.year}-${r.month}`)) salesFy += r.sales;
    });
  });

  const statutoryThisMonth = payEntry
    ? (payEntry.health_insurance || 0) + (payEntry.nursing_care_insurance || 0)
      + (payEntry.pension || 0) + (payEntry.child_support_levy || 0)
    : 0;
  let officerFy = 0, statutoryFy = 0;
  monthsToDate.forEach((m) => {
    const e = getOfficerPayEntry(m.year, m.month);
    if (!e) return;
    officerFy += e.gross_pay || 0;
    statutoryFy += (e.health_insurance || 0) + (e.nursing_care_insurance || 0) + (e.pension || 0) + (e.child_support_levy || 0);
  });

  const rentThisMonth = rentEntry ? rentEntry.rent_total : 0;
  let rentFy = 0;
  monthsToDate.forEach((m) => {
    const e = getRentUtilityEntry(m.year, m.month);
    if (e) rentFy += e.rent_total || 0;
  });

  container.innerHTML = `
    <div id="month-bar-slot" class="no-print"></div>
    <div class="toolbar no-print">
      <span class="spacer"></span>
      <button class="btn primary" id="print-btn">この月をPDF出力（印刷）</button>
    </div>

    <div class="card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div>
        <div class="card-note" style="margin-bottom:2px">月次報告書</div>
        <h2 style="font-size:22px">${escapeHtml(companyName)}</h2>
        <div class="card-note">対象月: ${monthLabel(year, month)}</div>
        <div class="card-note">作成日: ${new Date().toLocaleDateString('ja-JP')}</div>
      </div>
      ${finalized ? `<div class="stamp stamped" style="opacity:1">確定</div>` : ''}
    </div>

    <div class="card">
      <h2>科目別集計</h2>
      <div class="card-note no-print">この一覧はKayleyに記録されている金額から自動集計しています（税理士さんへの確認用）。</div>
      <div class="card-note">※交際費・通信費・保険料など、一部の科目は含まれていません。</div>
      <table class="ledger">
        <thead>
          <tr><th>勘定科目</th><th class="num">${monthLabel(year, month)}</th><th class="num">今期累計</th></tr>
        </thead>
        <tbody>
          <tr><td>売上高</td><td class="num">${yen(salesThisMonth)}</td><td class="num">${yen(salesFy)}</td></tr>
          <tr><td>役員報酬</td><td class="num">${yen(payEntry ? payEntry.gross_pay : 0)}</td><td class="num">${yen(officerFy)}</td></tr>
          <tr><td>法定福利費</td><td class="num">${yen(statutoryThisMonth)}</td><td class="num">${yen(statutoryFy)}</td></tr>
          <tr><td>地代家賃</td><td class="num">${yen(rentThisMonth)}</td><td class="num">${yen(rentFy)}</td></tr>
          <tr><td>売掛金残高（月末時点）</td><td class="num">${yen(arClosingTotal)}</td><td class="num">—</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>売掛金台帳</h2>
      <table class="ledger">
        <thead>
          <tr><th>得意先</th><th class="num">前月繰越</th><th class="num">売上</th><th class="num">入金</th><th class="num">当月残高</th></tr>
        </thead>
        <tbody>
          ${arRows.map((r) => `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td class="num">${yen(r.opening)}</td>
              <td class="num">${yen(r.sales)}</td>
              <td class="num">${yen(r.payment)}</td>
              <td class="num">${yen(r.closing)}</td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td>合計</td>
            <td class="num">${yen(arRows.reduce((a, r) => a + r.opening, 0))}</td>
            <td class="num">${yen(arRows.reduce((a, r) => a + r.sales, 0))}</td>
            <td class="num">${yen(arRows.reduce((a, r) => a + r.payment, 0))}</td>
            <td class="num">${yen(arRows.reduce((a, r) => a + r.closing, 0))}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="card">
      <h2>家賃・光熱費 個人負担</h2>
      <div class="card-note">${monthLabel(year, month)}の実績（翌月の役員報酬から控除されます）</div>
      <table class="ledger">
        <tbody>
          <tr><td>家賃（個人負担・固定）</td><td class="num">${yen(rentPersonal)}</td></tr>
          <tr><td>光熱費（個人負担計）</td><td class="num">${yen(utilityPersonal)}</td></tr>
        </tbody>
        <tfoot>
          <tr><td>合計</td><td class="num">${yen(rentPersonal + utilityPersonal)}</td></tr>
        </tfoot>
      </table>
    </div>

    <div class="card">
      <h2>役員報酬</h2>
      <div class="card-note">家賃・光熱費控除は ${monthLabel(prev.year, prev.month)} 分の実績を反映しています。</div>
      <table class="ledger">
        <tbody>
          <tr><td>支給額</td><td class="num">${yen(payEntry ? payEntry.gross_pay : 0)}</td></tr>
          ${deductionRows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="num">${yen(r.value)}</td></tr>`).join('')}
          <tr><td>家賃控除</td><td class="num">${yen(deductions.rent_deduction)}</td></tr>
          <tr><td>水道光熱費控除</td><td class="num">${yen(deductions.utility_deduction)}</td></tr>
        </tbody>
        <tfoot>
          <tr><td>控除合計</td><td class="num">${yen(deductionTotal)}</td></tr>
          <tr><td>差引支給額</td><td class="num">${yen(netPay)}</td></tr>
        </tfoot>
      </table>
    </div>

    <div class="card">
      <h2>証憑（領収書・請求書）</h2>
      <div class="card-note no-print">
        請求書は売掛金タブの各得意先から、領収書は「経費」タブからアップロードできます。
        「読み込んで表示」を押すと、Googleドライブから中身を取得してこのレポートに埋め込みます（PDF出力にもそのまま含まれます）。
      </div>
      <div class="toolbar no-print">
        <span class="spacer"></span>
        <button class="btn ghost" id="load-previews-btn">画像・PDFを読み込んで表示</button>
        <span id="preview-status" class="card-note" style="margin:0"></span>
      </div>
      <div id="attachment-list"></div>
    </div>
  `;

  renderMonthBar(container.querySelector('#month-bar-slot'), {
    year, month, onChange: ctx.setMonth, showFinalize: true,
  });

  let previewsLoaded = false;
  let loadPromise = null;

  // 画面を開いた時点・印刷ボタンを押した時点、どちらから呼ばれても実行中の読み込みを使い回す
  // （同時に複数回走らせて二重取得・表示のちらつきが起きるのを防ぐ）。
  function startLoadingPreviews() {
    if (!loadPromise) {
      loadPromise = loadPreviews().finally(() => { loadPromise = null; });
    }
    return loadPromise;
  }

  const printBtn = container.querySelector('#print-btn');
  let printing = false;
  printBtn.addEventListener('click', async () => {
    if (printing) return;
    printing = true;
    printBtn.disabled = true;
    try {
      if (!previewsLoaded && listAttachments(year, month).length > 0) {
        showMask('証憑を読み込んでいます…');
        try {
          await startLoadingPreviews();
        } finally {
          hideMask();
        }
      }
      window.print();
    } finally {
      printBtn.disabled = false;
      printing = false;
    }
  });

  function renderAttachmentList() {
    previewsLoaded = false;
    loadPromise = null;
    const items = listAttachments(year, month);
    const listEl = container.querySelector('#attachment-list');
    if (items.length === 0) {
      listEl.innerHTML = `<div class="card-note">まだファイルがありません。</div>`;
      return;
    }

    const groupHtml = (label, groupItems) => {
      if (groupItems.length === 0) return '';
      return `
        <div class="card-note" style="margin:14px 0 4px">${label}</div>
        ${groupItems.map((it) => {
          const client = it.client_id ? getClient(it.client_id) : null;
          return `
            <div class="attachment-item" style="padding:10px 0;border-bottom:1px solid var(--hairline)">
              <div style="display:flex;align-items:center;gap:10px">
                ${fileChipHtml({ name: it.name, webViewLink: it.web_view_link })}
                <span style="flex:1">
                  ${client ? `<span class="card-note" style="margin:0">${escapeHtml(client.name)}</span> ` : ''}
                  ${escapeHtml(it.name)}
                </span>
                <button class="btn ghost no-print delete-attachment-btn" data-id="${it.id}" data-drive-id="${escapeHtml(it.drive_file_id)}">削除</button>
              </div>
              <div class="attachment-preview" data-drive-id="${escapeHtml(it.drive_file_id)}" data-mime="${escapeHtml(it.mime_type || '')}" data-name="${escapeHtml(it.name)}"></div>
            </div>
          `;
        }).join('')}
      `;
    };

    listEl.innerHTML = groupHtml('請求書', items.filter((it) => it.category === 'invoice'))
      + groupHtml('領収書', items.filter((it) => it.category !== 'invoice'));

    listEl.querySelectorAll('.delete-attachment-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('このファイルを削除します。よろしいですか？（Googleドライブ上のファイルも削除されます）')) return;
        btn.disabled = true;
        try {
          if (gdrive.isConnected()) await gdrive.deleteFile(btn.dataset.driveId);
          removeAttachment(Number(btn.dataset.id));
          renderAttachmentList();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  renderAttachmentList();

  // 画面を開いた時点で、すでに接続済みならバックグラウンドで先読みしておく
  // （未接続の場合は何もしない＝印刷ボタンを押すまで接続を試みない、という既存の方針を維持）。
  if (gdrive.isConnected() && listAttachments(year, month).length > 0) {
    startLoadingPreviews();
  }

  function reportProgress(text) {
    const statusEl = container.querySelector('#preview-status');
    if (statusEl) statusEl.textContent = text;
    updateMask(text);
  }

  async function loadPreviews() {
    const btn = container.querySelector('#load-previews-btn');
    const slots = Array.from(container.querySelectorAll('.attachment-preview'));
    if (slots.length === 0) {
      reportProgress('証憑がありません。');
      return;
    }
    btn.disabled = true;
    let done = 0;
    for (const slot of slots) {
      done += 1;
      reportProgress(`読み込み中…（${done}/${slots.length}）`);
      try {
        const blob = await gdrive.downloadFile(slot.dataset.driveId);
        const mime = slot.dataset.mime;
        if (mime.startsWith('image/')) {
          const url = URL.createObjectURL(blob);
          slot.innerHTML = `<img src="${url}" alt="${slot.dataset.name}" style="max-width:100%;margin-top:8px;border:1px solid var(--grid-line);border-radius:3px">`;
        } else if (mime === 'application/pdf') {
          slot.innerHTML = '<div style="margin-top:8px"></div>';
          await renderPdfInto(slot.firstElementChild, blob);
        } else {
          slot.innerHTML = `<div class="card-note" style="margin-top:6px">この形式はプレビューできません。上のリンクから開いてください。</div>`;
        }
      } catch (err) {
        slot.innerHTML = `<div class="card-note" style="margin-top:6px">読み込みに失敗しました: ${escapeHtml(err.message)}</div>`;
      }
    }
    reportProgress('');
    btn.disabled = false;
    previewsLoaded = true;
  }

  const loadPreviewsBtn = container.querySelector('#load-previews-btn');
  if (loadPreviewsBtn) {
    loadPreviewsBtn.addEventListener('click', async () => {
      showMask('証憑を読み込んでいます…');
      try {
        await startLoadingPreviews();
      } finally {
        hideMask();
      }
    });
  }
}
