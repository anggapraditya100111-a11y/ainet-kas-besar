'use strict';

// UI additions for v1.1.0. This file is loaded after app.js and extends the
// stable renderer without replacing the existing transaction/approval flows.
titles.funds = 'Akun Dana';
titles['transaction-accounts'] = 'Akun Transaksi';
titles['cash-mutation'] = 'Mutasi Kas';
titles.profile = 'Pengguna';
titles.users = 'Manajemen Pengguna';

function replaceFinanceTerms(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    node.nodeValue = node.nodeValue
      .replace(/Akun Bank & Kas/g, 'Akun Dana')
      .replace(/Akun Kas\/Bank/g, 'Akun Dana')
      .replace(/akun kas\/bank/g, 'akun dana')
      .replace(/Kas & Bank/g, 'Dana')
      .replace(/kas & bank/g, 'dana')
      .replace(/Kategori/g, 'Akun Transaksi')
      .replace(/kategori/g, 'akun transaksi');
  }
}

function accountClassLabel(value) {
  return ({ PENDAPATAN: 'Pendapatan', BEBAN: 'Beban', TRANSFER: 'Transfer', LAINNYA: 'Lainnya' })[value] || value || 'Lainnya';
}

function scopeLabel(value) {
  return ({ IN: 'Masuk', OUT: 'Keluar', BOTH: 'Keduanya' })[value] || value;
}

function accountClassOptions(selected = 'LAINNYA') {
  return ['PENDAPATAN', 'BEBAN', 'TRANSFER', 'LAINNYA']
    .map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${accountClassLabel(value)}</option>`).join('');
}

function scopeOptions(selected = 'BOTH') {
  return ['IN', 'OUT', 'BOTH']
    .map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${scopeLabel(value)}</option>`).join('');
}

