/* ============================================================================
   crown-sms.js  —  Crown Ceramic Coating
   Admin-side SMS over Brevo. Step 1: server foundation.

   Wire-up (in server.js, next to the crown-automation require):
     require('./crown-sms.js')({
       app, pool, authenticateToken,
       sendSmsViaBrevo,                 // existing helper in server.js
       getBrevoKey: () => PLATFORM_BREVO_KEY
     });

   What this adds (all admin/authenticateToken):
     GET    /api/admin/sms/config                 → sender id + automation flags
     PUT    /api/admin/sms/config                 → save sender id + automation flags
     POST   /api/admin/leads/:id/send-sms         → send an SMS to a lead
     GET    /api/admin/leads/:id/sms-thread       → full SMS conversation for a lead
     POST   /api/admin/leads/:id/sms-thread/read  → mark inbound messages as read
     GET    /api/admin/sms/unread-count           → total unread inbound SMS (for the badge)

   Storage:
     • SMS sender id + automation flags live in a small key/value table
       `platform_settings` so the send path reads them reliably (env fallback).
     • Messages reuse the existing `message_log` table (channel='sms').
   ========================================================================== */

module.exports = function initCrownSms({ app, pool, authenticateToken, sendSmsViaBrevo, getBrevoKey }) {
  const log = (...a) => console.log('[CROWN-SMS]', ...a);

  // ---- Schema: settings table + a couple of additive columns -----------------
  async function ensureSmsSchema() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS platform_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Track read state for inbound messages (so the badge can show unread).
      await pool.query(`ALTER TABLE message_log ADD COLUMN IF NOT EXISTS read_at TIMESTAMP`);
      // Honor STOP/START opt-outs (legal requirement for SMS).
      await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_opt_out BOOLEAN DEFAULT FALSE`);
      // Recurring automatic marketing-text rules (one row per audience).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sms_marketing_auto (
          audience      TEXT PRIMARY KEY,
          message       TEXT,
          interval_days INTEGER DEFAULT 14,
          is_active     BOOLEAN DEFAULT FALSE,
          last_run_at   TIMESTAMP,
          updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      log('SMS schema ensured (platform_settings, message_log.read_at, leads.sms_opt_out, sms_marketing_auto).');
    } catch (e) {
      console.error('[CROWN-SMS] schema error:', e.message);
    }
  }
  ensureSmsSchema();

  // ---- Settings helpers ------------------------------------------------------
  async function getSetting(key, fallback = null) {
    try {
      const r = await pool.query('SELECT value FROM platform_settings WHERE key=$1', [key]);
      return r.rows.length ? r.rows[0].value : fallback;
    } catch (e) { return fallback; }
  }
  async function setSetting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, value == null ? null : String(value)]
    );
  }

  // The "from" the recipient sees. Brevo alphanumeric sender IDs are max 11 chars.
  async function getSmsSender() {
    return (await getSetting('sms_sender_id')) || process.env.BREVO_SMS_SENDER || 'Crown';
  }

  // ---- Phone normalization (E.164, US default) — mirrors the client path -----
  function toE164(raw) {
    if (!raw) return null;
    let p = String(raw).trim();
    const hadPlus = p.startsWith('+');
    let digits = p.replace(/[^0-9]/g, '');
    if (hadPlus) return '+' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    if (digits.length === 10) return '+1' + digits;
    return '+' + digits; // best effort
  }

  // ---- Reusable send used by both the endpoint and (later) automation --------
  // Returns { success, messageId } or throws.
  async function sendSmsToLead(leadId, message, { skipOptOutCheck = false } = {}) {
    const key = getBrevoKey && getBrevoKey();
    if (!key) throw new Error('BREVO_API_KEY not configured on the server.');
    if (!message || !message.trim()) throw new Error('Message is empty.');

    const lr = await pool.query(
      'SELECT id, name, phone, sms_opt_out, client_portal_id FROM leads WHERE id=$1 LIMIT 1', [leadId]
    );
    if (!lr.rows.length) throw new Error('Lead not found.');
    const lead = lr.rows[0];
    if (!lead.phone) throw new Error('This lead has no phone number on file.');
    if (!skipOptOutCheck && lead.sms_opt_out) throw new Error('This contact has opted out of SMS (replied STOP).');

    const toPhone = toE164(lead.phone);
    const sender  = await getSmsSender();

    const result = await sendSmsViaBrevo(key, sender, toPhone, message.trim());

    await pool.query(
      `INSERT INTO message_log
         (lead_id, client_portal_id, direction, channel, content, from_number, to_number, status, brevo_message_id, sent_at)
       VALUES ($1,$2,'outbound','sms',$3,$4,$5,'sent',$6,NOW())`,
      [lead.id, lead.client_portal_id || null, message.trim(), sender, toPhone,
       result && result.messageId ? String(result.messageId) : null]
    );
    await pool.query(
      `UPDATE leads SET last_contact_date=CURRENT_DATE, updated_at=NOW() WHERE id=$1`, [lead.id]
    ).catch(() => {});

    return { success: true, messageId: result && result.messageId, to: toPhone, sender };
  }
  // Expose for the automation step (step 3) without re-importing.
  app.locals.crownSendSmsToLead = sendSmsToLead;
  app.locals.crownGetSmsSender  = getSmsSender;

  // ---- Endpoints -------------------------------------------------------------

  // Read SMS config
  app.get('/api/admin/sms/config', authenticateToken, async (req, res) => {
    try {
      res.json({
        success: true,
        config: {
          smsSenderId:    (await getSetting('sms_sender_id')) || process.env.BREVO_SMS_SENDER || '',
          smsEnabled:     (await getSetting('sms_enabled', 'true')) === 'true',
          autoFollowups:  (await getSetting('sms_auto_followups', 'false')) === 'true',
          autoMarketing:  (await getSetting('sms_auto_marketing', 'false')) === 'true',
          followupText:   (await getSetting('sms_followup_text')) || '',
          brevoKeySet:    !!(getBrevoKey && getBrevoKey())
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Save SMS config
  app.put('/api/admin/sms/config', authenticateToken, async (req, res) => {
    try {
      const { smsSenderId, smsEnabled, autoFollowups, autoMarketing, followupText } = req.body || {};
      if (typeof smsSenderId === 'string') {
        const trimmed = smsSenderId.trim();
        // Brevo alphanumeric sender IDs are capped at 11 chars; numbers can be longer.
        if (/[a-zA-Z]/.test(trimmed) && trimmed.replace(/\s/g, '').length > 11) {
          return res.status(400).json({ success: false, message: 'Alphanumeric sender IDs are limited to 11 characters by Brevo.' });
        }
        await setSetting('sms_sender_id', trimmed);
      }
      if (smsEnabled    !== undefined) await setSetting('sms_enabled',        smsEnabled ? 'true' : 'false');
      if (autoFollowups !== undefined) await setSetting('sms_auto_followups', autoFollowups ? 'true' : 'false');
      if (autoMarketing !== undefined) await setSetting('sms_auto_marketing', autoMarketing ? 'true' : 'false');
      if (typeof followupText === 'string') await setSetting('sms_followup_text', followupText.trim());
      res.json({ success: true, message: 'SMS settings saved.' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Send an SMS to a lead
  app.post('/api/admin/leads/:id/send-sms', authenticateToken, async (req, res) => {
    try {
      if ((await getSetting('sms_enabled', 'true')) !== 'true') {
        return res.status(400).json({ success: false, message: 'SMS is turned off in Settings → Brevo.' });
      }
      const out = await sendSmsToLead(req.params.id, (req.body && req.body.message) || '');
      res.json({ success: true, ...out });
    } catch (e) {
      console.error('[CROWN-SMS] send error:', e.message);
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // Full SMS conversation for one lead (for the iMessage-style module in step 2)
  app.get('/api/admin/leads/:id/sms-thread', authenticateToken, async (req, res) => {
    try {
      const lr = await pool.query('SELECT id, name, phone, sms_opt_out FROM leads WHERE id=$1 LIMIT 1', [req.params.id]);
      if (!lr.rows.length) return res.status(404).json({ success: false, message: 'Lead not found.' });
      const msgs = await pool.query(
        `SELECT id, direction, content, status, read_at, sent_at, from_number, to_number
           FROM message_log
          WHERE lead_id=$1 AND channel='sms'
          ORDER BY sent_at ASC`, [req.params.id]
      );
      res.json({ success: true, lead: lr.rows[0], messages: msgs.rows });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Mark a lead's inbound SMS as read
  app.post('/api/admin/leads/:id/sms-thread/read', authenticateToken, async (req, res) => {
    try {
      await pool.query(
        `UPDATE message_log SET read_at=NOW()
          WHERE lead_id=$1 AND channel='sms' AND direction='inbound' AND read_at IS NULL`,
        [req.params.id]
      );
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Total unread inbound SMS (drives the message-icon badge)
  app.get('/api/admin/sms/unread-count', authenticateToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT COUNT(*) AS n FROM message_log WHERE channel='sms' AND direction='inbound' AND read_at IS NULL`
      );
      res.json({ success: true, count: parseInt(r.rows[0]?.n || 0, 10) });
    } catch (e) {
      res.json({ success: true, count: 0 });
    }
  });

  // Bulk SMS to an audience (mirrors /api/marketing/blast audiences, but for phones).
  app.post('/api/admin/sms/blast', authenticateToken, async (req, res) => {
    try {
      if ((await getSetting('sms_enabled', 'true')) !== 'true') {
        return res.status(400).json({ success: false, message: 'SMS is turned off in Settings → Brevo.' });
      }
      const { audience, message } = req.body || {};
      if (!message || !message.trim()) return res.status(400).json({ success: false, message: 'Message is required.' });

      // Phone + opt-out aware audience resolution (parallels the email blast).
      const base = `SELECT id FROM leads
                    WHERE phone IS NOT NULL AND phone <> ''
                      AND COALESCE(sms_opt_out, FALSE) = FALSE
                      AND COALESCE(unsubscribed, FALSE) = FALSE`;
      let where;
      switch (audience) {
        case 'all_leads':     where = `${base} AND is_customer = FALSE`; break;
        case 'hot_leads':     where = `${base} AND is_customer = FALSE AND lead_temperature = 'hot'`; break;
        case 'cold_leads':    where = `${base} AND is_customer = FALSE AND COALESCE(lead_temperature,'cold') <> 'hot'`; break;
        case 'all_customers': where = `${base} AND is_customer = TRUE`; break;
        case 'everyone':      where = base; break;
        default: return res.status(400).json({ success: false, message: `Unknown audience: ${audience}` });
      }

      const rows = (await pool.query(where)).rows;
      let sent = 0, skipped = 0;
      const errors = [];
      for (const row of rows) {
        try {
          await sendSmsToLead(row.id, message);
          sent++;
          await new Promise(r => setTimeout(r, 150)); // gentle pacing
        } catch (e) {
          skipped++;
          if (errors.length < 10) errors.push(e.message);
        }
      }
      res.json({ success: true, sent, skipped, total: rows.length, errors });
    } catch (e) {
      console.error('[CROWN-SMS] blast error:', e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // ---- Automatic sending --------------------------------------------------

  // Phone + opt-out aware audience WHERE (shared by blast + marketing-auto).
  function audienceWhere(audience) {
    const base = `phone IS NOT NULL AND phone <> ''
                  AND COALESCE(sms_opt_out, FALSE) = FALSE
                  AND COALESCE(unsubscribed, FALSE) = FALSE`;
    switch (audience) {
      case 'all_leads':     return `${base} AND is_customer = FALSE`;
      case 'hot_leads':     return `${base} AND is_customer = FALSE AND lead_temperature = 'hot'`;
      case 'cold_leads':    return `${base} AND is_customer = FALSE AND COALESCE(lead_temperature,'cold') <> 'hot'`;
      case 'all_customers': return `${base} AND is_customer = TRUE`;
      case 'everyone':      return base;
      default: return null;
    }
  }
  const KNOWN_AUDIENCES = ['all_leads', 'hot_leads', 'cold_leads', 'all_customers', 'everyone'];

  // List recurring marketing-auto rules (always returns a row per known audience).
  app.get('/api/admin/sms/marketing-auto', authenticateToken, async (req, res) => {
    try {
      const rows = (await pool.query('SELECT * FROM sms_marketing_auto')).rows;
      const byAud = Object.fromEntries(rows.map(r => [r.audience, r]));
      const rules = KNOWN_AUDIENCES.map(a => ({
        audience: a,
        message: byAud[a]?.message || '',
        intervalDays: byAud[a]?.interval_days || 14,
        isActive: !!byAud[a]?.is_active,
        lastRunAt: byAud[a]?.last_run_at || null
      }));
      res.json({ success: true, masterEnabled: (await getSetting('sms_auto_marketing', 'false')) === 'true', rules });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Save recurring marketing-auto rules.
  app.put('/api/admin/sms/marketing-auto', authenticateToken, async (req, res) => {
    try {
      const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
      for (const r of rules) {
        if (!KNOWN_AUDIENCES.includes(r.audience)) continue;
        await pool.query(
          `INSERT INTO sms_marketing_auto (audience, message, interval_days, is_active, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (audience) DO UPDATE SET
             message=EXCLUDED.message, interval_days=EXCLUDED.interval_days,
             is_active=EXCLUDED.is_active, updated_at=NOW()`,
          [r.audience, (r.message || '').trim(), Math.max(1, parseInt(r.intervalDays || 14, 10)), !!r.isActive]
        );
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // The cadence processor. Safe to call repeatedly — it dedups internally.
  async function processDueSms() {
    if (!(getBrevoKey && getBrevoKey())) return { followups: 0, marketing: 0, skipped: 'no brevo key' };
    if ((await getSetting('sms_enabled', 'true')) !== 'true') return { followups: 0, marketing: 0, skipped: 'sms disabled' };

    let followups = 0, marketing = 0;

    // 1) Automatic follow-up texts — ride the same cadence as follow-up emails.
    if ((await getSetting('sms_auto_followups', 'false')) === 'true') {
      const text = (await getSetting('sms_followup_text')) ||
        "Hi {{name}}, it's Crown Ceramic Coating following up — still interested in protecting your vehicle? Reply here or call us. Reply STOP to opt out.";
      // Due = same hot/cold timeline used elsewhere; only leads we haven't texted in 2 days.
      const due = await pool.query(`
        SELECT id, name FROM leads l
         WHERE is_customer = FALSE
           AND COALESCE(unsubscribed, FALSE) = FALSE
           AND COALESCE(sms_opt_out, FALSE) = FALSE
           AND phone IS NOT NULL AND phone <> ''
           AND status IN ('new','contacted','qualified','pending')
           AND (
             (lead_temperature = 'hot' AND (
                last_contact_date IS NULL
                OR (follow_up_count >= 1 AND follow_up_count % 2 = 1 AND last_contact_date <= CURRENT_DATE - INTERVAL '3.5 days')
                OR (follow_up_count >= 2 AND follow_up_count % 2 = 0 AND last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
             ))
             OR
             (COALESCE(lead_temperature,'cold') <> 'hot' AND (
                last_contact_date IS NULL
                OR (follow_up_count = 0 AND last_contact_date <= CURRENT_DATE - INTERVAL '3 days')
                OR (follow_up_count = 1 AND last_contact_date <= CURRENT_DATE - INTERVAL '5 days')
                OR (follow_up_count >= 2 AND last_contact_date <= CURRENT_DATE - INTERVAL '7 days')
             ))
           )
           AND NOT EXISTS (
             SELECT 1 FROM message_log ml
              WHERE ml.lead_id = l.id AND ml.channel='sms' AND ml.direction='outbound'
                AND ml.sent_at > NOW() - INTERVAL '2 days'
           )
      `);
      for (const lead of due.rows) {
        try {
          const personalized = text.replace(/\{\{\s*name\s*\}\}/gi, (lead.name || 'there').split(' ')[0]);
          await sendSmsToLead(lead.id, personalized);
          followups++;
          await new Promise(r => setTimeout(r, 150));
        } catch (e) { /* skip individual failures */ }
      }
    }

    // 2) Automatic recurring marketing texts (per-audience rules).
    if ((await getSetting('sms_auto_marketing', 'false')) === 'true') {
      const rules = (await pool.query(
        `SELECT * FROM sms_marketing_auto WHERE is_active = TRUE AND message IS NOT NULL AND message <> ''`
      )).rows;
      for (const rule of rules) {
        const dueNow = !rule.last_run_at ||
          (Date.now() - new Date(rule.last_run_at).getTime()) >= rule.interval_days * 86400000;
        if (!dueNow) continue;
        const where = audienceWhere(rule.audience);
        if (!where) continue;
        const recips = (await pool.query(`SELECT id, name FROM leads WHERE ${where}`)).rows;
        for (const lead of recips) {
          try {
            const personalized = (rule.message || '').replace(/\{\{\s*name\s*\}\}/gi, (lead.name || 'there').split(' ')[0]);
            await sendSmsToLead(lead.id, personalized);
            marketing++;
            await new Promise(r => setTimeout(r, 150));
          } catch (e) { /* skip */ }
        }
        await pool.query('UPDATE sms_marketing_auto SET last_run_at = NOW() WHERE audience = $1', [rule.audience]);
      }
    }

    if (followups || marketing) log(`Auto-send run: ${followups} follow-up texts, ${marketing} marketing texts.`);
    return { followups, marketing };
  }
  app.locals.crownProcessDueSms = processDueSms;

  // Manual / frontend trigger.
  app.post('/api/admin/sms/run-due', authenticateToken, async (req, res) => {
    try { res.json({ success: true, ...(await processDueSms()) }); }
    catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });

  // Run automatically on a timer too, so "automatic" works even if no one opens the page.
  setTimeout(() => { processDueSms().catch(() => {}); }, 30000);            // ~30s after boot
  setInterval(() => { processDueSms().catch(() => {}); }, 6 * 60 * 60 * 1000); // every 6 hours

  log('Admin SMS routes mounted.');
};