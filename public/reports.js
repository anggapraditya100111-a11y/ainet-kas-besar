'use strict';

function reportQuery(form) {
  const values = Object.fromEntries(new FormData(form));
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    const text = String(value || '').trim();
    if (text) query.set(key, text);
  });
  return query;
}

function reportDownload(path, query) {
  const anchor = document.createElement('a');
  anchor.href = `${path}?${query.toString()}`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function allTransactionAccountOptions(selected = '') {
  return (state.master?.categories || []).map(item =>
    `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${esc(item.code)} · ${esc(item.name)}</option>`
  ).join('');
}

renderLedger = async function renderLedgerWithFilters() {
  await loadCommon();
  const month = today().slice(0, 7);
  const defaultFrom = `${month}-01`;
  $('#content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h3>Filter Buku Kas Besar</h3><div class="muted">Filter laporan lalu download PDF/Excel sesuai data yang sedang ditampilkan.</div></div></div>
      <form id="ledgerReportFilter" class="toolbar">
        <label>Dari<input type="date" name="from" value="${defaultFrom}" required></label>
        <label>Sampai<input type="date" name="to" value="${today()}" required></label>
        <label>Akun Dana<select name="accountId"><option value="">Semua Akun Dana</option>${state.accounts.map(a => `<option value="${a.accountId}">${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select></label>
        <label>Akun Transaksi<select name="transactionAccountId"><option value="">Semua Akun Transaksi</option>${allTransactionAccountOptions()}</select></label>
        <label>Arah<select name="direction"><option value="">Semua</option><option value="IN">Masuk</option><option value="OUT">Keluar</option></select></label>
        <label>Pencarian<input name="q" placeholder="No transaksi / keterangan / referensi"></label>
        <button class="primary" type="submit">Tampilkan</button>
        <button class="ghost" type="button" id="ledgerReset">Reset</button>
        <button class="ghost" type="button" id="ledgerPdf">Download PDF</button>
        <button class="ghost" type="button" id="ledgerExcel">Download Excel</button>
      </form>
    </div>
    <div id="ledgerReportResult"></div>`;

  const load = async () => {
    const form = $('#ledgerReportFilter');
    const query = reportQuery(form);
    const data = await api(`/api/reports/ledger?${query.toString()}`);
    $('#ledgerReportResult').innerHTML = `
      <div class="cards">
        <div class="card"><span>Total Masuk</span><strong class="money in">${money(data.totalIn)}</strong></div>
        <div class="card"><span>Total Keluar</span><strong class="money out">${money(data.totalOut)}</strong></div>
        <div class="card"><span>Net Arus Kas</span><strong class="${data.net >= 0 ? 'money in' : 'money out'}">${money(data.net)}</strong></div>
        <div class="card"><span>Jumlah Transaksi</span><strong>${Number(data.rows.length).toLocaleString('id-ID')}</strong></div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Buku Kas Besar</h3><span class="muted">${dateId(data.filters.from)} s.d. ${dateId(data.filters.to)}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No.</th><th>Akun Dana</th><th>Akun Transaksi</th><th>Cost Center</th><th>Keterangan</th><th>Referensi</th><th>Masuk</th><th>Keluar</th><th>Status</th></tr></thead><tbody>
        ${data.rows.length ? data.rows.map(row => `<tr>
          <td>${dateId(row.transaction_date)}</td>
          <td>${esc(row.transaction_no)}</td>
          <td>${esc(row.fund_account_code)} · ${esc(row.fund_account_name)}</td>
          <td>${row.transaction_account_name ? `${esc(row.transaction_account_code)} · ${esc(row.transaction_account_name)}` : '-'}</td>
          <td>${esc(row.cost_center_name || '-')}</td>
          <td>${esc(row.description)}</td>
          <td>${esc(row.reference_no || '-')}</td>
          <td class="money in">${row.direction === 'IN' ? money(row.amount) : '-'}</td>
          <td class="money out">${row.direction === 'OUT' ? money(row.amount) : '-'}</td>
          <td>${status(row.status)}</td>
        </tr>`).join('') : tableEmpty(10, 'Belum ada transaksi sesuai filter.')}
        </tbody></table></div>
      </div>`;
  };

  $('#ledgerReportFilter').onsubmit = async event => {
    event.preventDefault();
    try { await load(); } catch (error) { toast(error.message, 'error'); }
  };
  $('#ledgerReset').onclick = async () => {
    const form = $('#ledgerReportFilter');
    form.reset();
    form.elements.from.value = defaultFrom;
    form.elements.to.value = today();
    try { await load(); } catch (error) { toast(error.message, 'error'); }
  };
  $('#ledgerPdf').onclick = () => reportDownload('/api/reports/ledger.pdf', reportQuery($('#ledgerReportFilter')));
  $('#ledgerExcel').onclick = () => reportDownload('/api/reports/ledger.xlsx', reportQuery($('#ledgerReportFilter')));
  await load();
};

renderCashMutation = async function renderCashMutationWithExports() {
  await loadCommon();
  const month = today().slice(0, 7);
  const defaultFrom = `${month}-01`;
  $('#content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h3>Filter Mutasi Kas</h3><div class="muted">Lihat saldo berjalan seluruh atau per Akun Dana dan download hasilnya.</div></div></div>
      <form id="cashMutationFilter" class="toolbar">
        <label>Akun Dana<select name="accountId"><option value="">Semua Akun Dana</option>${state.accounts.map(a => `<option value="${a.accountId}">${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select></label>
        <label>Dari<input type="date" name="from" value="${defaultFrom}" required></label>
        <label>Sampai<input type="date" name="to" value="${today()}" required></label>
        <button class="primary" type="submit">Tampilkan</button>
        <button class="ghost" type="button" id="mutationReset">Reset</button>
        <button class="ghost" type="button" id="mutationPdf">Download PDF</button>
        <button class="ghost" type="button" id="mutationExcel">Download Excel</button>
      </form>
    </div>
    <div id="cashMutationResult"></div>`;

  const load = async () => {
    const query = reportQuery($('#cashMutationFilter'));
    const data = await api(`/api/reports/cash-mutation?${query.toString()}`);
    $('#cashMutationResult').innerHTML = `
      <div class="cards">
        <div class="card"><span>Saldo Awal</span><strong>${money(data.openingBalance)}</strong></div>
        <div class="card"><span>Total Masuk</span><strong class="money in">${money(data.totalIn)}</strong></div>
        <div class="card"><span>Total Keluar</span><strong class="money out">${money(data.totalOut)}</strong></div>
        <div class="card"><span>Saldo Akhir</span><strong>${money(data.closingBalance)}</strong></div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Mutasi Kas</h3><span class="muted">${dateId(data.filters.from)} s.d. ${dateId(data.filters.to)}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No.</th><th>Akun Dana</th><th>Akun Transaksi</th><th>Keterangan</th><th>Masuk</th><th>Keluar</th><th>Saldo</th></tr></thead><tbody>
        ${data.rows.length ? data.rows.map(row => `<tr>
          <td>${dateId(row.transaction_date)}</td>
          <td>${esc(row.transaction_no)}</td>
          <td>${esc(row.fund_account_code)} · ${esc(row.fund_account_name)}</td>
          <td>${row.transaction_account_name ? `${esc(row.transaction_account_code)} · ${esc(row.transaction_account_name)}` : '-'}</td>
          <td>${esc(row.description)}${row.reference_no ? `<br><small class="muted">Ref: ${esc(row.reference_no)}</small>` : ''}</td>
          <td class="money in">${row.direction === 'IN' ? money(row.amount) : '-'}</td>
          <td class="money out">${row.direction === 'OUT' ? money(row.amount) : '-'}</td>
          <td class="money">${money(row.running_balance)}</td>
        </tr>`).join('') : tableEmpty(8, 'Belum ada mutasi pada periode ini.')}
        </tbody></table></div>
      </div>`;
  };

  $('#cashMutationFilter').onsubmit = async event => {
    event.preventDefault();
    try { await load(); } catch (error) { toast(error.message, 'error'); }
  };
  $('#mutationReset').onclick = async () => {
    const form = $('#cashMutationFilter');
    form.reset();
    form.elements.from.value = defaultFrom;
    form.elements.to.value = today();
    try { await load(); } catch (error) { toast(error.message, 'error'); }
  };
  $('#mutationPdf').onclick = () => reportDownload('/api/reports/cash-mutation.pdf', reportQuery($('#cashMutationFilter')));
  $('#mutationExcel').onclick = () => reportDownload('/api/reports/cash-mutation.xlsx', reportQuery($('#cashMutationFilter')));
  await load();
};
