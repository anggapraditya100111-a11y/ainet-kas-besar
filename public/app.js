const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const state = { user: null, page: 'dashboard', accounts: [], master: null, pettyUsers: [] };

const titles = {
  dashboard: 'Dashboard', income: 'Penerimaan', expense: 'Pengeluaran', payments: 'Permintaan Pembayaran',
  transfers: 'Transfer Dana', approval: 'Approval', funds: 'Akun Bank & Kas', vendors: 'Vendor',
  'cost-centers': 'Cost Center', ledger: 'Buku Kas Besar', audit: 'Audit Log', users: 'Pengguna', settings: 'Pengaturan', backup: 'Backup'
};

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function money(value) { return `Rp ${Number(value || 0).toLocaleString('id-ID')}`; }
function dateId(value) { if (!value) return '-'; const [y,m,d] = String(value).slice(0,10).split('-'); return `${d}-${m}-${y}`; }
function status(value) { return `<span class="badge ${esc(value)}">${esc(value)}</span>`; }
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date()); }
function toast(message, kind = '') { const el = $('#toast'); el.textContent = message; el.className = `toast show ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = 'toast', 3200); }

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) {
    if (response.status === 401 && !url.includes('/auth/login')) showLogin();
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function showLogin() { $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); state.user = null; }
function showApp() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#sidebarUser').textContent = state.user.name;
  $('#sidebarRole').textContent = state.user.role;
  $$('.super-only').forEach(el => el.classList.toggle('hidden', state.user.role !== 'SUPER_ADMIN'));
}

async function bootstrap() {
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    $('#appName').textContent = data.appName || 'AINET Kas Besar';
    $('#companyName').textContent = data.companyName || '';
    $('#version').textContent = `v${data.appVersion || '1.0.0'}`;
    showApp();
    await loadCommon();
    navigate('dashboard');
    checkSync();
  } catch { showLogin(); }
}

async function loadCommon() {
  const [funds, master] = await Promise.all([api('/api/fund-accounts'), api('/api/master-data')]);
  state.accounts = funds.accounts || [];
  state.master = master;
}

async function checkSync() {
  const badge = $('#syncBadge');
  try {
    const data = await api('/api/integration/status');
    badge.textContent = data.ok ? 'Kas Kecil: terhubung' : (data.configured ? 'Kas Kecil: offline' : 'Kas Kecil: belum diatur');
    badge.className = `sync-badge ${data.ok ? 'ok' : 'bad'}`;
  } catch {
    badge.textContent = 'Kas Kecil: offline'; badge.className = 'sync-badge bad';
  }
}

function navigate(page) {
  if (state.user?.role !== 'SUPER_ADMIN' && ['users','settings','backup'].includes(page)) page = 'dashboard';
  state.page = page;
  $('#pageTitle').textContent = titles[page] || page;
  $$('#nav button[data-page]').forEach(btn => btn.classList.toggle('active', btn.dataset.page === page));
  $('#sidebar').classList.remove('open');
  render(page).catch(error => { $('#content').innerHTML = `<div class="panel empty">${esc(error.message)}</div>`; toast(error.message, 'error'); });
}

async function render(page) {
  const handlers = {
    dashboard: renderDashboard, income: () => renderDirect('IN'), expense: () => renderDirect('OUT'), payments: renderPayments,
    transfers: renderTransfers, approval: renderApproval, funds: renderFunds, vendors: renderVendors, 'cost-centers': renderCostCenters,
    ledger: renderLedger, audit: renderAudit, users: renderUsers, settings: renderSettings, backup: renderBackup
  };
  return (handlers[page] || renderDashboard)();
}

function tableEmpty(cols, text = 'Belum ada data.') { return `<tr><td colspan="${cols}" class="empty">${esc(text)}</td></tr>`; }
function accountOptions(selected = '') { return state.accounts.filter(x => x.active).map(a => `<option value="${a.accountId}" ${a.accountId===selected?'selected':''}>${esc(a.code)} · ${esc(a.name)} (${money(a.balance)})</option>`).join(''); }
function categoryOptions(scope) { return (state.master?.categories || []).filter(x => x.active && (x.scope === scope || x.scope === 'BOTH')).map(x => `<option value="${x.id}">${esc(x.code)} · ${esc(x.name)}</option>`).join(''); }
function ccOptions() { return (state.master?.costCenters || []).filter(x=>x.active).map(x=>`<option value="${x.id}">${esc(x.code)} · ${esc(x.name)}</option>`).join(''); }
function vendorOptions() { return (state.master?.vendors || []).filter(x=>x.active).map(x=>`<option value="${x.id}">${esc(x.code)} · ${esc(x.name)}</option>`).join(''); }

async function renderDashboard() {
  const d = await api('/api/dashboard');
  $('#content').innerHTML = `
    <div class="cards">
      <div class="card"><span>Total Kas & Bank</span><strong>${money(d.totalCash)}</strong><div class="kpi-note">Posisi dana di akun Kas Besar</div></div>
      <div class="card"><span>Penerimaan Bulan Ini</span><strong class="money in">${money(d.cashIn)}</strong><div class="kpi-note">Cash in bulan berjalan</div></div>
      <div class="card"><span>Pengeluaran Bulan Ini</span><strong class="money out">${money(d.cashOut)}</strong><div class="kpi-note">Cash out bulan berjalan</div></div>
      <div class="card"><span>Menunggu Proses</span><strong>${d.pendingPayments}</strong><div class="kpi-note">${money(d.pendingAmount)} · Sync gagal: ${d.syncFailed}</div></div>
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h3>Posisi Kas & Bank</h3><button class="ghost small-btn" data-go="funds">Kelola akun</button></div>
        <div class="account-list">${d.accounts.length ? d.accounts.map(a=>`<div class="account-row"><div><strong>${esc(a.name)}</strong><small>${esc(a.accountType)} · ${esc(a.bankName || a.code)}</small></div><strong class="money">${money(a.balance)}</strong></div>`).join('') : '<div class="empty">Belum ada akun kas/bank.</div>'}</div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Ringkasan Arus Kas</h3></div>
        <div class="cards" style="grid-template-columns:1fr 1fr"><div class="card"><span>Net Cash Flow</span><strong class="${d.netCashFlow>=0?'money in':'money out'}">${money(d.netCashFlow)}</strong></div><div class="card"><span>Sync Kas Kecil Gagal</span><strong>${d.syncFailed}</strong></div></div>
      </div>
    </div>
    <div class="panel"><div class="panel-head"><h3>Transaksi Terbaru</h3><button class="ghost small-btn" data-go="ledger">Lihat semua</button></div>
      <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No.</th><th>Akun</th><th>Keterangan</th><th>Jenis</th><th>Nominal</th></tr></thead><tbody>
      ${d.recent.length ? d.recent.map(r=>`<tr><td>${dateId(r.transaction_date)}</td><td>${esc(r.transaction_no)}</td><td>${esc(r.fund_account_name)}</td><td>${esc(r.description)}</td><td>${r.direction}</td><td class="money ${r.direction==='IN'?'in':'out'}">${r.direction==='IN'?'+':'-'} ${money(r.amount)}</td></tr>`).join('') : tableEmpty(6)}
      </tbody></table></div>
    </div>`;
  bindGo();
}

async function renderDirect(direction) {
  await loadCommon();
  const data = await api(`/api/transactions?direction=${direction}`);
  const isIn = direction === 'IN';
  $('#content').innerHTML = `
    <div class="panel"><div class="panel-head"><h3>Input ${isIn?'Penerimaan':'Pengeluaran'}</h3></div>
      <form id="directForm" class="form-grid">
        <label>Tanggal<input type="date" name="transactionDate" value="${today()}" required></label>
        <label>Akun Kas/Bank<select name="fundAccountId" required><option value="">Pilih akun</option>${accountOptions()}</select></label>
        <label>Kategori<select name="categoryId"><option value="">Tanpa kategori</option>${categoryOptions(direction)}</select></label>
        <label>Cost Center<select name="costCenterId"><option value="">Tidak ada</option>${ccOptions()}</select></label>
        ${isIn ? '<label>Counterparty<input name="counterparty" placeholder="Pelanggan / pihak penyetor"></label>' : `<label>Vendor<select name="vendorId"><option value="">Tanpa vendor</option>${vendorOptions()}</select></label>`}
        <label>Referensi<input name="referenceNo" placeholder="Invoice / bukti / referensi"></label>
        <label>Nominal<input name="amount" inputmode="numeric" placeholder="0" required></label>
        <label class="full">Keterangan<textarea name="description" required></textarea></label>
        <div class="full"><button class="primary" type="submit">Simpan ${isIn?'Penerimaan':'Pengeluaran'}</button></div>
      </form>
    </div>
    <div class="panel"><div class="panel-head"><h3>Riwayat ${isIn?'Penerimaan':'Pengeluaran'}</h3></div>${transactionTable(data.transactions)}</div>`;
  $('#directForm').addEventListener('submit', async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget)); body.direction = direction;
    try { await api('/api/transactions',{method:'POST',body:JSON.stringify(body)}); toast('Transaksi berhasil disimpan.','success'); await loadCommon(); renderDirect(direction); }
    catch(error){ toast(error.message,'error'); }
  });
}

function transactionTable(rows) {
  return `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No.</th><th>Akun</th><th>Kategori / Cost Center</th><th>Keterangan</th><th>Referensi</th><th>Nominal</th><th>Status</th></tr></thead><tbody>${rows.length?rows.map(r=>`<tr><td>${dateId(r.transaction_date)}</td><td>${esc(r.transaction_no)}</td><td>${esc(r.fund_account_name)}</td><td>${esc(r.category_name||'-')}<br><small class="muted">${esc(r.cost_center_name||'-')}</small></td><td>${esc(r.description)}</td><td>${esc(r.reference_no||'-')}</td><td class="money ${r.direction==='IN'?'in':'out'}">${r.direction==='IN'?'+':'-'} ${money(r.amount)}</td><td>${status(r.status)}</td></tr>`).join(''):tableEmpty(8)}</tbody></table></div>`;
}

async function renderPayments() {
  await loadCommon(); const data = await api('/api/payment-requests');
  $('#content').innerHTML = `
    <div class="panel"><div class="panel-head"><h3>Ajukan Pembayaran</h3></div><form id="paymentForm" class="form-grid">
      <label>Tanggal Pengajuan<input type="date" name="requestDate" value="${today()}" required></label><label>Nama Pemohon<input name="requesterName" value="${esc(state.user.name)}" required></label>
      <label>Divisi<input name="division" placeholder="Contoh: Teknis"></label><label>Cost Center<select name="costCenterId"><option value="">Pilih</option>${ccOptions()}</select></label>
      <label>Vendor<select name="vendorId"><option value="">Tanpa vendor</option>${vendorOptions()}</select></label><label>Kategori<select name="categoryId"><option value="">Pilih</option>${categoryOptions('OUT')}</select></label>
      <label>Nominal<input name="amount" inputmode="numeric" required></label><label>Jatuh Tempo<input type="date" name="dueDate"></label>
      <label>Referensi<input name="referenceNo"></label><label class="full">Keperluan<textarea name="purpose" required></textarea></label><div class="full"><button class="primary">Kirim Pengajuan</button></div>
    </form></div>
    <div class="panel"><div class="panel-head"><h3>Daftar Permintaan Pembayaran</h3></div><div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No.</th><th>Pemohon</th><th>Vendor</th><th>Keperluan</th><th>Nominal</th><th>Status</th><th>Aksi</th></tr></thead><tbody>
    ${data.requests.length?data.requests.map(paymentRow).join(''):tableEmpty(8)}</tbody></table></div></div>`;
  $('#paymentForm').addEventListener('submit', async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/payment-requests',{method:'POST',body:JSON.stringify(body)});toast('Pengajuan pembayaran dikirim.','success');renderPayments();}catch(err){toast(err.message,'error')}});
  bindPaymentActions();
}

function paymentRow(r) {
  const actions=[];
  if (['SUPER_ADMIN','FINANCE'].includes(state.user.role) && r.status==='SUBMITTED') actions.push(`<button class="small-btn success" data-pay-act="verify" data-id="${r.id}">Verifikasi</button>`);
  if (['SUPER_ADMIN','MANAGER','APPROVER'].includes(state.user.role) && r.status==='VERIFIED') actions.push(`<button class="small-btn success" data-pay-act="approve" data-id="${r.id}">Setujui</button>`);
  if (['SUPER_ADMIN','FINANCE'].includes(state.user.role) && r.status==='APPROVED') actions.push(`<button class="small-btn primary" data-pay-act="pay" data-id="${r.id}">Bayar</button>`);
  if (['SUBMITTED','VERIFIED'].includes(r.status) && ['SUPER_ADMIN','FINANCE','MANAGER','APPROVER'].includes(state.user.role)) actions.push(`<button class="small-btn danger" data-pay-act="reject" data-id="${r.id}">Tolak</button>`);
  return `<tr><td>${dateId(r.request_date)}</td><td>${esc(r.request_no)}</td><td>${esc(r.requester_name)}<br><small class="muted">${esc(r.division||'')}</small></td><td>${esc(r.vendor_name||'-')}</td><td>${esc(r.purpose)}</td><td class="money">${money(r.amount)}</td><td>${status(r.status)}</td><td><div class="actions">${actions.join('')||'-'}</div></td></tr>`;
}

function bindPaymentActions() {
  $$('[data-pay-act]').forEach(btn=>btn.onclick=async()=>{
    const act=btn.dataset.payAct,id=btn.dataset.id;
    try {
      if(act==='pay'){
        openModal('Bayar Permintaan',`<form id="payExecForm" class="form-grid"><label class="full">Akun pembayaran<select name="fundAccountId" required><option value="">Pilih</option>${accountOptions()}</select></label><label>Tanggal Bayar<input type="date" name="paymentDate" value="${today()}" required></label><label>Referensi<input name="referenceNo"></label><label class="full">Catatan<textarea name="note"></textarea></label><div class="full"><button class="primary">Konfirmasi Bayar</button></div></form>`);
        $('#payExecForm').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget));await api(`/api/payment-requests/${id}/pay`,{method:'POST',body:JSON.stringify(body)});closeModal();toast('Pembayaran dicatat.','success');await loadCommon();renderPayments();};
      } else if(act==='reject'){
        const reason=prompt('Alasan penolakan:'); if(!reason)return; await api(`/api/payment-requests/${id}/reject`,{method:'POST',body:JSON.stringify({reason})});toast('Pengajuan ditolak.','success');renderPayments();
      } else {
        await api(`/api/payment-requests/${id}/${act}`,{method:'POST',body:'{}'});toast(act==='verify'?'Pengajuan diverifikasi.':'Pengajuan disetujui.','success');renderPayments();
      }
    } catch(err){toast(err.message,'error')}
  });
}

async function loadPettyUsers() { try { const d=await api('/api/integration/petty-cash-users'); state.pettyUsers=d.users||[]; } catch { state.pettyUsers=[]; } }
async function renderTransfers() {
  await loadCommon(); await loadPettyUsers(); const data=await api('/api/transfers');
  $('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Transfer Dana</h3></div><form id="transferForm" class="form-grid">
    <label>Tanggal<input type="date" name="transferDate" value="${today()}" required></label><label>Akun Sumber<select name="fromAccountId" required><option value="">Pilih</option>${accountOptions()}</select></label>
    <label>Tujuan<select name="destinationType" id="destType"><option value="INTERNAL">Antar Kas/Bank</option><option value="KAS_KECIL">Pendanaan Kas Kecil</option></select></label>
    <label id="internalTarget">Akun Tujuan<select name="toAccountId"><option value="">Pilih</option>${accountOptions()}</select></label>
    <label id="pettyTarget" class="hidden">Penerima Kas Kecil<select name="recipientUserId"><option value="">Pilih user</option>${state.pettyUsers.map(u=>`<option value="${u.userId}">${esc(u.name)} · ${esc(u.username)}</option>`).join('')}</select></label>
    <label>Nominal<input name="amount" inputmode="numeric" required></label><label class="full">Keterangan<textarea name="description" required></textarea></label><div class="full"><button class="primary">Ajukan Transfer</button></div>
  </form></div><div class="panel"><div class="panel-head"><h3>Riwayat Transfer</h3></div><div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No.</th><th>Sumber</th><th>Tujuan</th><th>Nominal</th><th>Status</th><th>Sync</th><th>Aksi</th></tr></thead><tbody>${data.transfers.length?data.transfers.map(transferRow).join(''):tableEmpty(8)}</tbody></table></div></div>`;
  $('#destType').onchange=e=>{const petty=e.target.value==='KAS_KECIL';$('#pettyTarget').classList.toggle('hidden',!petty);$('#internalTarget').classList.toggle('hidden',petty)};
  $('#transferForm').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget));try{await api('/api/transfers',{method:'POST',body:JSON.stringify(body)});toast('Transfer diajukan untuk approval.','success');renderTransfers();}catch(err){toast(err.message,'error')}};
  bindTransferActions();
}
function transferRow(r){const actions=[];if(['SUPER_ADMIN','MANAGER','APPROVER'].includes(state.user.role)&&r.status==='PENDING')actions.push(`<button class="small-btn success" data-trf="approve" data-id="${r.id}">Setujui</button>`);if(['SUPER_ADMIN','FINANCE'].includes(state.user.role)&&r.status==='APPROVED')actions.push(`<button class="small-btn primary" data-trf="execute" data-id="${r.id}">Eksekusi</button>`);if(['SUPER_ADMIN','FINANCE'].includes(state.user.role)&&r.status==='SYNC_FAILED')actions.push(`<button class="small-btn warning" data-trf="retry-sync" data-id="${r.id}">Retry Sync</button>`);return `<tr><td>${dateId(r.transfer_date)}</td><td>${esc(r.transfer_no)}</td><td>${esc(r.from_account_name)}</td><td>${r.destination_type==='INTERNAL'?esc(r.to_account_name||'-'):'Kas Kecil'}<br><small class="muted">${esc(r.integration_id||'')}</small></td><td class="money">${money(r.amount)}</td><td>${status(r.status)}</td><td>${r.sync_error?`<span class="muted">${esc(r.sync_error)}</span>`:'-'}</td><td><div class="actions">${actions.join('')||'-'}</div></td></tr>`}
function bindTransferActions(){$$('[data-trf]').forEach(btn=>btn.onclick=async()=>{try{await api(`/api/transfers/${btn.dataset.id}/${btn.dataset.trf}`,{method:'POST',body:'{}'});toast('Transfer diperbarui.','success');await loadCommon();renderTransfers();checkSync();}catch(err){toast(err.message,'error');renderTransfers();}})}

