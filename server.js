require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
 
const app = express();
const client = new Anthropic();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(express.json());
app.use(express.static('public'));

app.post('/api/submit', async (req, res) => {
  const { name, desc, feels, logotypes, isotypes, isNone, avoid, brandRef } = req.body;

  const formatsDesc = [];
  if (logotypes && logotypes.length > 0) formatsDesc.push('Logotype: ' + logotypes.join(', '));
  if (isNone) formatsDesc.push('No isotype — logotype only');
  else if (isotypes && isotypes.length > 0) formatsDesc.push('Isotype: ' + isotypes.join(', '));

  const prompt = [
    'Brand: ' + name,
    'What it does: ' + desc,
    'Personality: ' + feels.join(', '),
    formatsDesc.join('\n'),
    avoid ? 'Avoid: ' + avoid : '',
    brandRef ? 'Brand reference: ' + brandRef + ' — extract visual DNA from this brand (materials, type style, era, construction) and let it inform the queries without naming the brand directly' : '',
    '',
    'Respond with ONLY a raw JSON array — no markdown, no explanation. Generate 8 Pinterest-style search keywords, 2-5 words each.',
    '[{"focus":"...","query":"..."},...]',
    '',
    'Rules:',
    '- Concrete visual terms: materials, eras, techniques, type styles',
    '- Good examples: "organic wax seal emblem", "swiss grid wordmark black", "brutalist lettermark bold", "90s geometric symbol", "engraved copper badge"',
    '- Shape queries around: ' + formatsDesc.join(', '),
    '- Personality (' + feels.join(', ') + ') informs tone without being stated literally',
    avoid ? '- Avoid references to: ' + avoid : '',
  ].filter(Boolean).join('\n');

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'No JSON array in response', raw: text });
    }

    const keywords = JSON.parse(text.slice(start, end + 1));

    const linksHtml = keywords.map(k => {
      const url = 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(k.query);
      return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #222;">
          <span style="color:#666;font-size:11px;font-family:monospace;text-transform:uppercase;letter-spacing:.08em;">${k.focus}</span><br>
          <a href="${url}" style="color:#f0f0ee;font-family:monospace;font-size:14px;text-decoration:none;">${k.query} →</a>
        </td>
      </tr>`;
    }).join('');

    const briefRows = [
      ['Brand', name],
      ['What it does', desc],
      ['Personality', feels.join(', ')],
      ['Logo format', formatsDesc.join(', ') || '—'],
      avoid ? ['Avoid', avoid] : null,
      brandRef ? ['Brand reference', brandRef] : null,
    ].filter(Boolean).map(([label, value]) => `
      <tr>
        <td style="padding:4px 12px 4px 0;color:#666;font-size:12px;font-family:monospace;white-space:nowrap;vertical-align:top;">${label}</td>
        <td style="padding:4px 0;color:#999;font-size:12px;font-family:monospace;">${value}</td>
      </tr>`).join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#111;color:#f0f0ee;font-family:monospace;padding:40px 24px;max-width:560px;margin:0 auto;">
  <p style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#555;margin:0 0 32px;">Logo &amp; brand moodboard</p>
  <h1 style="font-size:24px;font-weight:300;margin:0 0 8px;">${name}</h1>
  <p style="font-size:13px;color:#666;margin:0 0 32px;">${desc}</p>

  <table style="border-collapse:collapse;margin-bottom:32px;width:100%;">
    ${briefRows}
  </table>

  <p style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin:0 0 12px;">Pinterest search queries</p>
  <table style="border-collapse:collapse;width:100%;">
    ${linksHtml}
  </table>

  <p style="font-size:11px;color:#333;margin:40px 0 0;">Submitted via Logo Moodboard tool</p>
</body>
</html>`;

    await resend.emails.send({
      from: 'Logo Moodboard <onboarding@resend.dev>',
      to: 'federico.sarria@gmail.com',
      subject: 'Logo brief — ' + name,
      html,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
