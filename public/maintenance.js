'use strict';

titles.maintenance = 'Pemeliharaan Data';

function maintenanceCount(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

async function renderMaintenance() {
  const data = await api('/api/maintenance/status');
  const c = data.counts || {};
  const confirmText = data.confirmationText || 'HAPUS SEMUA TRANSAKSI';

  $('#content').innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h3>Transfer / Ekspor Database</h3>
          <div class="muted">Download database SQLite utuh dan konsisten untuk dipindahkan ke server lain atau disimpan secara manual.</div>
        </div>
        <a href="/api/maintenance/database/export"><button class="primary" type="button">Download Database</button></a>
      </div>
      <p class="muted">Saat tombol ditekan, sistem membuat snapshot database terlebih dahulu agar file aman walaupun database live menggunakan WAL.</p>
    </div>

    <div class="cards">
      <div class="card"><span>Transaksi</span><strong>${maintenanceCount(c.transactions)}</strong></div>
      <div class="card"><span>Permintaan Pembayaran</span><strong>${maintenanceCount(c.paymentRequests)}</strong></div>
      <div class="card"><span>Transfer Dana</span><strong>${maintenanceCount(c.transfers)}</strong></div>
      <div class="card"><span>Audit Log</span><strong>${maintenanceCount(c.auditLogs)}</strong></div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><h3>Data yang Tetap Dipertahankan</h3><div class="muted">Penghapusan seluruh transaksi tidak menghapus master dan konfigurasi berikut.</div></div></div>
      <div class="status-line">${(data.preserved || []).map(item => `<span class="badge APPROVED">${esc(item)}</span>`).join('')}</div>
      <div class="account-list" style="margin-top:14px">
        <div class="account-row"><div><small>Akun Dana</small><strong>${maintenanceCount(c.fundAccounts)}</strong></div></div>
        <div class="account-row"><div><small>Akun Transaksi</small><strong>${maintenanceCount(c.transactionAccounts)}</strong></div></div>
        <div class="account-row"><div><small>Vendor</small><strong>${maintenanceCount(c.vendors)}</strong></div></div>
        <div class="account-row"><div><small>Cost Center</small><strong>${maintenanceCount(c.costCenters)}</strong></div></div>
        <div class="account-row"><div><small>Pengguna</small><strong>${maintenanceCount(c.users)}</strong></div></div>
      </div>
    </div>

    <div class="panel" style="border-color:#f1b8b5">
      <div class="panel-head"><div><h3>Hapus Seluruh Transaksi</h3><div class="muted">Mengosongkan data operasional Kas Besar dan mengembalikan saldo seluruh Akun Dana menjadi nol.</div></div></div>
      <div class="warning" style="padding:12px 14px;border-radius:12px;margin-bottom:16px">
        Backup otomatis dibuat sebelum penghapusan. Data Kas Kecil yang sudah pernah menerima pendanaan tidak ikut dihapus karena berada di aplikasi/database terpisah. Nomor integrasi Kas Kecil tetap dipertahankan agar tidak pernah dipakai ulang.
      </div>
      <form id="clearTransactionsForm" class="form-grid">
        <label>Password Super Admin
          <div class="password-wrap"><input id="maintenancePassword" name="password" type="password" autocomplete="current-password" required><button type="button" class="eye" id="maintenancePasswordEye">◉</button></div>
        </label>
        <label>Ketik Konfirmasi
          <input name="confirmation" autocomplete="off" placeholder="${esc(confirmText)}" required>
        </label>
        <div class="full"><small class="muted">Ketik tepat: <strong>${esc(confirmText)}</strong></small></div>
        <div class="full"><button class="danger" type="submit">Hapus Seluruh Transaksi</button></div>
      </form>
    </div>`;

  $('#maintenancePasswordEye').onclick = () => {
    const input = $('#maintenancePassword');
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  $('#clearTransactionsForm').onsubmit = async event => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    if (body.confirmation !== confirmText) {
      toast(`Ketik tepat: ${confirmText}`, 'error');
      return;
    }
    if (!confirm('Seluruh transaksi, permintaan pembayaran, transfer dana, dan audit transaksi akan dihapus. Lanjutkan?')) return;

    try {
      const result = await api('/api/maintenance/transactions/clear', { method: 'POST', body: JSON.stringify(body) });
      toast(`Seluruh transaksi dihapus. Backup: ${result.backupFile}`, 'success');
      await loadCommon();
      renderMaintenance();
    } catch (error) { toast(error.message, 'error'); }
  };
}

const renderBeforeMaintenance = render;
render = async function maintenanceRender(page) {
  if (page === 'maintenance') return renderMaintenance();
  return renderBeforeMaintenance(page);
};