async function renderApproval(){const [p,t]=await Promise.all([api('/api/payment-requests'),api('/api/transfers')]);const payments=p.requests.filter(x=>['SUBMITTED','VERIFIED'].includes(x.status));const transfers=t.transfers.filter(x=>x.status==='PENDING');$('#content').innerHTML=`<div class="cards"><div class="card"><span>Pengajuan Pembayaran</span><strong>${payments.length}</strong></div><div class="card"><span>Transfer Menunggu Approval</span><strong>${transfers.length}</strong></div></div><div class="panel"><div class="panel-head"><h3>Approval Pembayaran</h3></div><div class="table-wrap"><table><thead><tr><th>No.</th><th>Pemohon</th><th>Keperluan</th><th>Nominal</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${payments.length?payments.map(r=>`<tr><td>${esc(r.request_no)}</td><td>${esc(r.requester_name)}</td><td>${esc(r.purpose)}</td><td class="money">${money(r.amount)}</td><td>${status(r.status)}</td><td>${paymentRow(r).match(/<td><div class="actions">(.*?)<\/div><\/td>/s)?.[1]||'-'}</td></tr>`).join(''):tableEmpty(6)}</tbody></table></div></div><div class="panel"><div class="panel-head"><h3>Approval Transfer</h3></div><div class="table-wrap"><table><thead><tr><th>No.</th><th>Sumber</th><th>Tujuan</th><th>Nominal</th><th>Status</th><th>Aksi</th></tr></thead><tbody>${transfers.length?transfers.map(r=>`<tr><td>${esc(r.transfer_no)}</td><td>${esc(r.from_account_name)}</td><td>${r.destination_type==='KAS_KECIL'?'Kas Kecil':esc(r.to_account_name||'-')}</td><td class="money">${money(r.amount)}</td><td>${status(r.status)}</td><td><button class="small-btn success" data-trf="approve" data-id="${r.id}">Setujui</button></td></tr>`).join(''):tableEmpty(6)}</tbody></table></div></div>`;bindPaymentActions();bindTransferActions()}

