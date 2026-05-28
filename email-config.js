// ========================================
// email-config.js - Crown Ceramic Coating
// Nodemailer transport used by server.js.
// server.js imports: const { transporter, verifyEmailConfig } = require('./email-config.js');
//
// Configure via environment variables (e.g. in a .env file):
//   EMAIL_HOST      SMTP host           (default: smtp-relay.brevo.com)
//   EMAIL_PORT      SMTP port           (default: 587)
//   EMAIL_USER      SMTP username/login
//   EMAIL_PASS      SMTP password / API key
//   EMAIL_FROM      Default From header (default: Crown Ceramic Coating <contact@crownceramiccoating.com>)
// ========================================

const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: (process.env.EMAIL_PORT || '587') === '465', // true for 465, false for 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Sets a sensible default From header if the caller doesn't supply one.
transporter.use('compile', (mail, callback) => {
    if (!mail.data.from) {
        mail.data.from =
            process.env.EMAIL_FROM ||
            'Crown Ceramic Coating <contact@crownceramiccoating.com>';
    }
    callback();
});

// Verifies the SMTP connection. server.js awaits this on startup.
async function verifyEmailConfig() {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
            console.warn('[EMAIL] EMAIL_USER / EMAIL_PASS not set — email sending will fail until configured.');
            return false;
        }
        await transporter.verify();
        console.log('[EMAIL] SMTP transport verified for Crown Ceramic Coating.');
        return true;
    } catch (err) {
        console.error('[EMAIL] SMTP verification failed:', err.message);
        return false;
    }
}

module.exports = { transporter, verifyEmailConfig };