const express = require('express');
const axios   = require('axios');
const https   = require('https');
const cheerio = require('cheerio');
const qs      = require('qs');

const app  = express();
app.use(express.json());

const BASE  = 'https://tuyensinh10.cantho.gov.vn';
const agent = new https.Agent({ rejectUnauthorized: false, family: 4 });
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let S = { cookie: '', ncforminfo: '' };

async function refreshSession() {
  const r = await axios.get(`${BASE}/ket-qua`, {
    httpsAgent: agent,
    headers: {
      'User-Agent':      UA,
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'vi-VN,vi;q=0.9',
      'Cookie':          S.cookie,
    },
    validateStatus: s => s < 400,
  });

  const raw = r.headers['set-cookie'] || [];
  if (raw.length) S.cookie = raw.map(c => c.split(';')[0]).join('; ');

  const $ = cheerio.load(r.data);
  S.ncforminfo = $('input[name="__ncforminfo"]').val() || '';

  console.log('cookie     :', S.cookie.slice(0, 40));
  console.log('ncforminfo :', S.ncforminfo.slice(0, 30) + '...');
}

async function fetchCaptcha() {
  const r = await axios.get(`${BASE}/captcha/image`, {
    httpsAgent: agent,
    headers: {
      'User-Agent': UA,
      'Referer':    `${BASE}/ket-qua`,
      'Cookie':     S.cookie,
      'Accept':     '*/*',
    },
  });
  return {
    svg:          r.data.image || '',
    captchaToken: r.data.token || '',
  };
}

// ── GET /init-session
app.get('/init-session', async (req, res) => {
  try {
    await refreshSession();
    res.json({ ok: true, cookie: S.cookie, ncforminfo: S.ncforminfo });
  } catch(e) {
    console.error('init-session lỗi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /captcha-img
app.get('/captcha-img', async (req, res) => {
  try {
    if (req.query.refresh === '1') await refreshSession();

    const { svg, captchaToken } = await fetchCaptcha();
    console.log('captchaToken:', captchaToken.slice(0, 30) + '...');

    const b64 = Buffer.from(svg).toString('base64');
    res.json({
      image:        `data:image/svg+xml;base64,${b64}`,
      svg,
      captchaToken,
      ncforminfo:   S.ncforminfo,
      cookie:       S.cookie,
    });
  } catch(e) {
    console.error('captcha-img lỗi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /tracuu
app.post('/tracuu', async (req, res) => {
  const { sbd, captchaText, captchaToken, ncforminfo, cookie } = req.body;
  try {
    const body = qs.stringify({
      cccd:         String(sbd),
      captchaText:  captchaText  || '',
      captchaToken: captchaToken || '',
      __ncforminfo: ncforminfo   || S.ncforminfo,
    });

    console.log(`→ SBD=${sbd} captcha="${captchaText}" token="${(captchaToken||'').slice(0,20)}..."`);

    const r = await axios.post(`${BASE}/ket-qua`, body, {
      httpsAgent:   agent,
      maxRedirects: 10,
      headers: {
        'Content-Type':    'application/x-www-form-urlencoded',
        'Cookie':          cookie || S.cookie,
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'vi-VN,vi;q=0.9',
        'Origin':          BASE,
        'Referer':         `${BASE}/ket-qua`,
      },
      validateStatus: s => s < 500,
    });

    const finalUrl = r.request?.res?.responseUrl || '';
    console.log(`← ${finalUrl}`);

    if (finalUrl.includes('error=captcha')) {
      return res.json({ success: false, error: 'captcha_wrong', sbd });
    }

    if (!finalUrl.includes('chi-tiet')) {
      const html = r.data || '';
      if (
        html.includes('không tìm thấy') ||
        html.includes('Không tìm thấy') ||
        html.includes('error=not_found')
      ) {
        return res.json({ success: false, error: 'not_found', sbd });
      }
      return res.json({ success: false, error: 'invalid_sbd', sbd });
    }

    res.json({ success: true, sbd, ...parseHtml(r.data) });
  } catch(e) {
    console.error('tracuu lỗi:', e.message);
    res.status(500).json({ error: e.message, sbd });
  }
});

// ── Parse HTML → JSON
function parseHtml(html) {
  const $ = cheerio.load(html);

  const ho_ten = $('.result-detail-student-name').text().trim();

  const meta = {};
  $('.result-detail-meta p').each((_, el) => {
    const [k, ...v] = $(el).text().split(':');
    if (k && v.length) meta[k.trim()] = v.join(':').trim();
  });

  const scores = {};
  $('.result-score-card').each((_, el) => {
    const label = $(el).find('.result-score-label').text().trim();
    const val   = $(el).find('.result-score-value').text().trim();
    if (label) scores[label] = parseFloat(val.replace(',', '.').replace(/\.$/, '')) || null;
  });

  const wishes = [];
  $('.result-table tbody tr').each((_, row) => {
    const c = $(row).find('td');
    if (c.length >= 6) wishes.push({
      nguyen_vong:    $(c[0]).text().trim(),
      truong:         $(c[1]).text().trim(),
      hinh_thuc:      $(c[2]).text().trim(),
      diem_xet_tuyen: $(c[3]).text().trim().replace(',', '.').replace(/\.$/, ''),
      diem_chuan:     $(c[4]).text().trim().replace(',', '.').replace(/\.$/, ''),
      ket_qua:        $(c[5]).text().trim(),
    });
  });

  const tong_diem =
    wishes.find(w => w.diem_xet_tuyen && w.diem_xet_tuyen !== '—')?.diem_xet_tuyen
    || Object.values(scores).reduce((a, b) => a + (b || 0), 0).toFixed(2);

  return {
    ho_ten,
    cccd:        meta['CCCD/Định danh cá nhân'] || '',
    truong_thcs: meta['Trường THCS'] || '',
    trang_thai:  $('.result-badge').first().text().trim(),
    diem:        scores,
    tong_diem,
    nguyen_vong: wishes,
  };
}

app.listen(3000, () => console.log('✅ Proxy chạy tại :3000'));
