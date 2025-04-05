const express = require('express');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage });

const leggiDati = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : [];
const scriviDati = (f, dati) => fs.writeFileSync(f, JSON.stringify(dati, null, 2));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// LOGIN
app.post('/api/login', (req, res) => {
  const { ragioneSociale, password } = req.body;
  if (ragioneSociale === 'admin@ecodrin.it' && password === 'admin123') {
    return res.json({ tipo: 'admin' });
  }
  const utenti = leggiDati('utenti.json');
  const utente = utenti.find(u => u.ragioneSociale.toLowerCase() === ragioneSociale.toLowerCase());
  if (utente && bcrypt.compareSync(password, utente.passwordHash)) {
    return res.json({ tipo: 'cliente', utente });
  }
  res.status(401).json({ errore: 'Credenziali errate' });
});

// REGISTRAZIONE
app.post('/api/registrazione', (req, res) => {
  const { ragioneSociale, codiceFiscale, password } = req.body;
  const wb = xlsx.readFile('clienti.xlsx');
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  const cliente = rows.find(r => r[1]?.toLowerCase() === ragioneSociale.toLowerCase());
  if (!cliente) return res.status(404).json({ errore: 'Cliente non trovato' });

  const codiceCliente = cliente[0];
  const email = cliente[4];
  const utenti = leggiDati('utenti.json');
  if (utenti.find(u => u.ragioneSociale.toLowerCase() === ragioneSociale.toLowerCase()))
    return res.status(400).json({ errore: 'Utente già registrato' });

  utenti.push({
    id: Date.now(),
    ragioneSociale, codiceFiscale, codiceCliente, email,
    passwordHash: bcrypt.hashSync(password, 10),
    passwordChiara: password
  });
  scriviDati('utenti.json', utenti);
  res.json({ success: true });
});

// PDF
function generaRicevutaPDF(prenotazione, path) {
  return new Promise(resolve => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(path);
    doc.pipe(stream);
    doc.fontSize(18).text('Ricevuta Prenotazione', { align: 'center' }).moveDown();
    Object.entries(prenotazione).forEach(([k, v]) => {
      if (typeof v !== 'object') doc.fontSize(12).text(`${k}: ${v}`);
    });
    doc.end();
    stream.on('finish', resolve);
  });
}

// PRENOTAZIONE
app.post('/api/prenotazioni', (req, res, next) => {
  upload.single('analisi')(req, res, function (err) {
    if (err) return res.status(400).json({ errore: 'Errore upload file' });
    next();
  });
}, async (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  const nuova = {
    id: Date.now(),
    ragioneSociale: req.body.ragioneSociale,
    codiceCliente: req.body.codiceCliente,
    produttore: req.body.produttore,
    codiceCER: req.body.codiceCER,
    pericolosita: req.body.pericolosita || '',
    tipoImballo: req.body.tipoImballo,
    statoFisico: req.body.statoFisico,
    quantita: req.body.quantita,
    data: req.body.data,
    analisi: req.file?.filename || '',
    email: req.body.email,
    stato: 'in attesa',
    chat: []
  };
  dati.push(nuova);
  scriviDati('prenotazioni.json', dati);

  const pdfPath = `uploads/ricevuta_${nuova.id}.pdf`;
  await generaRicevutaPDF(nuova, pdfPath);

  try {
    await transporter.sendMail({
      from: `"Ecodrin" <${process.env.SMTP_USER}>`,
      to: nuova.email,
      subject: '📦 Prenotazione ricevuta',
      text: `La tua prenotazione per il ${nuova.data} è stata registrata.`,
      attachments: [{ filename: 'ricevuta.pdf', path: pdfPath }]
    });
  } catch (err) {
    console.error('Errore email:', err.message);
  }

  res.json({ success: true });
});

// ✅ NUOVO: Tutte le prenotazioni (admin)
app.get('/api/prenotazioni', (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  res.json(dati);
});

// CONFERMA / RIFIUTO
app.patch('/api/prenotazioni/:id', async (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  const p = dati.find(p => p.id == req.params.id);
  if (!p) return res.status(404).json({ errore: 'Prenotazione non trovata' });

  p.stato = req.body.stato;
  scriviDati('prenotazioni.json', dati);

  const ricevutaPath = `uploads/ricevuta_${p.id}.pdf`;
  await generaRicevutaPDF(p, ricevutaPath);

  try {
    await transporter.sendMail({
      from: `"Ecodrin" <${process.env.SMTP_USER}>`,
      to: p.email,
      subject: `Prenotazione ${p.stato}`,
      text: `La tua prenotazione del ${p.data} è stata ${p.stato}.`,
      attachments: [{ filename: 'ricevuta.pdf', path: ricevutaPath }]
    });
  } catch (err) {
    console.error('Errore invio email:', err.message);
  }

  res.json({ success: true });
});

// CHAT
app.get('/api/prenotazioni/:id/chat', (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  const p = dati.find(p => p.id == req.params.id);
  res.json(p?.chat || []);
});

app.post('/api/prenotazioni/:id/chat', (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  const p = dati.find(p => p.id == req.params.id);
  if (!p) return res.status(404).json({ errore: 'Prenotazione non trovata' });

  p.chat.push({ ...req.body, timestamp: Date.now() });
  scriviDati('prenotazioni.json', dati);
  res.json({ success: true });
});

// 📋 Prenotazioni per cliente
app.get('/api/prenotazioni/utente/:codice', (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  const filtrate = dati.filter(p => p.codiceCliente === req.params.codice);
  res.json(filtrate);
});

// STATISTICHE CER
app.get('/api/grafico/cer', (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  const stats = {};
  dati.forEach(p => {
    if (!stats[p.codiceCER]) stats[p.codiceCER] = 0;
    stats[p.codiceCER] += Number(p.quantita);
  });
  res.json(stats);
});

// CSV EXPORT
app.get('/api/prenotazioni/export', (req, res) => {
  const dati = leggiDati('prenotazioni.json');
  const csv = [
    'Codice Cliente,CER,Quantità,Data,Stato',
    ...dati.map(p => `${p.codiceCliente},${p.codiceCER},${p.quantita},${p.data},${p.stato}`)
  ].join('\n');

  res.setHeader('Content-Disposition', 'attachment; filename=prenotazioni.csv');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

// AVVIO SERVER
app.listen(port, () => {
  console.log(`✅ Server attivo su http://localhost:${port}`);
});