async function renderTransactionAccounts() {
  const data = await api('/api/transaction-accounts');
  const rows = data.accounts || [];
  const canManage = ['SUPER_ADMIN', 'FINANCE'].includes(state.user.role);
  $('#content').innerHTML = `
    ${canManage ? `<div class="panel">
      <div class="panel-head"><div><h3>Tambah Akun Transaksi</h3><div class="muted">Akun ini menjelaskan uang masuk/keluar digunakan untuk apa.</div></div></div>
      <form id="transactionAccountForm" class="form-grid">
        <label>Kode Akun<input name="code" placeholder="Contoh: 4-100" required></label>
        <label>Nama Akun<input name="name" placeholder="Contoh: Pendapatan Internet" required></label>
        <label>Klasifikasi<select name="accountClass">${accountClassOptions('PENDAPATAN')}</select></label>
        <label>Arah Transaksi<select name="scope">${scopeOptions('IN')}</select></label>
        <label class="full">Catatan<textarea name="notes" placeholder="Opsional"></textarea></label>
        <div class="full"><button class="primary" type="submit">Tambah Akun Transaksi</button></div>
      </form>
    </div>` : ''}
    <div class="panel">
      <div class="panel-head"><div><h3>Daftar Akun Transaksi</h3><div class="muted">Kode akun dapat disesuaikan dengan struktur pembukuan perusahaan.</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Kode</th><th>Nama</th><th>Klasifikasi</th><th>Arah</th><th>Status</th><th>Dipakai</th><th>Aksi</th></tr></thead><tbody>
      ${rows.length ? rows.map(row => `<tr>
        <td><strong>${esc(row.code)}</strong></td>
        <td>${esc(row.name)}${row.notes ? `<br><small class="muted">${esc(row.notes)}</small>` : ''}</td>
        <td>${accountClassLabel(row.accountClass)}</td>
        <td>${scopeLabel(row.scope)}</td>
        <td>${row.active ? '<span class="badge APPROVED">AKTIF</span>' : '<span class="badge CANCELLED">NONAKTIF</span>'}</td>
        <td>${Number(row.usage?.total || 0).toLocaleString('id-ID')}</td>
        <td>${canManage ? `<div class="actions">
          <button class="small-btn ghost" data-ta-edit="${row.id}">Edit</button>
          <button class="small-btn ${row.active ? 'warning' : 'success'}" data-ta-toggle="${row.id}" data-active="${row.active ? '1' : '0'}">${row.active ? 'Nonaktifkan' : 'Aktifkan'}</button>
          ${row.canDelete ? `<button class="small-btn danger" data-ta-delete="${row.id}">Hapus</button>` : ''}
        </div>` : '-'}</td>
      </tr>`).join('') : tableEmpty(7, 'Belum ada Akun Transaksi.')}
      </tbody></table></div>
    </div>`;

  if (canManage) {
    $('#transactionAccountForm').onsubmit = async event => {
      event.preventDefault();
      try {
        await api('/api/transaction-accounts', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
        toast('Akun Transaksi berhasil ditambahkan.', 'success');
        await loadCommon();
        renderTransactionAccounts();
      } catch (error) { toast(error.message, 'error'); }
    };

    $$('[data-ta-edit]').forEach(button => button.onclick = () => {
      const row = rows.find(item => item.id === button.dataset.taEdit);
      if (!row) return;
      openModal('Edit Akun Transaksi', `<form id="editTransactionAccountForm" class="form-grid">
        <label>Kode Akun<input name="code" value="${esc(row.code)}" required></label>
        <label>Nama Akun<input name="name" value="${esc(row.name)}" required></label>
        <label>Klasifikasi<select name="accountClass">${accountClassOptions(row.accountClass)}</select></label>
        <label>Arah Transaksi<select name="scope">${scopeOptions(row.scope)}</select></label>
        <label class="full">Catatan<textarea name="notes">${esc(row.notes || '')}</textarea></label>
        <div class="full"><button class="primary" type="submit">Simpan Perubahan</button></div>
      </form>`);
      $('#editTransactionAccountForm').onsubmit = async event => {
        event.preventDefault();
        try {
          await api(`/api/transaction-accounts/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
          $('#modal').close();
          toast('Akun Transaksi berhasil diperbarui.', 'success');
          await loadCommon();
          renderTransactionAccounts();
        } catch (error) { toast(error.message, 'error'); }
      };
    });

    $$('[data-ta-toggle]').forEach(button => button.onclick = async () => {
      const active = button.dataset.active !== '1';
      try {
        await api(`/api/transaction-accounts/${encodeURIComponent(button.dataset.taToggle)}`, { method: 'PATCH', body: JSON.stringify({ active }) });
        toast(active ? 'Akun Transaksi diaktifkan.' : 'Akun Transaksi dinonaktifkan.', 'success');
        await loadCommon();
        renderTransactionAccounts();
      } catch (error) { toast(error.message, 'error'); }
    });

    $$('[data-ta-delete]').forEach(button => button.onclick = async () => {
      if (!confirm('Hapus permanen Akun Transaksi ini? Tindakan ini hanya dapat dilakukan bila akun belum pernah digunakan.')) return;
      try {
        await api(`/api/transaction-accounts/${encodeURIComponent(button.dataset.taDelete)}`, { method: 'DELETE' });
        toast('Akun Transaksi berhasil dihapus.', 'success');
        await loadCommon();
        renderTransactionAccounts();
      } catch (error) { toast(error.message, 'error'); }
    });
  }
}

async function renderCashMutation() {
  await loadCommon();
  const month = today().slice(0, 7);
  const defaultFrom = `${month}-01`;
  $('#content').innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h3>Filter Mutasi Kas</h3><div class="muted">Lihat arus dana dan saldo berjalan seluruh atau per Akun Dana.</div></div></div>
      <form id="cashMutationFilter" class="toolbar">
        <label>Akun Dana<select name="accountId"><option value="">Semua Akun Dana</option>${state.accounts.map(a => `<option value="${a.accountId}">${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select></label>
        <label>Dari<input type="date" name="from" value="${defaultFrom}" required></label>
        <label>Sampai<input type="date" name="to" value="${today()}" required></label>
        <button class="primary" type="submit">Tampilkan</button>
      </form>
    </div>
    <div id="cashMutationResult"></div>`;

  const load = async () => {
    const form = $('#cashMutationFilter');
    const values = Object.fromEntries(new FormData(form));
    const query = new URLSearchParams(values);
    const data = await api(`/api/cash-mutations?${query.toString()}`);
    $('#cashMutationResult').innerHTML = `
      <div class="cards">
        <div class="card"><span>Saldo Awal</span><strong>${money(data.openingBalance)}</strong></div>
        <div class="card"><span>Total Masuk</span><strong class="money in">${money(data.totalIn)}</strong></div>
        <div class="card"><span>Total Keluar</span><strong class="money out">${money(data.totalOut)}</strong></div>
        <div class="card"><span>Saldo Akhir</span><strong>${money(data.closingBalance)}</strong></div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Mutasi Kas</h3><span class="muted">${dateId(data.from)} s.d. ${dateId(data.to)}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th>No.</th><th>Akun Dana</th><th>Akun Transaksi</th><th>Keterangan</th><th>Masuk</th><th>Keluar</th><th>Saldo</th></tr></thead><tbody>
        ${data.entries.length ? data.entries.map(row => `<tr>
          <td>${dateId(row.transactionDate)}</td>
          <td>${esc(row.transactionNo)}</td>
          <td>${esc(row.fundAccountCode)} · ${esc(row.fundAccountName)}</td>
          <td>${row.transactionAccountName ? `${esc(row.transactionAccountCode)} · ${esc(row.transactionAccountName)}` : '-'}</td>
          <td>${esc(row.description)}${row.referenceNo ? `<br><small class="muted">Ref: ${esc(row.referenceNo)}</small>` : ''}</td>
          <td class="money in">${row.direction === 'IN' ? money(row.amount) : '-'}</td>
          <td class="money out">${row.direction === 'OUT' ? money(row.amount) : '-'}</td>
          <td class="money">${money(row.runningBalance)}</td>
        </tr>`).join('') : tableEmpty(8, 'Belum ada mutasi pada periode ini.')}
        </tbody></table></div>
      </div>`;
  };

  $('#cashMutationFilter').onsubmit = async event => {
    event.preventDefault();
    try { await load(); }
    catch (error) { toast(error.message, 'error'); }
  };
  await load();
}

async function renderProfile() {
  const data = await api('/api/profile');
  const user = data.user;
  $('#content').innerHTML = `
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h3>Akun Pengguna</h3></div>
        <div class="account-list">
          <div class="account-row"><div><small>Nama</small><strong>${esc(user.name)}</strong></div></div>
          <div class="account-row"><div><small>Username</small><strong>${esc(user.username)}</strong></div></div>
          <div class="account-row"><div><small>Role</small><strong>${esc(user.role)}</strong></div></div>
          <div class="account-row"><div><small>Login Terakhir</small><strong>${user.lastLogin ? esc(new Date(user.lastLogin).toLocaleString('id-ID')) : '-'}</strong></div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h3>Ganti Password</h3><div class="muted">Password baru minimal 8 karakter dan mengandung huruf serta angka.</div></div></div>
        <form id="changePasswordForm" class="stack">
          <label>Password Lama<div class="password-wrap"><input id="profileOldPassword" name="currentPassword" type="password" autocomplete="current-password" required><button type="button" class="eye" data-profile-eye="profileOldPassword">◉</button></div></label>
          <label>Password Baru<div class="password-wrap"><input id="profileNewPassword" name="newPassword" type="password" autocomplete="new-password" required><button type="button" class="eye" data-profile-eye="profileNewPassword">◉</button></div></label>
          <button class="primary" type="submit">Ganti Password</button>
        </form>
      </div>
    </div>`;

  $$('[data-profile-eye]').forEach(button => button.onclick = () => {
    const input = document.getElementById(button.dataset.profileEye);
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('#changePasswordForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/api/profile/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      event.currentTarget.reset();
      toast('Password berhasil diganti.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  };
}

const legacyRender = render;
render = async function enhancedRender(page) {
  if (page === 'transaction-accounts') return renderTransactionAccounts();
  if (page === 'cash-mutation') return renderCashMutation();
  if (page === 'profile') return renderProfile();
  const result = await legacyRender(page);
  replaceFinanceTerms($('#content'));
  return result;
};
