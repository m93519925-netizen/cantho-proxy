const express = require('express');
const axios   = require('axios');
const https   = require('https');
const cheerio = require('cheerio');
const qs      = require('qs');

const app = express();
app.use(express.json());

const BASE = 'https://tuyensinh10.cantho.gov.vn';
const agent = new https.Agent({ rejectUnauthorized: false });

// Mỗi "session" cần: srv_id cookie + captchaToken + ncforminfo riêng
// Ta dùng 1 session cho toàn bộ, refresh khi cần

let globalSession = { cookie: '', captchaToken: '', ncforminfo: '' };

// ── GET /init-session : lấy form fields + captcha image
app.get('/init-session', async (req, res) => {
  try {
    const r = await axios.get(`${BASE}/ket-qua`, {
      httpsAgent: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      validateStatus: s => s < 400,
    });

    // Lưu cookie
    const raw = r.headers['set-cookie'] || [];
    globalSession.cookie = raw.map(c => c.split(';')[0]).join('; ');

    // Parse form
    const $ = cheerio.load(r.data);
    globalSession.captchaToken = $('input[name="captchaToken"]').val() || '';
    globalSession.ncforminfo   = $('input[name="__ncforminfo"]').val() || '';

    res.json({ ok: true, session: globalSession });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /captcha-img : lấy ảnh captcha mới (base64)
// Gọi /init-session trước để có cookie, rồi mới gọi cái này
app.get('/captcha-img', async (req, res) => {
  try {
    // Refresh form để lấy captchaToken mới nếu cần
    if (req.query.refresh === '1') {
      const r = await axios.get(`${BASE}/ket-qua`, {
        httpsAgent: agent,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Cookie': globalSession.cookie,
        },
        validateStatus: s => s < 400,
      });
      const $ = cheerio.load(r.data);
      globalSession.captchaToken = $('input[name="captchaToken"]').val() || '';
      globalSession.ncforminfo   = $('input[name="__ncforminfo"]').val() || '';
    }

    // Lấy ảnh captcha
    const imgRes = await axios.get(`${BASE}/captcha/image`, {
      httpsAgent: agent,
      responseType: 'arraybuffer',
      headers: {
        'Cookie':   globalSession.cookie,
        'Referer':  `${BASE}/ket-qua`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const b64  = Buffer.from(imgRes.data).toString('base64');
    const mime = imgRes.headers['content-type'] || 'image/png';

    res.json({
      image: `data:${mime};base64,${b64}`,
      captchaToken: globalSession.captchaToken,
      ncforminfo:   globalSession.ncforminfo,
      cookie:       globalSession.cookie,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /tracuu : submit form, parse kết quả
app.post('/tracuu', async (req, res) => {
  const { sbd, captchaText, captchaToken, ncforminfo, cookie } = req.body;

  try {
    const body = qs.stringify({
      cccd:         String(sbd),
      captchaText:  captchaText || '',
      captchaToken: captchaToken || globalSession.captchaToken,
      __ncforminfo: ncforminfo  || globalSession.ncforminfo,
    });

    const r = await axios.post(`${BASE}/ket-qua`, body, {
      httpsAgent: agent,
      maxRedirects: 10,
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Cookie':         cookie || globalSession.cookie,
        'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':         'text/html,application/xhtml+xml',
        'Accept-Language':'vi-VN,vi;q=0.9',
        'Origin':         BASE,
        'Referer':        `${BASE}/ket-qua`,
      },
      validateStatus: s => s < 500,
    });

    const finalUrl = r.request?.res?.responseUrl || '';

    if (finalUrl.includes('error=captcha')) {
      return res.json({ success: false, error: 'captcha_wrong', sbd });
    }
    if (finalUrl.includes('error=')) {
      return res.json({ success: false, error: 'not_found', sbd });
    }

    // Parse HTML → JSON
    res.json({ success: true, sbd, ...parseHtml(r.data) });

  } catch(e) {
    res.status(500).json({ error: e.message, sbd });
  }
});

function parseHtml(html) {
  const $ = cheerio.load(html);
  const name = $('.result-detail-student-name').text().trim();

  const meta = {};
  $('.result-detail-meta p').each((_, el) => {
    const [k, ...v] = $(el).text().split(':');
    if (k && v.length) meta[k.trim()] = v.join(':').trim();
  });

  const scores = {};
  $('.result-score-card').each((_, el) => {
    const label = $(el).find('.result-score-label').text().trim();
    const val   = $(el).find('.result-score-value').text().trim();
    if (label) scores[label] = parseFloat(val.replace(',','.').replace(/\.$/,'')) || null;
  });

  const tong = Object.values(scores).reduce((a,b) => a+(b||0), 0);

  const wishes = [];
  $('.result-table tbody tr').each((_, row) => {
    const c = $(row).find('td');
    if (c.length >= 6) wishes.push({
      nguyen_vong:    $(c[0]).text().trim(),
      truong:         $(c[1]).text().trim(),
      hinh_thuc:      $(c[2]).text().trim(),
      diem_xet_tuyen: $(c[3]).text().trim().replace(',','.').replace(/\.$/,''),
      diem_chuan:     $(c[4]).text().trim().replace(',','.').replace(/\.$/,''),
      ket_qua:        $(c[5]).text().trim(),
    });
  });

  return {
    ho_ten:      name,
    cccd:        meta['CCCD/Định danh cá nhân'] || '',
    truong_thcs: meta['Trường THCS'] || '',
    trang_thai:  $('.result-badge').first().text().trim(),
    diem:        scores,
    tong_diem:   Math.round(tong * 100) / 100,
    nguyen_vong: wishes,
  };
}

app.listen(3000, () => console.log('✅ Proxy sẵn sàng tại :3000'));
