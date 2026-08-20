import {
  listClientsForMonth, computeArLedger, getRentUtilityEntry, computeUtilityPersonalTotal,
  getOfficerPayEntry, resolveOfficerDeductions, getMeta, getMonthStatus, prevMonth,
  listAttachments, addAttachment, removeAttachment,
} from '../db.js';
import { yen, monthLabel, escapeHtml } from '../format.js';
import { renderMonthBar } from './monthbar.js';
import * as gdrive from '../gdrive.js';

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
  const gdriveConfigured = !!getMeta('gdrive_client_id');

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

  container.innerHTML = `
    <div id="month-bar-slot" class="no-print"></div>
    <div class="toolbar no-print">
      <span class="spacer"></span>
      <button class="btn primary" id="print-btn">この月をPDF出力（印刷）</button>
    </div>

    <div class="card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div>
        <div class="card-note" style="margin-bottom:2px">月次報告</div>
        <h2 style="font-size:22px">${escapeHtml(companyName)}</h2>
        <div class="card-note">対象月: ${monthLabel(year, month)}</div>
      </div>
      ${finalized ? `<div class="stamp stamped" style="opacity:1">確定</div>` : ''}
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
        ${gdriveConfigured
          ? 'あなたのGoogleドライブの「Kayley - 証憑」フォルダに保存されます。'
          : 'Google Driveが未設定です。「設定」タブから連携すると、ここでファイルをアップロードできます。'}
      </div>
      <div class="toolbar no-print">
        <label class="btn ghost" style="cursor:${gdriveConfigured ? 'pointer' : 'not-allowed'};${gdriveConfigured ? '' : 'opacity:0.45'}">
          ＋ ファイルを追加
          <input type="file" id="attachment-file" multiple style="display:none" ${gdriveConfigured ? '' : 'disabled'}>
        </label>
        <span id="attachment-upload-status" class="card-note" style="margin:0"></span>
      </div>
      <div id="attachment-list"></div>
    </div>
  `;

  renderMonthBar(container.querySelector('#month-bar-slot'), {
    year, month, onChange: ctx.setMonth, showFinalize: true,
  });

  container.querySelector('#print-btn').addEventListener('click', () => window.print());

  function renderAttachmentList() {
    const items = listAttachments(year, month);
    const listEl = container.querySelector('#attachment-list');
    if (items.length === 0) {
      listEl.innerHTML = `<div class="card-note">まだファイルがありません。</div>`;
      return;
    }
    listEl.innerHTML = `
      <table class="ledger">
        <tbody>
          ${items.map((it) => `
            <tr>
              <td>
                ${it.web_view_link ? `<a href="${escapeHtml(it.web_view_link)}" target="_blank" rel="noopener">${escapeHtml(it.name)}</a>` : escapeHtml(it.name)}
              </td>
              <td class="num no-print"><button class="btn ghost delete-attachment-btn" data-id="${it.id}" data-drive-id="${escapeHtml(it.drive_file_id)}">削除</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
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

  const fileInput = container.querySelector('#attachment-file');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;
      const statusEl = container.querySelector('#attachment-upload-status');
      for (const file of files) {
        statusEl.textContent = `アップロード中… ${file.name}`;
        try {
          const uploaded = await gdrive.uploadFile(file, { year, month });
          addAttachment({
            year, month,
            drive_file_id: uploaded.id,
            name: file.name,
            mime_type: uploaded.mimeType,
            web_view_link: uploaded.webViewLink,
          });
        } catch (err) {
          statusEl.textContent = `失敗: ${file.name}（${err.message}）`;
          return;
        }
      }
      statusEl.textContent = '';
      fileInput.value = '';
      renderAttachmentList();
    });
  }
}
