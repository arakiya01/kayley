// Excel/Googleスプレッドシートから範囲コピーした内容を、貼り付け先のセルを起点に
// 行・列方向へそのまま流し込む（スプレッドシートの範囲貼り付けと同じ挙動）。
export function enableGridPaste(tableEl, inputSelector) {
  tableEl.addEventListener('paste', (e) => {
    const target = e.target;
    if (!target.matches(inputSelector)) return;
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;
    e.preventDefault();

    const rows = Array.from(tableEl.querySelectorAll('tbody tr'));
    const startRowIdx = rows.findIndex((r) => r.contains(target));
    if (startRowIdx === -1) return;
    const startRowInputs = Array.from(rows[startRowIdx].querySelectorAll(inputSelector));
    const startColIdx = startRowInputs.indexOf(target);
    if (startColIdx === -1) return;

    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();

    lines.forEach((line, r) => {
      const row = rows[startRowIdx + r];
      if (!row) return;
      const inputs = Array.from(row.querySelectorAll(inputSelector));
      line.split('\t').forEach((cellText, c) => {
        const input = inputs[startColIdx + c];
        if (!input) return;
        const cleaned = cellText.trim().replace(/[,¥\s]/g, '');
        input.value = cleaned === '' ? '' : (Number.isFinite(Number(cleaned)) ? Number(cleaned) : cellText.trim());
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  });
}
