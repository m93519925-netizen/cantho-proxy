const express = require('express');
const axios   = require('axios');
const https   = require('https');
const cheerio = require('cheerio');
const qs      = require('qs');

const app  = express();
app.use(express.json());

const BASE    = 'https://tuyensinh10.cantho.gov.vn';
const agent   = new https.Agent({ rejectUnauthorized: false, family: 4 });
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
};

let S = { cookie: '', captchaToken: '', ncforminfo: '' };

async function refreshSession() {
  const r = await axios.get(`${BASE}/ket-qua`, {
    httpsAgent: agent,
    headers: { ...HEADERS, Cookie: S.cookie },
    validateStatus: s => s < 400,
  });

  const raw = r.headers['set-cookie'] || [];
  if (raw.length) S.cookie = raw.map(c => c.split(';')[0]).join('; ');

  const $ = cheerio.load(r.data);

  // Log tất cả input để tìm đúng tên field
  console.log('\n=== FORM INPUTS ===');
  $('input').each((_, el) => {
    const name = $(el).attr('name') || '(no name)';
    const type = $(el).attr('type') || 'text';
    const val  = ($(el).val() || '').slice(0, 60);
    console.log(`  [${type}] name="${name}" val="${val}"`);
  });
  console.log('===================');

  // Thử tất cả tên field có thể có
  S.captchaToken = $('input[name="captchaToken"]').val()
                || $('input[name="captcha_token"]').val()
                || $('input[name="token"]').val()
                || $('input[name="captchatoken"]').val()
                || '';

  S.ncforminfo   = $('input[name="__ncforminfo"]').val()
                || $('input[name="_token"]').val()
                || $('input[name="csrf_token"]').val()
                || $('input[name="csrf"]').val()
                || '';

  console.log('cookie      :', S.cookie.slice(0, 40));
  console.log('captchaToken:', S.captchaToken ? S.captchaToken.slice(0, 30) + '...' : '⚠ TRỐNG');
  console.log('ncforminfo  :', S.ncforminfo   ? S.ncforminfo.slice(0, 30)   + '...' : '⚠ TRỐNG');

  return $;
}

// ── GET /init-session
app.get('/init-session', async (req, res) => {
  try {
    await refreshSession();
    res.json({ ok: true, session: S });
  } catch(e) {
    console.error('init-session lỗi:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /raw-html
app.get('/raw-html', async (req, res) => {
  try {
    const r = await axios.get(`${BASE}/ket-qua`, {
      httpsAgent: agent,
      headers: { ...HEADERS, Cookie: S.cookie },
      validateStatus: s => s < 400,
    });
    res.send(r.data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /captcha-img
app.get('/captcha-img', async (req, res) => {
  try {
    if (req.query.refresh === '1') await refreshSession();

    const imgRes = await axios.get(`${BASE}/captcha/image`, {
      httpsAgent: agent,
      headers: {
        ...HEADERS,
        Cookie:  S.cookie,
        Referer: `${BASE}/ket-qua`,
        Accept:  '*/*',
      },
    });

    console.log('captcha type:', imgRes.headers['content-type']);

    let svgStr = '';
    if (typeof imgRes.data === 'object' && imgRes.data.image) {
      svgStr = imgRes.data.image;
    } else if (typeof imgRes.data === 'string') {
      try { svgStr = JSON.parse(imgRes.data).image || imgRes.data; }
      catch { svgStr = imgRes.data; }
    }

    const b64 = Buffer.from(svgStr).toString('base64');
    res.json({
      image:        `data:image/svg+xml;base64,${b64}`,
      svg:          svgStr,
      captchaToken: S.captchaToken,
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
      captchaToken: captchaToken || S.captchaToken,
      __ncforminfo: ncforminfo   || S.ncforminfo,
    });

    console.log(`→ SBD=${sbd} captcha="${captchaText}" token="${(captchaToken||S.captchaToken).slice(0,20)}..."`);

    const r = await axios.post(`${BASE}/ket-qua`, body, {
      httpsAgent:   agent,
      maxRedirects: 10,
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie:         cookie || S.cookie,
        Origin:         BASE,
        Referer:        `${BASE}/ket-qua`,
      },
      validateStatus: s => s < 500,
    });

    const finalUrl = r.request?.res?.responseUrl || '';
    console.log(`← ${finalUrl}`);

    if (finalUrl.includes('error=captcha')) {
      return res.json({ success: false, error: 'captcha_wrong', sbd });
    }
    if (finalUrl.includes('error=')) {
      return res.json({ success: false, error: 'not_found', sbd });
    }
    if (!finalUrl.includes('chi-tiet')) {
      return res.json({ success: false, error: 'unknown_redirect', url: finalUrl, sbd });
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

  const tong = Object.values(scores).reduce((a, b) => a + (b || 0), 0);

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

  return {
    ho_ten,
    cccd:        meta['CCCD/Định danh cá nhân'] || '',
    truong_thcs: meta['Trường THCS'] || '',
    trang_thai:  $('.result-badge').first().text().trim(),
    diem:        scores,
    tong_diem:   Math.round(tong * 100) / 100,
    nguyen_vong: wishes,
  };
}

app.listen(3000, () => console.log('✅ Proxy chạy tại :3000'));
