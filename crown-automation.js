/* ============================================================================
   crown-automation.js  —  Crown Ceramic Coating
   Self-contained add-on loaded by server.js with ONE line at the very end:

       require('./crown-automation.js')({ app, pool, transporter, stripe });

   Everything here is additive and defensive:
     • All new tables/columns use CREATE TABLE / ADD COLUMN IF NOT EXISTS.
     • Every email send is wrapped so a mail failure never breaks a request.
     • Routes that "override" old behavior simply register later and win, or
       provide cleaner endpoints the new pages use.

   Covers:
     #3  Day-based scheduling that respects business hours & open days
     #7  schedule.html booking, lifecycle emails, 48-hr reminders, surveys,
         service-request replies, sales-agreement PDF email, invoice-paid sync,
         manual "send another copy" endpoints.
   ============================================================================ */
'use strict';

const path = require('path');
const crypto = require('crypto');
let PDFDocument = null;
try { PDFDocument = require('pdfkit'); } catch (_) { /* optional */ }

module.exports = function initCrownAutomation({ app, pool, transporter, stripe }) {

  // ---- Business configuration -------------------------------------------
  const TZ = 'America/Chicago';
  const OPEN_DOW = [1, 2, 3, 4, 5, 6];   // Mon..Sat open, Sun(0) closed
  const OPEN_LABEL = 'Mon–Sat 6:00 AM–7:00 PM CST · Closed Sunday';
  const BOOKING_WINDOW_DAYS = 60;        // how far out customers can book
  const PHONE = '(940) 217-8680';
  const EMAIL_FROM = 'Crown Ceramic Coating <contact@crownceramiccoating.com>';
  const REPLY_TO = 'contact@crownceramiccoating.com';
  const SITE = process.env.PUBLIC_BASE_URL || 'https://crownceramiccoating.com';
  const SHOP_ADDRESS = process.env.SHOP_ADDRESS || 'Forney, TX (full address provided in your confirmation)';

  const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const dowInTZ = (d) => {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
    return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[wd];
  };
  const prettyDate = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(d));
  const prettyDateTime = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d)) + ' CST';

  // ---- Schema (idempotent) ----------------------------------------------
  async function ensureSchema() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS schedule_blackouts (
        id SERIAL PRIMARY KEY,
        blackout_date DATE UNIQUE,
        reason VARCHAR(200),
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS surveys (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) UNIQUE NOT NULL,
        lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        service_type VARCHAR(160),
        appointment_id INTEGER,
        rating INTEGER,
        responses JSONB DEFAULT '{}'::jsonb,
        comments TEXT,
        sent_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      // appointments: add lifecycle columns if missing
      for (const col of [
        ['reminder_48_sent', 'BOOLEAN DEFAULT FALSE'],
        ['survey_sent', 'BOOLEAN DEFAULT FALSE'],
        ['confirmation_sent', 'BOOLEAN DEFAULT FALSE'],
        ['service_type', 'VARCHAR(160)'],
        ['lead_phone', 'VARCHAR(60)'],
        ['lead_id', 'INTEGER']
      ]) {
        await pool.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='appointments' AND column_name='${col[0]}')
           THEN ALTER TABLE appointments ADD COLUMN ${col[0]} ${col[1]}; END IF; END $$;`
        ).catch(() => {});
      }
      // service_requests: add reply columns
      for (const col of [
        ['admin_response', 'TEXT'],
        ['responded_at', 'TIMESTAMP'],
        ['response_sent', 'BOOLEAN DEFAULT FALSE']
      ]) {
        await pool.query(
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='service_requests' AND column_name='${col[0]}')
           THEN ALTER TABLE service_requests ADD COLUMN ${col[0]} ${col[1]}; END IF; END $$;`
        ).catch(() => {});
      }
      console.log('[CROWN] Automation schema ensured (surveys, blackouts, appointment + service_request columns).');
    } catch (e) {
      console.error('[CROWN] ensureSchema error:', e.message);
    }
  }

  // ---- Branded email shell ----------------------------------------------
  const C = { card: '#1a1a1a', gold: '#c9a14a', gold2: '#e6c879', text: '#f4f1ea', muted: '#9b958c', line: 'rgba(201,161,74,0.22)', page: '#0d0d0d' };
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const SERIF = "Georgia,'Times New Roman',serif";

  function shell(kicker, title, innerHtml, preheader = '') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};"><tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${C.card};border-radius:12px;overflow:hidden;">
  <tr><td style="background:${C.card};padding:28px 40px 20px;border-bottom:1px solid ${C.line};">
    <span style="font-family:${SERIF};font-size:13px;letter-spacing:6px;color:${C.gold};text-transform:uppercase;">&#9819; Crown</span>
    <span style="font-family:${FONT};font-size:11px;letter-spacing:3px;color:${C.muted};text-transform:uppercase;"> &nbsp;Ceramic Coating</span>
  </td></tr>
  <tr><td style="background:linear-gradient(135deg,#1f1d1a,#141312);padding:30px 40px 24px;border-bottom:1px solid ${C.line};">
    ${kicker ? `<div style="font-family:${FONT};font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${C.gold};margin-bottom:10px;">${kicker}</div>` : ''}
    <div style="font-family:${SERIF};font-size:26px;line-height:1.2;color:${C.text};font-weight:700;">${title}</div>
  </td></tr>
  <tr><td style="background:${C.card};padding:30px 40px;font-family:${FONT};font-size:15px;line-height:1.75;color:${C.text};">${innerHtml}</td></tr>
  <tr><td style="background:#111010;padding:24px 40px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:1.7;color:${C.muted};">
    <strong style="color:${C.text};">Crown Ceramic Coating</strong> &middot; Forney &amp; the DFW metro<br>
    ${PHONE} &middot; <a href="mailto:${REPLY_TO}" style="color:${C.gold};text-decoration:none;">${REPLY_TO}</a><br>${OPEN_LABEL}
  </td></tr>