async function renderFunds(){await loadCommon();$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Tambah Akun Kas / Bank</h3></div><form id="fundForm" class="form-grid"><label>Kode<input name="code" placeholder="BCA-OPR" required></label><label>Nama Akun<input name="name" required></label><label>Jenis<select name="accountType"><option value="BANK">Bank</option><option value="CASH">Kas Tunai</option></select></label><label>Saldo Awal<input name="openingBalance" inputmode="numeric" value="0"></label><label>Nama Bank<input name="bankName"></label><label>No. Rekening<input name="accountNumber"></label><label>Nama Pemilik Rekening<input name="accountHolder"></label><label>Catatan<input name="notes"></label><div class="full"><button class="primary">Tambah Akun</button></div></form></div><div class="panel"><div class="panel-head"><h3>Posisi Akun</h3></div><div class="table-wrap"><table><thead><tr><th>Kode</th><th>Nama</th><th>Jenis</th><th>Bank / Rekening</th><th>Saldo</th><th>Status</th></tr></thead><tbody>${state.accounts.length?state.accounts.map(a=>`<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.accountType)}</td><td>${esc(a.bankName||'-')}<br><small class="muted">${esc(a.accountNumber||'')}</small></td><td class="money">${money(a.balance)}</td><td>${a.active?'<span class="badge APPROVED">AKTIF</span>':'<span class="badge REJECTED">NONAKTIF</span>'}</td></tr>`).join(''):tableEmpty(6)}</tbody></table></div></div>`;$('#fundForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/fund-accounts',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) });toast('Akun berhasil ditambah.','success');renderFunds();}catch(err){toast(err.message,'error')}}}

async function renderVendors(){await loadCommon();const rows=state.master.vendors||[];$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Tambah Vendor</h3></div><form id="vendorForm" class="form-grid"><label>Kode<input name="code" placeholder="Opsional"></label><label>Nama Vendor<input name="name" required></label><label>Kontak<input name="contactName"></label><label>Telepon / WA<input name="phone"></label><label>Email<input name="email"></label><label>Bank<input name="bankName"></label><label>No. Rekening<input name="accountNumber"></label><label>Nama Rekening<input name="accountHolder"></label><label>NPWP<input name="npwp"></label><label class="full">Catatan<textarea name="notes"></textarea></label><div class="full"><button class="primary">Tambah Vendor</button></div></form></div><div class="panel"><div class="table-wrap"><table><thead><tr><th>Kode</th><th>Vendor</th><th>Kontak</th><th>Bank</th><th>Status</th></tr></thead><tbody>${rows.length?rows.map(v=>`<tr><td>${esc(v.code)}</td><td>${esc(v.name)}</td><td>${esc(v.contact_name||'-')}<br><small>${esc(v.phone||'')}</small></td><td>${esc(v.bank_name||'-')}<br><small>${esc(v.account_number||'')}</small></td><td>${v.active?'AKTIF':'NONAKTIF'}</td></tr>`).join(''):tableEmpty(5)}</tbody></table></div></div>`;$('#vendorForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/vendors',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) });toast('Vendor ditambahkan.','success');renderVendors();}catch(err){toast(err.message,'error')}}}
async function renderCostCenters(){await loadCommon();const rows=state.master.costCenters||[];$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Tambah Cost Center</h3></div><form id="ccForm" class="form-grid"><label>Kode<input name="code" required></label><label>Nama<input name="name" required></label><label class="full">Catatan<textarea name="notes"></textarea></label><div class="full"><button class="primary">Tambah Cost Center</button></div></form></div><div class="panel"><div class="table-wrap"><table><thead><tr><th>Kode</th><th>Nama</th><th>Catatan</th><th>Status</th></tr></thead><tbody>${rows.length?rows.map(x=>`<tr><td>${esc(x.code)}</td><td>${esc(x.name)}</td><td>${esc(x.notes||'-')}</td><td>${x.active?'AKTIF':'NONAKTIF'}</td></tr>`).join(''):tableEmpty(4)}</tbody></table></div></div>`;$('#ccForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/cost-centers',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) });toast('Cost Center ditambahkan.','success');renderCostCenters();}catch(err){toast(err.message,'error')}}}

async function renderLedger(){const data=await api('/api/transactions');$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Buku Kas Besar</h3><span class="muted">${data.transactions.length} transaksi terakhir</span></div>${transactionTable(data.transactions)}</div>`}
async function renderAudit(){const d=await api('/api/audit-logs');$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Audit Log</h3></div><div class="table-wrap"><table><thead><tr><th>Waktu</th><th>User</th><th>Aksi</th><th>Entitas</th><th>Keterangan</th></tr></thead><tbody>${d.logs.length?d.logs.map(x=>`<tr><td>${esc(new Date(x.timestamp).toLocaleString('id-ID'))}</td><td>${esc(x.user_name||x.user_id||'SYSTEM')}</td><td>${esc(x.action)}</td><td>${esc(x.entity_type)}<br><small>${esc(x.entity_id||'')}</small></td><td>${esc(x.description||'-')}</td></tr>`).join(''):tableEmpty(5)}</tbody></table></div></div>`}

async function renderUsers(){const d=await api('/api/users');$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Tambah Pengguna</h3></div><form id="userForm" class="form-grid"><label>Nama<input name="name" required></label><label>Username<input name="username" required></label><label>Role<select name="role"><option>FINANCE</option><option>MANAGER</option><option>APPROVER</option><option>VIEWER</option><option>SUPER_ADMIN</option></select></label><label>Password<input name="password" type="password" required></label><div class="full"><button class="primary">Tambah Pengguna</button></div></form></div><div class="panel"><div class="table-wrap"><table><thead><tr><th>Nama</th><th>Username</th><th>Role</th><th>Status</th><th>Login Terakhir</th></tr></thead><tbody>${d.users.length?d.users.map(u=>`<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${status(u.role)}</td><td>${u.active?'AKTIF':'NONAKTIF'}</td><td>${u.lastLogin?esc(new Date(u.lastLogin).toLocaleString('id-ID')):'-'}</td></tr>`).join(''):tableEmpty(5)}</tbody></table></div></div>`;$('#userForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) });toast('Pengguna ditambahkan.','success');renderUsers();}catch(err){toast(err.message,'error')}}}
async function renderSettings(){const d=await api('/api/settings');$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Pengaturan Aplikasi</h3></div><div class="table-wrap"><table><thead><tr><th>Key</th><th>Nilai</th><th>Keterangan</th><th>Aksi</th></tr></thead><tbody>${d.settings.map(x=>`<tr><td>${esc(x.key)}</td><td><input data-setting-value="${esc(x.key)}" value="${esc(x.value)}"></td><td>${esc(x.description||'')}</td><td><button class="small-btn primary" data-setting-save="${esc(x.key)}">Simpan</button></td></tr>`).join('')}</tbody></table></div></div>`;$$('[data-setting-save]').forEach(btn=>btn.onclick=async()=>{const key=btn.dataset.settingSave,value=$(`[data-setting-value="${CSS.escape(key)}"]`).value;try{await api(`/api/settings/${encodeURIComponent(key)}`,{method:'PATCH',body:JSON.stringify({value})});toast('Pengaturan disimpan.','success');if(['APP_NAME','COMPANY_NAME'].includes(key))location.reload();}catch(err){toast(err.message,'error')}})}
async function renderBackup(){const d=await api('/api/backups');$('#content').innerHTML=`<div class="panel"><div class="panel-head"><h3>Backup Database</h3><button id="backupNow" class="primary">Buat Backup Sekarang</button></div><p class="muted">Backup otomatis berjalan setiap hari. File database tidak disimpan di repository GitHub.</p><div class="table-wrap"><table><thead><tr><th>File</th><th>Dibuat</th><th>Ukuran</th><th>Aksi</th></tr></thead><tbody>${d.backups.length?d.backups.map(b=>`<tr><td>${esc(b.fileName)}</td><td>${esc(new Date(b.createdAt).toLocaleString('id-ID'))}</td><td>${Math.ceil(b.size/1024).toLocaleString('id-ID')} KB</td><td><a href="/api/backups/${encodeURIComponent(b.fileName)}/download"><button class="small-btn ghost">Download</button></a></td></tr>`).join(''):tableEmpty(4)}</tbody></table></div></div>`;$('#backupNow').onclick=async()=>{try{await api('/api/backups',{method:'POST',body:'{}'});toast('Backup berhasil dibuat.','success');renderBackup();}catch(err){toast(err.message,'error')}}}

function bindGo() { $$('[data-go]').forEach(btn=>btn.onclick=()=>navigate(btn.dataset.go)); }
function openModal(title, body){$('#modalBody').innerHTML=`<h3>${esc(title)}</h3>${body}`;$('#modal').showModal()}
function closeModal(){$('#modal').close()}

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.currentTarget));try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify(body)});state.user=d.user;showApp();await loadCommon();navigate('dashboard');checkSync();}catch(err){toast(err.message,'error')}});
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch{}showLogin()});
$('#nav').addEventListener('click',e=>{const btn=e.target.closest('[data-page]');if(btn)navigate(btn.dataset.page)});
$('#menuBtn').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$$('[data-eye]').forEach(btn=>btn.addEventListener('click',()=>{const input=$(`#${btn.dataset.eye}`);input.type=input.type==='password'?'text':'password'}));
$('.modal-close').addEventListener('click',closeModal);

bootstrap();
