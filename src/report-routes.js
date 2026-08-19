'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { db, nowIso, localDate, getSetting } = require('./db');
const { hashToken, cleanText } = require('./security');

const COOKIE_NAME = 'kb_session';

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function authMiddleware(req, _res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return next(Object.assign(new Error('Silakan login kembali.'), { status: 401 }));
  const sessionHash = hashToken('SESSION', token);
  const row = db.prepare(`SELECT s.*,u.id AS uid,u.name,u.username,u.role,u.active
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sessionHash);
  if (!row || row.revoked_at || !row.active || row.expires_at < nowIso()) {
    return next(Object.assign(new Error('Sesi berakhir. Silakan login kembali.'), { status: 401 }));
  }
  req.reportAuth = { id: row.uid, name: row.name, username: row.username, role: row.role };
  next();
}

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validDate(value, fallback, label) {
  const date = cleanText(value || fallback, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error(`${label} tidak valid.`), { status: 400 });
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error(`${label} tidak valid.`), { status: 400 });
  }
  return date;
}

function reportFilters(query = {}) {
  const month = localDate().slice(0, 7);
  const filters = {
    from: validDate(query.from, `${month}-01`, 'Tanggal awal'),
    to: validDate(query.to, localDate(), 'Tanggal akhir'),
    accountId: cleanText(query.accountId, 100),
    transactionAccountId: cleanText(query.transactionAccountId, 100),
    direction: cleanText(query.direction, 10).toUpperCase(),
    q: cleanText(query.q, 120)
  };
  if (filters.from > filters.to) throw Object.assign(new Error('Tanggal awal tidak boleh melebihi tanggal akhir.'), { status: 400 });
  if (filters.direction && !['IN', 'OUT'].includes(filters.direction)) throw Object.assign(new Error('Arah transaksi tidak valid.'), { status: 400 });
  if (filters.accountId && !db.prepare('SELECT id FROM fund_accounts WHERE id=?').get(filters.accountId)) {
    throw Object.assign(new Error('Akun Dana tidak ditemukan.'), { status: 404 });
  }
  if (filters.transactionAccountId && !db.prepare('SELECT id FROM transaction_categories WHERE id=?').get(filters.transactionAccountId)) {
    throw Object.assign(new Error('Akun Transaksi tidak ditemukan.'), { status: 404 });
  }
  return filters;
}

function ledgerReport(query = {}) {
  const filters = reportFilters(query);
  const where = ['t.transaction_date BETWEEN ? AND ?'];
  const params = [filters.from, filters.to];
  if (filters.accountId) { where.push('t.fund_account_id=?'); params.push(filters.accountId); }
  if (filters.transactionAccountId) { where.push('t.category_id=?'); params.push(filters.transactionAccountId); }
  if (filters.direction) { where.push('t.direction=?'); params.push(filters.direction); }
  if (filters.q) {
    where.push(`(t.transaction_no LIKE ? OR t.description LIKE ? OR COALESCE(t.reference_no,'') LIKE ? OR COALESCE(t.counterparty,'') LIKE ? OR f.name LIKE ? OR COALESCE(c.name,'') LIKE ?)`);
    const like = `%${filters.q}%`;
    params.push(like, like, like, like, like, like);
  }

  const rows = db.prepare(`SELECT t.*,f.code AS fund_account_code,f.name AS fund_account_name,
      c.code AS transaction_account_code,c.name AS transaction_account_name,
      cc.name AS cost_center_name,v.name AS vendor_name,u.name AS created_by_name
    FROM transactions t
    JOIN fund_accounts f ON f.id=t.fund_account_id
    LEFT JOIN transaction_categories c ON c.id=t.category_id
    LEFT JOIN cost_centers cc ON cc.id=t.cost_center_id
    LEFT JOIN vendors v ON v.id=t.vendor_id
    JOIN users u ON u.id=t.created_by
    WHERE ${where.join(' AND ')}
    ORDER BY t.transaction_date ASC,t.created_at ASC,t.id ASC`).all(...params);

  const totalIn = rows.filter(r => r.status === 'APPROVED' && r.cash_effect && r.direction === 'IN').reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const totalOut = rows.filter(r => r.status === 'APPROVED' && r.cash_effect && r.direction === 'OUT').reduce((sum, r) => sum + Number(r.amount || 0), 0);
  return { filters, rows, totalIn, totalOut, net: totalIn - totalOut };
}

function cashMutationReport(query = {}) {
  const filters = reportFilters({ ...query, transactionAccountId: '', direction: '', q: '' });
  const accountClause = filters.accountId ? ' AND t.fund_account_id=?' : '';
  const openingParams = filters.accountId ? [filters.from, filters.accountId] : [filters.from];
  const openingBalance = Number(db.prepare(`SELECT COALESCE(SUM(CASE WHEN t.direction='IN' THEN t.amount ELSE -t.amount END),0) AS total
    FROM transactions t WHERE t.status='APPROVED' AND t.cash_effect=1 AND t.transaction_date<?${accountClause}`)
    .get(...openingParams).total || 0);

  const rangeParams = filters.accountId ? [filters.from, filters.to, filters.accountId] : [filters.from, filters.to];
  const rows = db.prepare(`SELECT t.*,f.code AS fund_account_code,f.name AS fund_account_name,
      c.code AS transaction_account_code,c.name AS transaction_account_name
    FROM transactions t
    JOIN fund_accounts f ON f.id=t.fund_account_id
    LEFT JOIN transaction_categories c ON c.id=t.category_id
    WHERE t.status='APPROVED' AND t.cash_effect=1 AND t.transaction_date BETWEEN ? AND ?${accountClause}
    ORDER BY t.transaction_date ASC,t.created_at ASC,t.id ASC`).all(...rangeParams);

  let running = openingBalance;
  const entries = rows.map(row => {
    running += row.direction === 'IN' ? Number(row.amount) : -Number(row.amount);
    return { ...row, running_balance: running };
  });
  const totalIn = rows.filter(r => r.direction === 'IN').reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const totalOut = rows.filter(r => r.direction === 'OUT').reduce((sum, r) => sum + Number(r.amount || 0), 0);
  return { filters, rows: entries, openingBalance, totalIn, totalOut, closingBalance: openingBalance + totalIn - totalOut };
}

function idDate(value) {
  if (!value) return '-';
  const [y, m, d] = String(value).slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

function money(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

function filterDescription(filters) {
  const parts = [`Periode ${idDate(filters.from)} s.d. ${idDate(filters.to)}`];
  if (filters.accountId) {
    const row = db.prepare('SELECT code,name FROM fund_accounts WHERE id=?').get(filters.accountId);
    if (row) parts.push(`Akun Dana ${row.code} - ${row.name}`);
  }
  if (filters.transactionAccountId) {
    const row = db.prepare('SELECT code,name FROM transaction_categories WHERE id=?').get(filters.transactionAccountId);
    if (row) parts.push(`Akun Transaksi ${row.code} - ${row.name}`);
  }
  if (filters.direction) parts.push(filters.direction === 'IN' ? 'Arah Masuk' : 'Arah Keluar');
  if (filters.q) parts.push(`Pencarian: ${filters.q}`);
  return parts.join(' | ');
}

function styleWorksheet(sheet, columnWidths) {
  sheet.views = [{ state: 'frozen', ySplit: 5 }];
  columnWidths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  const header = sheet.getRow(5);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 30;
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: columnWidths.length } };
  for (let r = 6; r <= sheet.rowCount; r += 1) sheet.getRow(r).alignment = { vertical: 'top', wrapText: true };
}

async function ledgerExcel(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AINET Kas Besar';
  const sheet = workbook.addWorksheet('Buku Kas Besar');
  sheet.mergeCells('A1:J1'); sheet.getCell('A1').value = getSetting('COMPANY_NAME', 'PT Axindo Infinitas Network'); sheet.getCell('A1').font = { bold: true, size: 14 };
  sheet.mergeCells('A2:J2'); sheet.getCell('A2').value = 'BUKU KAS BESAR'; sheet.getCell('A2').font = { bold: true, size: 13 };
  sheet.mergeCells('A3:J3'); sheet.getCell('A3').value = filterDescription(report.filters);
  sheet.addRow([]);
  sheet.addRow(['Tanggal', 'No. Transaksi', 'Akun Dana', 'Akun Transaksi', 'Cost Center', 'Keterangan', 'Referensi', 'Masuk', 'Keluar', 'Status']);
  for (const r of report.rows) {
    sheet.addRow([
      idDate(r.transaction_date), r.transaction_no, `${r.fund_account_code} - ${r.fund_account_name}`,
      r.transaction_account_name ? `${r.transaction_account_code} - ${r.transaction_account_name}` : '-', r.cost_center_name || '-',
      r.description, r.reference_no || '-', r.direction === 'IN' ? Number(r.amount) : null, r.direction === 'OUT' ? Number(r.amount) : null, r.status
    ]);
  }
  const totalRow = sheet.addRow(['', '', '', '', '', 'TOTAL', '', report.totalIn, report.totalOut, '']);
  totalRow.font = { bold: true };
  styleWorksheet(sheet, [12, 20, 24, 26, 18, 36, 18, 16, 16, 14]);
  sheet.getColumn(8).numFmt = '#,##0'; sheet.getColumn(9).numFmt = '#,##0';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function mutationExcel(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AINET Kas Besar';
  const sheet = workbook.addWorksheet('Mutasi Kas');
  sheet.mergeCells('A1:H1'); sheet.getCell('A1').value = getSetting('COMPANY_NAME', 'PT Axindo Infinitas Network'); sheet.getCell('A1').font = { bold: true, size: 14 };
  sheet.mergeCells('A2:H2'); sheet.getCell('A2').value = 'MUTASI KAS'; sheet.getCell('A2').font = { bold: true, size: 13 };
  sheet.mergeCells('A3:H3'); sheet.getCell('A3').value = filterDescription(report.filters);
  sheet.addRow([]);
  sheet.addRow(['Tanggal', 'No. Transaksi', 'Akun Dana', 'Akun Transaksi', 'Keterangan', 'Masuk', 'Keluar', 'Saldo']);
  for (const r of report.rows) {
    sheet.addRow([
      idDate(r.transaction_date), r.transaction_no, `${r.fund_account_code} - ${r.fund_account_name}`,
      r.transaction_account_name ? `${r.transaction_account_code} - ${r.transaction_account_name}` : '-', r.description,
      r.direction === 'IN' ? Number(r.amount) : null, r.direction === 'OUT' ? Number(r.amount) : null, Number(r.running_balance)
    ]);
  }
  const summary = sheet.addRow(['', '', '', '', 'SALDO AKHIR', '', '', report.closingBalance]);
  summary.font = { bold: true };
  styleWorksheet(sheet, [12, 20, 25, 26, 38, 16, 16, 18]);
  [6, 7, 8].forEach(col => { sheet.getColumn(col).numFmt = '#,##0'; });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function pdfBuffer(title, subtitle, headers, rows, widths, summaryLines = []) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.font('Helvetica-Bold').fontSize(12).text(getSetting('COMPANY_NAME', 'PT Axindo Infinitas Network'), { align: 'center' });
    doc.fontSize(11).text(title, { align: 'center' });
    doc.font('Helvetica').fontSize(8).text(subtitle, { align: 'center' });
    doc.moveDown(0.8);

    const renderHeader = () => {
      let x = doc.page.margins.left;
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(7);
      headers.forEach((h, i) => { doc.text(h, x + 2, y + 2, { width: widths[i] - 4, height: 24, align: 'center' }); x += widths[i]; });
      doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + pageWidth, y).stroke();
      doc.moveTo(doc.page.margins.left, y + 24).lineTo(doc.page.margins.left + pageWidth, y + 24).stroke();
      doc.y = y + 27;
    };

    renderHeader();
    doc.font('Helvetica').fontSize(6.5);
    for (const row of rows) {
      const height = 25;
      if (doc.y + height > doc.page.height - 45) { doc.addPage(); renderHeader(); doc.font('Helvetica').fontSize(6.5); }
      let x = doc.page.margins.left;
      const y = doc.y;
      row.forEach((value, i) => { doc.text(String(value ?? ''), x + 2, y + 2, { width: widths[i] - 4, height: height - 4, ellipsis: true }); x += widths[i]; });
      doc.moveTo(doc.page.margins.left, y + height).lineTo(doc.page.margins.left + pageWidth, y + height).strokeOpacity(0.15).stroke().strokeOpacity(1);
      doc.y = y + height;
    }
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(8);
    summaryLines.forEach(line => doc.text(line, { align: 'right' }));
    doc.end();
  });
}

async function ledgerPdf(report) {
  const rows = report.rows.map(r => [
    idDate(r.transaction_date), r.transaction_no, `${r.fund_account_code} - ${r.fund_account_name}`,
    r.transaction_account_name ? `${r.transaction_account_code} - ${r.transaction_account_name}` : '-',
    r.description, r.reference_no || '-', r.direction === 'IN' ? money(r.amount) : '-', r.direction === 'OUT' ? money(r.amount) : '-', r.status
  ]);
  return pdfBuffer('BUKU KAS BESAR', filterDescription(report.filters),
    ['Tanggal', 'No.', 'Akun Dana', 'Akun Transaksi', 'Keterangan', 'Referensi', 'Masuk', 'Keluar', 'Status'],
    rows, [58, 92, 105, 110, 155, 80, 70, 70, 60],
    [`Total Masuk: Rp ${money(report.totalIn)}`, `Total Keluar: Rp ${money(report.totalOut)}`, `Net: Rp ${money(report.net)}`]);
}

async function mutationPdf(report) {
  const rows = report.rows.map(r => [
    idDate(r.transaction_date), r.transaction_no, `${r.fund_account_code} - ${r.fund_account_name}`,
    r.transaction_account_name ? `${r.transaction_account_code} - ${r.transaction_account_name}` : '-',
    r.description, r.direction === 'IN' ? money(r.amount) : '-', r.direction === 'OUT' ? money(r.amount) : '-', money(r.running_balance)
  ]);
  return pdfBuffer('MUTASI KAS', filterDescription(report.filters),
    ['Tanggal', 'No.', 'Akun Dana', 'Akun Transaksi', 'Keterangan', 'Masuk', 'Keluar', 'Saldo'],
    rows, [58, 92, 112, 118, 180, 75, 75, 85],
    [`Saldo Awal: Rp ${money(report.openingBalance)}`, `Total Masuk: Rp ${money(report.totalIn)}`, `Total Keluar: Rp ${money(report.totalOut)}`, `Saldo Akhir: Rp ${money(report.closingBalance)}`]);
}

function registerReportRoutes(app, express) {
  if (app.locals.kasBesarReportsRegistered) return;
  app.locals.kasBesarReportsRegistered = true;
  const router = express.Router();

  router.get('/reports/ledger', authMiddleware, route((req, res) => {
    const report = ledgerReport(req.query);
    res.json({ filters: report.filters, rows: report.rows, totalIn: report.totalIn, totalOut: report.totalOut, net: report.net });
  }));
  router.get('/reports/ledger.xlsx', authMiddleware, route(async (req, res) => {
    const buffer = await ledgerExcel(ledgerReport(req.query));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="buku-kas-besar-${localDate()}.xlsx"`);
    res.send(buffer);
  }));
  router.get('/reports/ledger.pdf', authMiddleware, route(async (req, res) => {
    const buffer = await ledgerPdf(ledgerReport(req.query));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="buku-kas-besar-${localDate()}.pdf"`);
    res.send(buffer);
  }));

  router.get('/reports/cash-mutation', authMiddleware, route((req, res) => {
    const report = cashMutationReport(req.query);
    res.json({ filters: report.filters, rows: report.rows, openingBalance: report.openingBalance, totalIn: report.totalIn, totalOut: report.totalOut, closingBalance: report.closingBalance });
  }));
  router.get('/reports/cash-mutation.xlsx', authMiddleware, route(async (req, res) => {
    const buffer = await mutationExcel(cashMutationReport(req.query));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="mutasi-kas-${localDate()}.xlsx"`);
    res.send(buffer);
  }));
  router.get('/reports/cash-mutation.pdf', authMiddleware, route(async (req, res) => {
    const buffer = await mutationPdf(cashMutationReport(req.query));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="mutasi-kas-${localDate()}.pdf"`);
    res.send(buffer);
  }));

  router.use((error, _req, res, _next) => {
    const status = Number(error.status || 500);
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Terjadi kesalahan saat membuat laporan.' : error.message });
  });
  app.use('/api', router);
}

module.exports = registerReportRoutes;
module.exports._test = { reportFilters, ledgerReport, cashMutationReport, ledgerExcel, mutationExcel, ledgerPdf, mutationPdf };