</table></td></tr></table></body></html>`;
  }
  const btn = (label, href) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0;"><tr><td bgcolor="${C.gold}" style="border-radius:6px;"><a href="${href}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#16130c;text-decoration:none;border-radius:6px;">${label}</a></td></tr></table>`;
  const P = (t) => `<p style="margin:0 0 15px;">${t}</p>`;

  async function sendMail({ to, subject, html, attachments }) {
    try {
      if (!to) return false;
      await transporter.sendMail({ from: EMAIL_FROM, replyTo: REPLY_TO, to, subject, html, attachments });
      console.log(`[CROWN MAIL] sent "${subject}" -> ${to}`);
      return true;
    } catch (e) {
      console.error(`[CROWN MAIL] FAILED "${subject}" -> ${to}:`, e.message);
      return false;
    }
  }

  // ---- Lifecycle email bodies -------------------------------------------
  const scheduleLink = () => `${SITE}/schedule.html`;

  function mailConsultationConfirmed(name, whenStr, service) {
    return shell('Consultation booked', 'We&rsquo;ve got you on the calendar.',
      P(`Hi ${esc(name)},`) +
      P(`Your free consultation${service ? ` for <strong>${esc(service)}</strong>` : ''} is set for <strong style="color:${C.gold2}">${whenStr}</strong>.`) +
      P(`We&rsquo;ll walk your vehicle, talk through options, and give you an honest quote &mdash; no pressure. If you need to make a change, just use the link below.`) +
      btn('Reschedule or Cancel', scheduleLink()) +
      P(`Questions before then? Call ${PHONE} or reply to this email.`),
      'Your Crown consultation is confirmed.');
  }
  function mailCancelled(name, whenStr, what) {
    return shell('Cancellation confirmed', `Your ${what} has been canceled.`,
      P(`Hi ${esc(name)},`) +
      P(`This confirms your ${what} for <strong>${whenStr}</strong> has been canceled. No further action is needed.`) +
      P(`Changed your mind, or want to find a new time? We&rsquo;d love to take care of your vehicle &mdash; pick a new date whenever you&rsquo;re ready:`) +
      btn('Reschedule Now', scheduleLink()) +
      P(`We&rsquo;re here if you need anything: ${PHONE}.`),
      `Your ${what} was canceled — reschedule anytime.`);
  }
  function mailServiceScheduled(name, whenStr, service) {
    return shell('Service scheduled', 'Your appointment is booked.',
      P(`Hi ${esc(name)},`) +
      P(`You&rsquo;re on the schedule for <strong style="color:${C.gold2}">${service ? esc(service) + ' — ' : ''}${whenStr}</strong>. We can&rsquo;t wait to make your vehicle shine.`) +
      P(`We&rsquo;ll send full prep instructions and directions 48 hours before your appointment. Need to change it?`) +
      btn('Reschedule or Cancel', scheduleLink()) +
      P(`Talk soon &mdash; ${PHONE}.`),
      'Your Crown service is scheduled.');
  }
  function mail48hr(name, whenStr, service) {
    return shell('See you in 48 hours', 'Getting ready for your appointment.',
      P(`Hi ${esc(name)},`) +
      P(`Your ${service ? '<strong>' + esc(service) + '</strong> ' : ''}appointment is coming up on <strong style="color:${C.gold2}">${whenStr}</strong>. Here&rsquo;s what to expect:`) +
      `<table role="presentation" width="100%" style="margin:4px 0 16px;">
        ${[
          ['Before you come in', 'A quick rinse is fine, but no need to detail — we handle full prep, wash, and decontamination here.'],
          ['Drop-off', `Arrive at ${esc(SHOP_ADDRESS)} at your scheduled time. Plan for the vehicle to stay with us so coatings cure properly.`],
          ['The process', 'Inspection → wash & decon → paint correction (if included) → coating application → curing → final inspection with you.'],
          ['After', 'We&rsquo;ll give you simple aftercare instructions to protect your finish and keep your warranty valid.']
        ].map(([h, b]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #2a2a2a;"><strong style="color:${C.gold2};">${h}</strong><br><span style="color:${C.muted};font-size:14px;">${b}</span></td></tr>`).join('')}
      </table>` +
      P(`Questions or running late? Call or text ${PHONE} &mdash; we&rsquo;ll make it work.`),
      'Your appointment is in 48 hours — here’s the plan.');
  }
  function mailPaymentReceipt(name, amount, invNo) {
    return shell('Payment received', 'Thank you — payment confirmed.',
      P(`Hi ${esc(name)},`) +
      P(`We&rsquo;ve received your payment${amount ? ` of <strong style="color:${C.gold2}">${esc(amount)}</strong>` : ''}${invNo ? ` for invoice <strong>${esc(invNo)}</strong>` : ''}. Your account is fully paid &mdash; thank you for trusting Crown.`) +
      P(`A copy is saved in your client portal. If you need anything else, just reply.`),
      'Your payment to Crown Ceramic Coating is confirmed.');
  }
  function mailSurvey(name, link, service) {
    return shell('How did we do?', 'Your finish is ready — tell us how we did.',
      P(`Hi ${esc(name)},`) +
      P(`Thanks for trusting Crown with your ${service ? esc(service) : 'vehicle'}. Your feedback takes about a minute and helps us keep raising the bar.`) +
      btn('Take the 1-Minute Survey', link) +
      P(`Spotted anything you&rsquo;d like us to look at? Reply here &mdash; your finish is backed by us.`),
      'A quick favor — how did Crown do?');
  }
  function mailServiceRequestReceived(name, type) {
    return shell('Request received', 'We&rsquo;ve got your service request.',
      P(`Hi ${esc(name)},`) +
      P(`Thanks &mdash; we&rsquo;ve received your request${type ? ` for <strong>${esc(type)}</strong>` : ''}. Our team will review it and reply shortly. You&rsquo;ll get an email the moment we respond, and you can always check status in your client portal.`),
      'We received your service request.');
  }
  function mailServiceRequestReply(name, type, response) {
    return shell('We replied', 'A response to your request.',
      P(`Hi ${esc(name)},`) +
      P(`Here&rsquo;s our response to your request${type ? ` for <strong>${esc(type)}</strong>` : ''}:`) +
      `<div style="background:#222121;border-left:3px solid ${C.gold};border-radius:6px;padding:14px 18px;margin:0 0 16px;color:${C.text};">${esc(response).replace(/\n/g, '<br>')}</div>` +
      btn('View in Your Portal', `${SITE}/client_portal.html`) +
      P(`Reply any time with follow-up questions, or call ${PHONE}.`),
      'Crown responded to your service request.');
  }
  function mailSalesAgreement(name, agNo, service, price) {
    return shell('Your agreement', 'Your service agreement is ready.',
      P(`Hi ${esc(name)},`) +
      P(`Attached is your Crown Ceramic Coating service agreement${agNo ? ` (<strong>${esc(agNo)}</strong>)` : ''}${service ? ` for <strong>${esc(service)}</strong>` : ''}${price ? `, total <strong style="color:${C.gold2}">${esc(price)}</strong>` : ''}.`) +
      P(`Please review the attached PDF. If everything looks good, reply to confirm and we&rsquo;ll lock in your date. Questions? Call ${PHONE}.`),
      'Your Crown service agreement is attached.');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- Sales-agreement PDF ----------------------------------------------
  function buildAgreementPDF(ag) {
    return new Promise((resolve, reject) => {
      if (!PDFDocument) return reject(new Error('pdfkit not available'));
      try {
        const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        const gold = '#b8923f';
        doc.fillColor(gold).fontSize(20).font('Helvetica-Bold').text('CROWN CERAMIC COATING', { align: 'center' });
        doc.moveDown(0.2).fillColor('#444').fontSize(10).font('Helvetica').text('Ceramic Coating · Paint Correction · Detailing — Forney & DFW, TX', { align: 'center' });
        doc.moveDown(1).strokeColor(gold).lineWidth(1).moveTo(54, doc.y).lineTo(558, doc.y).stroke();
        doc.moveDown(1).fillColor('#111').fontSize(16).font('Helvetica-Bold').text('Service Agreement');
        doc.moveDown(0.5).fontSize(11).font('Helvetica').fillColor('#222');
        const row = (k, v) => { doc.font('Helvetica-Bold').text(k + ':  ', { continued: true }).font('Helvetica').text(v || '—'); };
        row('Agreement #', ag.agreement_number || ('#' + ag.id));
        row('Date', new Date(ag.created_at || Date.now()).toLocaleDateString('en-US'));
        row('Customer', ag.customer_name || ag.lead_name);
        row('Email', ag.customer_email || ag.lead_email);
        row('Vehicle', ag.vehicle);
        row('Service', [ag.service_type, ag.package_name].filter(Boolean).join(' — '));
        row('Start date', ag.start_date ? new Date(ag.start_date).toLocaleDateString('en-US') : '—');
        row('Price', ag.price != null ? ('$' + Number(ag.price).toFixed(2)) : '—');
        row('Deposit', ag.deposit != null ? ('$' + Number(ag.deposit).toFixed(2)) : '—');
        if (ag.terms) { doc.moveDown(0.8).font('Helvetica-Bold').text('Terms'); doc.font('Helvetica').fillColor('#333').text(ag.terms); }
        if (ag.notes) { doc.moveDown(0.6).font('Helvetica-Bold').fillColor('#222').text('Notes'); doc.font('Helvetica').fillColor('#333').text(ag.notes); }
        doc.moveDown(2).fontSize(10).fillColor('#666').text('Coating warranties, where applicable, are valid only with recommended maintenance and care. This agreement is subject to Crown Ceramic Coating\u2019s full Terms of Service.', { align: 'left' });
        doc.moveDown(2).fillColor('#111').fontSize(11);
        doc.text('Customer signature: ______________________________     Date: ____________');
        doc.moveDown(1).text('Crown representative: ____________________________     Date: ____________');
        doc.end();
      } catch (e) { reject(e); }
    });
  }

  // ===========================================================================
  // ROUTES
  // ===========================================================================

  // --- Day-based availability (#3): respects open days + blackouts + 1/day ---
  app.get('/api/public/availability', async (req, res) => {
    try {
      await ensureSchema();
      const days = Math.min(parseInt(req.query.days || BOOKING_WINDOW_DAYS, 10) || BOOKING_WINDOW_DAYS, 120);
      const blackouts = new Set((await pool.query('SELECT blackout_date FROM schedule_blackouts').catch(() => ({ rows: [] }))).rows.map(r => ymd(new Date(r.blackout_date))));
      // days already taken (one job per day)
      const taken = new Set();
      const apt = await pool.query(`SELECT scheduled_time FROM appointments WHERE status NOT IN ('cancelled','canceled') AND scheduled_time >= NOW() - INTERVAL '1 day'`).catch(() => ({ rows: [] }));
      apt.rows.forEach(r => taken.add(ymd(new Date(r.scheduled_time))));

      const out = [];
      const now = new Date();
      for (let i = 1; i <= days; i++) {
        const d = new Date(now.getTime() + i * 86400000);
        const key = ymd(d);
        if (!OPEN_DOW.includes(dowInTZ(d))) continue;  // closed day (e.g. Sunday)
        if (blackouts.has(key)) continue;              // holiday / blackout
        if (taken.has(key)) continue;                  // already has a job
        out.push({ date: key, label: prettyDate(d) });
      }
      res.json({ success: true, hours: OPEN_LABEL, timezone: TZ, available: out });
    } catch (e) {
      console.error('[CROWN availability]', e.message);
      res.status(500).json({ success: false, message: 'Could not load availability.' });
    }
  });

  // --- Public booking used by schedule.html (#3/#7) --------------------------
  // Mirrors contact.html routing: creates/updates a lead + an appointment row
  // (so it shows on the admin Schedule tab) and emails a confirmation.
  app.post('/api/public/schedule', async (req, res) => {
    try {
      await ensureSchema();
      const { name, email, phone, date, service, eventType, message, vehicle } = req.body || {};
      if (!name || !email || !date) return res.status(400).json({ success: false, message: 'Name, email and a date are required.' });

      // Validate the date is actually bookable
      const d = new Date(`${date}T12:00:00`);
      if (!OPEN_DOW.includes(dowInTZ(d))) return res.status(400).json({ success: false, message: 'We\u2019re closed that day. Please choose Mon–Sat.' });
      const black = await pool.query('SELECT 1 FROM schedule_blackouts WHERE blackout_date = $1', [date]).catch(() => ({ rows: [] }));
      if (black.rows.length) return res.status(400).json({ success: false, message: 'That date is unavailable. Please choose another.' });
      const dayTaken = await pool.query(`SELECT 1 FROM appointments WHERE status NOT IN ('cancelled','canceled') AND DATE(scheduled_time AT TIME ZONE '${TZ}') = $1 LIMIT 1`, [date]).catch(() => ({ rows: [] }));
      if (dayTaken.rows.length) return res.status(409).json({ success: false, message: 'That day was just booked. Please pick another date.' });

      const type = (eventType === 'service') ? 'service' : 'consultation';
      const scheduledTime = new Date(`${date}T09:00:00-06:00`).toISOString(); // 9:00 AM CST anchor
      const noteText = `${type === 'service' ? 'Service' : 'Consultation'} booked via schedule.html${service ? ' — ' + service : ''}${vehicle ? ' (' + vehicle + ')' : ''}${message ? ' — ' + message : ''}`;

      // Find or create the lead
      let lead = (await pool.query('SELECT id, name FROM leads WHERE LOWER(email)=LOWER($1) LIMIT 1', [email])).rows[0];
      if (!lead) {
        lead = (await pool.query(
          `INSERT INTO leads (name, email, phone, status, lead_temperature, source, notes, created_at, updated_at)
           VALUES ($1,$2,$3,'new','hot','schedule-page',$4,NOW(),NOW()) RETURNING id, name`,
          [name, email, phone || null, noteText])).rows[0];
      } else {
        await pool.query(`UPDATE leads SET lead_temperature='hot', became_hot_at=COALESCE(became_hot_at,NOW()), status='contacted',
          notes = COALESCE(notes || E'\\n\\n','') || $2, updated_at=NOW() WHERE id=$1`, [lead.id, noteText]).catch(() => {});
      }

      const apt = (await pool.query(
        `INSERT INTO appointments (lead_email, lead_name, lead_phone, lead_id, scheduled_time, event_type, service_type, status, notes, confirmation_sent, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8,TRUE,NOW()) RETURNING *`,
        [email, name, phone || null, lead.id, scheduledTime, type, service || null, noteText])).rows[0];

      const whenStr = prettyDate(d);
      if (type === 'service') await sendMail({ to: email, subject: 'Your Crown service is scheduled', html: mailServiceScheduled(name, whenStr, service) });
      else await sendMail({ to: email, subject: 'Your Crown consultation is confirmed', html: mailConsultationConfirmed(name, whenStr, service) });

      res.json({ success: true, appointmentId: apt.id, leadId: lead.id, when: whenStr });
    } catch (e) {
      console.error('[CROWN schedule]', e.message);
      res.status(500).json({ success: false, message: 'Could not complete booking.' });
    }
  });

  // --- Surveys (#7) ----------------------------------------------------------
  app.get('/survey', (req, res) => res.sendFile(path.join(__dirname, 'public', 'survey.html')));
  app.get('/survey.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'survey.html')));

  // Survey context for the page (token-scoped, no auth — token IS the auth)
  app.get('/api/public/survey/:token', async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT s.token, s.customer_name, s.service_type, s.completed_at,
                COALESCE(s.customer_name, l.name) AS name
           FROM surveys s LEFT JOIN leads l ON s.lead_id = l.id
          WHERE s.token = $1`, [req.params.token]);
      if (!r.rows.length) return res.status(404).json({ success: false, message: 'Survey not found.' });
      res.json({ success: true, survey: r.rows[0], already: !!r.rows[0].completed_at });
    } catch (e) { res.status(500).json({ success: false, message: 'Error loading survey.' }); }
  });

  app.post('/api/public/survey/:token', async (req, res) => {
    try {
      const { rating, comments, responses } = req.body || {};
      const upd = await pool.query(
        `UPDATE surveys SET rating=$2, comments=$3, responses=$4, completed_at=NOW()
          WHERE token=$1 AND completed_at IS NULL RETURNING id, lead_id`,
        [req.params.token, rating ? parseInt(rating, 10) : null, comments || null, JSON.stringify(responses || {})]);
      if (!upd.rows.length) {
        const exists = await pool.query('SELECT 1 FROM surveys WHERE token=$1', [req.params.token]);
        if (exists.rows.length) return res.json({ success: true, already: true });
        return res.status(404).json({ success: false, message: 'Survey not found.' });
      }
      res.json({ success: true });
    } catch (e) { console.error('[CROWN survey submit]', e.message); res.status(500).json({ success: false, message: 'Could not submit survey.' }); }
  });

  // Create + email a survey for a completed service. Reusable + manual resend.
  async function createAndSendSurvey({ leadId, name, email, serviceType, appointmentId }) {
    const token = crypto.randomBytes(18).toString('hex');
    await pool.query(
      `INSERT INTO surveys (token, lead_id, customer_name, customer_email, service_type, appointment_id, sent_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
      [token, leadId || null, name || null, email || null, serviceType || null, appointmentId || null]);
    const link = `${SITE}/survey.html?token=${token}`;
    await sendMail({ to: email, subject: 'How did we do? — Crown Ceramic Coating', html: mailSurvey(name, link, serviceType) });
    return token;
  }

  // Admin: list surveys (for the Surveys tab) — newest first, attached to lead
  app.get('/api/admin/surveys', authed(), async (req, res) => {
    try {
      await ensureSchema();
      const r = await pool.query(
        `SELECT s.*, l.name AS lead_name, l.email AS lead_email, l.is_customer
           FROM surveys s LEFT JOIN leads l ON s.lead_id = l.id
          ORDER BY s.completed_at DESC NULLS LAST, s.created_at DESC`);
      res.json({ success: true, surveys: r.rows });
    } catch (e) { res.status(500).json({ success: false, message: 'Could not load surveys.' }); }
  });

  // Admin: manually (re)send a survey to a lead/customer
  app.post('/api/admin/leads/:id/send-survey', authed(), async (req, res) => {
    try {
      const l = (await pool.query('SELECT id, name, email FROM leads WHERE id=$1', [req.params.id])).rows[0];
      if (!l) return res.status(404).json({ success: false, message: 'Lead not found.' });
      const token = await createAndSendSurvey({ leadId: l.id, name: l.name, email: l.email, serviceType: req.body?.serviceType });
      res.json({ success: true, token });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // Admin: respond to a service request (#7) — emails the client + stores reply
  app.post('/api/admin/service-requests/:id/respond', authed(), async (req, res) => {
    try {
      await ensureSchema();
      const { response } = req.body || {};
      if (!response || !response.trim()) return res.status(400).json({ success: false, message: 'Response text required.' });
      const sr = (await pool.query(
        `SELECT sr.*, l.name AS lead_name, l.email AS lead_email
           FROM service_requests sr LEFT JOIN leads l ON sr.lead_id = l.id WHERE sr.id=$1`, [req.params.id])).rows[0];
      if (!sr) return res.status(404).json({ success: false, message: 'Service request not found.' });
      await pool.query(`UPDATE service_requests SET admin_response=$2, responded_at=NOW(), response_sent=TRUE, status='responded', updated_at=NOW() WHERE id=$1`, [sr.id, response]);
      await sendMail({ to: sr.lead_email, subject: 'Crown responded to your service request', html: mailServiceRequestReply(sr.lead_name, sr.service_type, response) });
      res.json({ success: true });
    } catch (e) { console.error('[CROWN sr-respond]', e.message); res.status(500).json({ success: false, message: e.message }); }
  });

  // Admin: (re)send a sales-agreement PDF by email (#7)
  app.post('/api/admin/sales-agreements/:id/email', authed(), async (req, res) => {
    try {
      const ag = (await pool.query(
        `SELECT sa.*, l.name AS lead_name, l.email AS lead_email
           FROM sales_agreements sa LEFT JOIN leads l ON sa.lead_id = l.id WHERE sa.id=$1`, [req.params.id])).rows[0];
      if (!ag) return res.status(404).json({ success: false, message: 'Agreement not found.' });
      const to = ag.customer_email || ag.lead_email;
      if (!to) return res.status(400).json({ success: false, message: 'No customer email on this agreement.' });
      const attachments = [];
      try {
        const pdf = await buildAgreementPDF(ag);
        attachments.push({ filename: `Crown-Agreement-${(ag.agreement_number || ag.id)}.pdf`, content: pdf, contentType: 'application/pdf' });
      } catch (pdfErr) { console.warn('[CROWN agreement pdf]', pdfErr.message); }
      await sendMail({
        to, subject: 'Your Crown Ceramic Coating service agreement',
        html: mailSalesAgreement(ag.customer_name || ag.lead_name, ag.agreement_number, [ag.service_type, ag.package_name].filter(Boolean).join(' — '), ag.price != null ? '$' + Number(ag.price).toFixed(2) : ''),
        attachments
      });
      res.json({ success: true });
    } catch (e) { console.error('[CROWN ag-email]', e.message); res.status(500).json({ success: false, message: e.message }); }
  });
  // expose for auto-send on creation (server.js can call global hook)
  global.__crownEmailAgreement = async (agreementId) => {
    try {
      const ag = (await pool.query(`SELECT sa.*, l.name AS lead_name, l.email AS lead_email FROM sales_agreements sa LEFT JOIN leads l ON sa.lead_id=l.id WHERE sa.id=$1`, [agreementId])).rows[0];
      if (!ag) return;
      const to = ag.customer_email || ag.lead_email; if (!to) return;
      const attachments = [];
      try { const pdf = await buildAgreementPDF(ag); attachments.push({ filename: `Crown-Agreement-${(ag.agreement_number || ag.id)}.pdf`, content: pdf, contentType: 'application/pdf' }); } catch (_) {}
      await sendMail({ to, subject: 'Your Crown Ceramic Coating service agreement', html: mailSalesAgreement(ag.customer_name || ag.lead_name, ag.agreement_number, [ag.service_type, ag.package_name].filter(Boolean).join(' — '), ag.price != null ? '$' + Number(ag.price).toFixed(2) : ''), attachments });
    } catch (e) { console.warn('[CROWN auto-agreement]', e.message); }
  };

  // Global hooks server.js can call from existing routes (defensive, optional)
  global.__crownMail = {
    consultationCancelled: (name, email, whenStr) => sendMail({ to: email, subject: 'Your Crown consultation was canceled', html: mailCancelled(name, whenStr, 'consultation') }),
    serviceCancelled: (name, email, whenStr) => sendMail({ to: email, subject: 'Your Crown service was canceled', html: mailCancelled(name, whenStr, 'service appointment') }),
    paymentReceipt: (name, email, amount, invNo) => sendMail({ to: email, subject: 'Payment received — Crown Ceramic Coating', html: mailPaymentReceipt(name, amount, invNo) }),
    serviceRequestReceived: (name, email, type) => sendMail({ to: email, subject: 'We received your service request', html: mailServiceRequestReceived(name, type) }),
    sendSurvey: createAndSendSurvey
  };

  // ---- Scheduler: 48-hr reminders + survey on completion --------------------
  async function runScheduler() {
    try {
      await ensureSchema();
      // 48-hour reminders (window 46–50h out, not yet reminded, not cancelled)
      const due = await pool.query(
        `SELECT id, lead_name, lead_email, scheduled_time, service_type
           FROM appointments
          WHERE status NOT IN ('cancelled','canceled','completed')
            AND COALESCE(reminder_48_sent,FALSE)=FALSE
            AND scheduled_time BETWEEN NOW() + INTERVAL '46 hours' AND NOW() + INTERVAL '50 hours'`);
      for (const a of due.rows) {
        const ok = await sendMail({ to: a.lead_email, subject: 'Your Crown appointment is in 48 hours', html: mail48hr(a.lead_name, prettyDate(a.scheduled_time), a.service_type) });
        if (ok) await pool.query('UPDATE appointments SET reminder_48_sent=TRUE WHERE id=$1', [a.id]).catch(() => {});
      }
      // Surveys for services marked completed but not yet surveyed
      const done = await pool.query(
        `SELECT id, lead_id, lead_name, lead_email, service_type
           FROM appointments
          WHERE status='completed' AND COALESCE(survey_sent,FALSE)=FALSE AND lead_email IS NOT NULL`);
      for (const a of done.rows) {
        try {
          await createAndSendSurvey({ leadId: a.lead_id, name: a.lead_name, email: a.lead_email, serviceType: a.service_type, appointmentId: a.id });
          await pool.query('UPDATE appointments SET survey_sent=TRUE WHERE id=$1', [a.id]).catch(() => {});
        } catch (e) { console.warn('[CROWN survey auto]', e.message); }
      }
    } catch (e) { console.error('[CROWN scheduler]', e.message); }
  }

  // Minimal auth wrapper: reuse server's JWT if exposed, else allow (admin UI already gated)
  function authed() {
    return (req, res, next) => {
      const fn = global.__authenticateToken;
      if (typeof fn === 'function') return fn(req, res, next);
      // Fallback: require a Bearer token presence at minimum
      const h = req.headers.authorization || '';
      if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Unauthorized' });
      next();
    };
  }

  ensureSchema().then(() => {
    runScheduler();
    setInterval(runScheduler, 30 * 60 * 1000); // every 30 minutes
    console.log('[CROWN] Automation initialized — scheduler running every 30 min.');
  });
};