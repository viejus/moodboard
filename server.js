require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');
const multer = require('multer');

const app = express();
const client = new Anthropic();
const resend = new Resend(process.env.RESEND_API_KEY);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

app.use(express.static('public'));

app.post('/api/submit', upload.array('images', 5), async (req, res) => {
  const {
    name, desc, avoid, brandRef, notes, clientEmail, color
  } = req.body;

  const feels      = JSON.parse(req.body.feels      || '[]');
  const logotypes  = JSON.parse(req.body.logotypes  || '[]');
  const isotypes   = JSON.parse(req.body.isotypes   || '[]');
  const typeStyles = JSON.parse(req.body.typeStyles  || '[]');
  const isNone     = req.body.isNone === 'true';
  const images = req.files || [];

  const formatsDesc = [];
  if (logotypes.length > 0) formatsDesc.push('Logotype: ' + logotypes.join(', '));
  if (isNone) formatsDesc.push('No isotype — logotype only');
  else if (isotypes.length > 0) formatsDesc.push('Isotype: ' + isotypes.join(', '));

  const hasImages = images.length > 0;

  const prompt = [
    'Brand: ' + name,
    'What it does: ' + desc,
    'Personality: ' + feels.join(', '),
    formatsDesc.join('\n'),
    avoid ? 'Avoid: ' + avoid : '',
    brandRef ? 'Brand reference: ' + brandRef + ' — extract visual DNA from this brand (materials, type style, era, construction) and let it inform the queries without naming the brand directly' : '',
    typeStyles.length > 0 ? 'Logotype type style: ' + typeStyles.join(', ') + ' — prioritise queries that reference this typographic style' : '',
    notes ? 'Additional context: ' + notes : '',
    color ? 'Brand color: ' + color + ' — this is an accent colour the client identified; inform palette direction without forcing it' : '',
    hasImages ? 'Visual references: ' + images.length + ' image(s) provided above — extract aesthetic qualities, materials, colour palette, and construction style to inform queries' : '',
    '',
    'Respond with ONLY a raw JSON array — no markdown, no explanation. Generate ' + (hasImages ? '10' : '8') + ' Pinterest-style search keywords, 2-5 words each.',
    '[{"focus":"...","query":"..."},...]',
    '',
    'Rules:',
    '- Concrete visual terms: materials, eras, techniques, type styles',
    '- Good examples: "organic wax seal emblem", "swiss grid wordmark black", "brutalist lettermark bold", "90s geometric symbol", "engraved copper badge"',
    '- Shape queries around: ' + formatsDesc.join(', '),
    '- Personality (' + feels.join(', ') + ') informs tone without being stated literally',
    avoid ? '- Avoid references to: ' + avoid : '',
    hasImages ? '- Include at least 3 queries inspired directly by the visual references provided' : '',
  ].filter(Boolean).join('\n');

  try {
    // Build message content — prepend images if provided
    const content = [];
    for (const img of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimetype,
          data: img.buffer.toString('base64'),
        }
      });
    }
    content.push({ type: 'text', text: prompt });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content }],
    });

    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'No JSON array in response', raw: text });
    }

    const keywords = JSON.parse(text.slice(start, end + 1));

    // ── Brief rows ────────────────────────────────────────────────────────────
    const rows = [
      ['Brand',        name],
      ['What it does', desc],
      ['Client email', clientEmail],
      ['Personality',  feels.join(', ')],
      ['Logo format',  formatsDesc.join(', ') || '—'],
      typeStyles.length > 0 ? ['Type style',      typeStyles.join(', ')] : null,
      color                 ? ['Brand color',      color]                  : null,
      avoid                 ? ['Avoid',            avoid]                  : null,
      brandRef              ? ['Brand reference',  brandRef]               : null,
      notes                 ? ['Notes',            notes]                  : null,
    ].filter(Boolean);

    const briefRowsHtml = rows.map(([label, value]) => `
      <tr>
        <td style="padding:5px 16px 5px 0;color:#555;font-size:11px;font-family:monospace;white-space:nowrap;vertical-align:top;text-transform:uppercase;letter-spacing:.06em;">${label}</td>
        <td style="padding:5px 0;color:#999;font-size:12px;font-family:monospace;line-height:1.5;">${value}</td>
      </tr>`).join('');

    // ── Search queries ────────────────────────────────────────────────────────
    const queriesHtml = keywords.map(k => {
      const url = 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(k.query);
      return `<tr>
        <td style="padding:7px 0;border-bottom:1px solid #1e1e1e;">
          <span style="color:#444;font-size:10px;font-family:monospace;text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:2px;">${k.focus}</span>
          <a href="${url}" style="color:#c8c8c6;font-family:monospace;font-size:13px;text-decoration:none;">${k.query} →</a>
        </td>
      </tr>`;
    }).join('');

    // ── Image attachments (inline via cid) ────────────────────────────────────
    const attachments = images.map((img, i) => {
      const ext = img.mimetype.split('/')[1] || 'jpg';
      return {
        filename: `reference-${i + 1}.${ext}`,
        content: img.buffer,
        cid: `ref-image-${i}`,
      };
    });

    const imagesHtml = hasImages ? `
      <p style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#333;margin:32px 0 10px;">Visual references</p>
      <table style="border-collapse:collapse;width:100%;">
        <tr>
          ${images.map((_, i) => `<td style="padding:0 6px 0 0;vertical-align:top;width:96px;">
            <img src="cid:ref-image-${i}" style="width:90px;height:90px;object-fit:cover;border-radius:4px;display:block;border:1px solid #1e1e1e;" alt="Reference ${i + 1}">
          </td>`).join('')}
        </tr>
      </table>` : '';

    // ── Full HTML email ───────────────────────────────────────────────────────
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#111;color:#c8c8c6;font-family:monospace;padding:40px 24px;max-width:560px;margin:0 auto;">

  <p style="font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:#333;margin:0 0 28px;">Logo &amp; brand moodboard</p>

  <h1 style="font-size:22px;font-weight:400;margin:0 0 4px;color:#f0f0ee;">${name}</h1>
  <p style="font-size:13px;color:#555;margin:0 0 28px;">${desc}</p>

  <p style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#333;margin:0 0 10px;">Brief</p>
  <table style="border-collapse:collapse;width:100%;margin-bottom:32px;">
    ${briefRowsHtml}
  </table>

  ${imagesHtml}

  <p style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#333;margin:32px 0 10px;">Pinterest queries</p>
  <table style="border-collapse:collapse;width:100%;">
    ${queriesHtml}
  </table>

  <p style="font-size:10px;color:#222;margin:40px 0 0;">Submitted via Logo Moodboard</p>
</body>
</html>`;

    await resend.emails.send({
      from: 'Logo Moodboard <onboarding@resend.dev>',
      to: 'federico.sarria@gmail.com',
      subject: 'Logo brief — ' + name,
      html,
      attachments,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
