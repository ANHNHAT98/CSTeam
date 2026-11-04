/* Beer Loader — tiến trình vui cho lúc chờ lấy/xử lý dữ liệu, đổi chủ đề theo dự án:
     - Mặc định, ABI, SABECO : rót bia → cụng ly "DZÔ!"            🍺
     - MERAP, ANVY (dược)     : rót siro, bốc thuốc → "khỏe re"      💊
     - JOTUN (sơn)            : đổ sơn, pha màu → "bóng loáng"        🎨
     - FES, ANKO, HẢI HÀ      : đổ kẹo đầy hũ → "ngọt ngào"           🍬
   Dự án nhận theo đường dẫn (/merap/…, /anvy/…) hoặc tham số ?project=… trên URL.
   - Tự bắt mọi lời gọi fetch() trên trang: request nào chờ quá 0.4s thì hiện, xong thì ăn mừng, lỗi thì báo "đổ".
   - Không chặn thao tác (không phủ màn hình), nằm ở cạnh dưới trang.
   - Bỏ qua 1 request:      fetch(url, { beer: false })
   - Dùng cho xử lý nặng ở trình duyệt (gom build, đọc Excel…):
        const done = BeerLoader.start('Đang gom build');  ...  done();      // hoặc done(true) nếu lỗi
        await BeerLoader.run(() => xuLyNang(), 'Đang gom build');
   - Tắt hẳn trên máy mình: localStorage.setItem('beerLoader','off')  (bật lại: removeItem)
   - Ép 1 chủ đề trên máy mình: localStorage.setItem('beerTheme','pharma')  // beer | pharma | paint | candy */
(function () {
  'use strict';
  if (window.BeerLoader || typeof window.fetch !== 'function') return;

  var off = false;
  try { off = localStorage.getItem('beerLoader') === 'off'; } catch (e) { /* không có storage thì vẫn chạy */ }

  var SHOW_DELAY = 400;   // request nhanh hơn mức này thì không hiện gì cho đỡ nháy
  var CHEERS_MS = 1200;   // thời gian hiện màn ăn mừng
  var ERROR_MS = 2000;

  /* ---------- Bình chứa (SVG) cho từng chủ đề ----------
     Quy ước chung: phần chứa nằm trong khoảng y 6→62 (đáy = 62). Các phần tử có data-r:
     clip (mực đầy), foam (mặt trên), stream (dòng đang đổ) được cập nhật theo mức đầy. */
  var BUBBLES = function (xs) {
    return xs.map(function (x, i) {
      return '<circle class="bl-bub" cx="' + x + '" cy="' + (58 + (i % 3)) + '" r="' + (1 + (i % 3) * 0.25) +
        '" fill="#fff" fill-opacity=".7" style="animation-delay:' + (i * 0.33).toFixed(2) + 's"/>';
    }).join('');
  };

  var MUG = '' +
    '<svg class="bl-mug" viewBox="0 -4 64 70" aria-hidden="true">' +
    '<defs>' +
    '<clipPath id="blClip"><rect data-r="clip" x="0" y="62" width="64" height="0"/></clipPath>' +
    '<linearGradient id="blLiq" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffcf4a"/><stop offset="1" stop-color="#e58e00"/></linearGradient>' +
    '</defs>' +
    '<line data-r="stream" class="bl-stream" x1="30" y1="-4" x2="30" y2="62" stroke="#ffcf4a" stroke-width="3" stroke-linecap="round"/>' +
    '<g clip-path="url(#blClip)"><rect x="9" y="6" width="34" height="57" fill="url(#blLiq)"/>' + BUBBLES([15, 22, 34, 39, 27]) + '</g>' +
    '<g data-r="foam" transform="translate(0,62)" opacity="0" fill="#fffaf0">' +
    '<rect x="9" y="-1" width="34" height="4"/>' +
    '<circle cx="12" cy="-1" r="4"/><circle cx="18" cy="-3" r="5"/><circle cx="25" cy="-2" r="4.5"/>' +
    '<circle cx="31" cy="-3.5" r="5"/><circle cx="37" cy="-1.5" r="4.5"/><circle cx="41" cy="-1" r="3.5"/>' +
    '</g>' +
    '<rect x="7" y="4" width="38" height="60" rx="5" fill="rgba(255,255,255,.08)" stroke="#fff6e0" stroke-width="2.5"/>' +
    '<path d="M45 18h7a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6h-7" fill="none" stroke="#fff6e0" stroke-width="3"/>' +
    '<line x1="13" y1="12" x2="13" y2="54" stroke="rgba(255,255,255,.3)" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  // Chai siro thuốc: cổ chai hẹp, thân bầu, nhãn trắng có chữ thập xanh
  var BOTTLE_D = 'M22 8h8v10q0 4 6 7q6 3 6 9v24q0 4-4 4h-24q-4 0-4-4v-24q0-6 6-9q6-3 6-7z';
  var BOTTLE = '' +
    '<svg class="bl-mug" viewBox="0 -4 64 70" aria-hidden="true">' +
    '<defs>' +
    '<clipPath id="blClip"><rect data-r="clip" x="0" y="62" width="64" height="0"/></clipPath>' +
    '<clipPath id="blShape"><path d="' + BOTTLE_D + '"/></clipPath>' +
    '<linearGradient id="blLiq" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff9cc2"/><stop offset="1" stop-color="#e0457b"/></linearGradient>' +
    '</defs>' +
    '<line data-r="stream" class="bl-stream" x1="26" y1="-4" x2="26" y2="62" stroke="#ff9cc2" stroke-width="2.5" stroke-linecap="round"/>' +
    '<g clip-path="url(#blShape)">' +
    '<g clip-path="url(#blClip)"><rect x="0" y="0" width="64" height="64" fill="url(#blLiq)"/>' + BUBBLES([16, 21, 33, 37, 27]) + '</g>' +
    '<g data-r="foam" transform="translate(0,62)" opacity="0"><rect x="0" y="-1.2" width="64" height="2.4" fill="#ffd6e6"/></g>' +
    '</g>' +
    '<path d="' + BOTTLE_D + '" fill="rgba(255,255,255,.08)" stroke="#e8fff8" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<rect x="20" y="4" width="12" height="4" rx="1.5" fill="none" stroke="#e8fff8" stroke-width="2"/>' +
    '<rect x="14" y="36" width="24" height="16" rx="2" fill="#fff" fill-opacity=".93"/>' +
    '<path d="M24 39h4v3h3v4h-3v3h-4v-3h-3v-4h3z" fill="#19a974"/>' +
    '</svg>';

  // Thùng sơn: màu sơn đổi liên tục như đang pha màu, có dải mẫu màu trên thân thùng
  var CAN = '' +
    '<svg class="bl-mug" viewBox="0 -4 64 70" aria-hidden="true">' +
    '<defs>' +
    '<clipPath id="blClip"><rect data-r="clip" x="0" y="62" width="64" height="0"/></clipPath>' +
    '<clipPath id="blShape"><rect x="9" y="16" width="34" height="47" rx="2"/></clipPath>' +
    '<linearGradient id="blLiq" x1="0" x2="0" y1="0" y2="1"><stop data-r="g1" offset="0" stop-color="#ff6b6b"/><stop data-r="g2" offset="1" stop-color="#d64545"/></linearGradient>' +
    '</defs>' +
    '<path d="M8 14C8 -1 44 -1 44 14" fill="none" stroke="#eef3ff" stroke-width="1.6"/>' +
    '<line data-r="stream" class="bl-stream" x1="30" y1="-4" x2="30" y2="62" stroke="#ff6b6b" stroke-width="5" stroke-linecap="round"/>' +
    '<g clip-path="url(#blShape)">' +
    '<g clip-path="url(#blClip)"><rect x="0" y="0" width="64" height="64" fill="url(#blLiq)"/></g>' +
    '<g data-r="foam" transform="translate(0,62)" opacity="0"><ellipse data-r="surf" cx="26" cy="0" rx="18" ry="2.6" fill="#ff9a9a"/></g>' +
    '</g>' +
    '<rect x="7" y="14" width="38" height="50" rx="3" fill="rgba(255,255,255,.08)" stroke="#eef3ff" stroke-width="2.5"/>' +
    '<rect x="5" y="11" width="42" height="4" rx="2" fill="#1b2233" stroke="#eef3ff" stroke-width="2"/>' +
    '<rect x="7" y="38" width="38" height="12" fill="#eef3ff" fill-opacity=".92"/>' +
    '<rect x="11" y="41" width="6" height="6" rx="1" fill="#ff5f6d"/><rect x="19" y="41" width="6" height="6" rx="1" fill="#ffc371"/>' +
    '<rect x="27" y="41" width="6" height="6" rx="1" fill="#47e5bc"/><rect x="35" y="41" width="6" height="6" rx="1" fill="#4d8bff"/>' +
    '</svg>';

  // Hũ kẹo: kẹo đủ màu rơi lộp độp vào hũ, nắp hũ mở nghiêng
  var CANDY_COLORS = ['#ff6fb5', '#ffd36e', '#7ee0ff', '#a98bff', '#7af0a0', '#ff8a5c'];
  var CANDIES = (function () {
    var s = '', row = 0;
    for (var y = 60; y > 12; y -= 5.2, row++) {
      for (var x = 12 + (row % 2 ? 3 : 0), i = 0; x < 43; x += 6, i++) {
        s += '<circle cx="' + x + '" cy="' + y.toFixed(1) + '" r="2.8" fill="' + CANDY_COLORS[(i * 7 + row * 3) % CANDY_COLORS.length] + '"/>';
      }
    }
    return s;
  })();
  var JAR = '' +
    '<svg class="bl-mug" viewBox="0 -4 64 70" aria-hidden="true">' +
    '<defs>' +
    '<clipPath id="blClip"><rect data-r="clip" x="0" y="62" width="64" height="0"/></clipPath>' +
    '<clipPath id="blShape"><rect x="9" y="14" width="34" height="49" rx="6"/></clipPath>' +
    '</defs>' +
    '<g transform="rotate(-28 8 8)"><rect x="-2" y="3" width="30" height="6" rx="2.5" fill="#ff6fb5" stroke="#fff0f8" stroke-width="1.5"/></g>' +
    '<line data-r="stream" class="bl-stream bl-fall" x1="30" y1="-4" x2="30" y2="62" stroke="#ffd36e" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="0.1 6.9"/>' +
    '<g clip-path="url(#blShape)"><g clip-path="url(#blClip)">' + CANDIES + '</g></g>' +
    '<g data-r="foam"></g>' +
    '<rect x="7" y="12" width="38" height="52" rx="8" fill="rgba(255,255,255,.1)" stroke="#fff0f8" stroke-width="2.5"/>' +
    '<rect x="11" y="8" width="30" height="5" rx="2" fill="none" stroke="#fff0f8" stroke-width="2"/>' +
    '<line x1="13" y1="20" x2="13" y2="54" stroke="rgba(255,255,255,.35)" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var THEMES = {
    beer: {
      vessel: MUG, unit: 'ly', many: 'ly đang rót',
      bg: '#2b1d0e', bd: 'rgba(255,209,102,.35)', title: '#ffd166', text: '#fff6e0', bar: 'linear-gradient(90deg,#e58e00,#ffd166)',
      msgs: ['Đang khui bia… 🍾', 'Đang rót bia, chờ bọt lắng nha…', 'Nghiêng ly rót cho đỡ trào bọt…', 'ERP đang nhậu dở, đợi xíu…',
        'Gắp miếng khô mực trong lúc chờ 🦑', 'Sắp đầy ly rồi, chuẩn bị cụng!', 'Một… hai… ba…'],
      long1: 'Ly này hơi lâu, khui thêm chai nữa 🍺', long2: 'Server xỉn rồi, ráng chờ chút 🥴',
      done: ['DZÔ! Trăm phần trăm! 🍻', 'Một, hai, ba — DZÔ! 🍻', 'Cạn ly! Dữ liệu về rồi 🍻', 'Không say không về! 🍻'],
      doneHtml: '<div class="bl-clink"><span class="l">🍺</span><span class="r">🍺</span><span class="s">✨</span></div>',
      err: 'Đổ bia rồi! 😵',
    },
    pharma: {
      vessel: BOTTLE, unit: 'chai', many: 'toa đang bốc',
      bg: '#0e2f2a', bd: 'rgba(126,240,200,.35)', title: '#7ef0c8', text: '#e8fff8', bar: 'linear-gradient(90deg,#1fa37a,#7ef0c8)',
      msgs: ['Đang bốc thuốc… 💊', 'Dược sĩ đang soạn đơn…', 'Đang sắc thuốc, lửa nhỏ nha…', 'Lắc đều trước khi dùng…',
        'Đang đếm viên: 1… 2… 3…', 'Uống sau ăn, chờ xíu nha…', 'Sắp xong toa rồi!'],
      long1: 'Thuốc đắng dã tật, ráng chờ chút 🌿', long2: 'Server cảm nhẹ, đang hạ sốt 🤒',
      done: ['Uống thuốc xong — khỏe re! 💪', 'Ngày 3 lần, mỗi lần 1 viên — xong! ✅', 'Hết bệnh! Dữ liệu về rồi ✅', 'Khỏe như trâu! 💪'],
      doneHtml: '<div class="bl-clink"><span class="p">💊</span><span class="s2">✅</span></div>',
      err: 'Hết thuốc rồi! 🤧',
    },
    paint: {
      vessel: CAN, unit: 'thùng', many: 'thùng đang pha', hue: true,
      bg: '#1b2233', bd: 'rgba(140,170,255,.35)', title: '#ffd08a', text: '#eef3ff', bar: 'linear-gradient(90deg,#ff5f6d,#ffc371,#47e5bc,#4d8bff)',
      msgs: ['Đang khui thùng sơn… 🎨', 'Đang pha màu cho chuẩn…', 'Khuấy đều tay nha…', 'Đang dán băng keo mép tường…',
        'Đang lăn lớp lót…', 'Chờ lớp 1 khô rồi sơn lớp 2…', 'Sắp bóng loáng rồi!'],
      long1: 'Sơn hơi lâu khô, chờ thêm chút 🖌️', long2: 'Server đang phơi sơn, ráng chờ 🥵',
      done: ['Sơn xong, bóng loáng! ✨', 'Đẹp như mới! ✨', 'Một lớp là chuẩn màu! 🎨', 'Xong — đẹp như tranh! 🖼️'],
      doneHtml: '<div class="bl-clink"><i class="stk"></i><span class="b">🖌️</span><span class="s2">✨</span></div>',
      err: 'Đổ sơn rồi! 😱',
    },
    candy: {
      vessel: JAR, unit: 'hũ', many: 'mẻ đang làm',
      bg: '#3a1431', bd: 'rgba(255,150,210,.4)', title: '#ffb3de', text: '#fff0f8', bar: 'linear-gradient(90deg,#ff6fb5,#ffd36e)',
      msgs: ['Đang mở hũ kẹo… 🍬', 'Đang nướng bánh, thơm lừng… 🍪', 'Rắc thêm đường cho ngọt…', 'Đang gói kẹo từng viên…',
        'Chờ bánh vàng đều nha…', 'Bốc 1 viên ăn trong lúc chờ 🍭', 'Sắp đầy hũ rồi!'],
      long1: 'Bánh hơi lâu chín, chờ thêm chút 🧁', long2: 'Lò nướng đang quá tải, ráng chờ 🥵',
      done: ['Ngọt ngào! Dữ liệu về rồi 🍬', 'Bánh ra lò, nóng hổi! 🎉', 'Đầy hũ kẹo rồi! 🍭', 'Ăn kẹo thôi! 🎉'],
      doneHtml: '<div class="bl-clink"><span class="l">🍬</span><span class="r">🍭</span><span class="s">🎉</span></div>',
      err: 'Rơi kẹo rồi! 😭',
    },
  };

  function pickTheme() {
    try {
      var forced = localStorage.getItem('beerTheme');
      if (forced && THEMES[forced]) return forced;
    } catch (e) { /* bỏ qua */ }
    var q = '';
    try { q = new URLSearchParams(location.search).get('project') || ''; } catch (e) { /* bỏ qua */ }
    var k = (location.pathname + ' ' + q).toLowerCase();
    if (/merap|anvy/.test(k)) return 'pharma';
    if (/jotun/.test(k)) return 'paint';
    if (/(^|[^a-z])(fes|anko|haiha)/.test(k)) return 'candy';
    return 'beer';
  }

  var pending = 0, hadError = false, label = '';
  var END_GRACE = 250;
  var showTimer = null, endTimer = null, graceTimer = null, raf = 0;
  var state = 'idle'; // idle | waiting | pouring | finishing
  var t0 = 0, level = 0, el = null, refs = {}, T = THEMES.beer;

  var CSS = '' +
    '.bl-wrap{position:fixed;left:50%;bottom:24px;transform:translate(-50%,24px);opacity:0;transition:opacity .25s,transform .25s;' +
    'z-index:2147483000;pointer-events:none;font:500 14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:calc(100vw - 32px)}' +
    '.bl-wrap.on{opacity:1;transform:translate(-50%,0)}' +
    '.bl-card{display:flex;align-items:center;gap:14px;background:var(--bl-bg);color:var(--bl-text);border:1px solid var(--bl-bd);' +
    'border-radius:16px;padding:10px 18px 10px 12px;box-shadow:0 12px 32px rgba(0,0,0,.35);width:400px;max-width:100%;box-sizing:border-box}' +
    '.bl-mug{width:64px;height:56px;flex:none;overflow:visible}' +
    '.bl-txt{flex:1;min-width:0}' +
    '.bl-msg{display:block;color:var(--bl-title);font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.bl-meta{font-size:12px;opacity:.75;margin-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.bl-bar{height:5px;background:rgba(255,255,255,.14);border-radius:5px;margin-top:6px;overflow:hidden}' +
    '.bl-bar i{display:block;height:100%;width:0;background:var(--bl-bar);border-radius:5px}' +
    '.bl-bub{animation:bl-up 1.6s ease-in infinite;transform-box:fill-box}' +
    '@keyframes bl-up{0%{transform:translateY(0);opacity:0}20%{opacity:.9}100%{transform:translateY(-40px);opacity:0}}' +
    '.bl-stream{transition:opacity .2s}' +
    '.bl-fall{animation:bl-fall .45s linear infinite}' +
    '@keyframes bl-fall{to{stroke-dashoffset:-14}}' +
    '.bl-clink{position:relative;width:64px;height:56px;flex:none;font-size:28px;line-height:56px}' +
    '.bl-clink span{position:absolute;top:0}' +
    '.bl-clink .l{left:0;animation:bl-cl .55s ease-in forwards}' +
    '.bl-clink .r{right:0;animation:bl-cr .55s ease-in forwards}' +
    '.bl-clink .s{left:50%;top:-14px;margin-left:-10px;font-size:20px;transform:scale(0);animation:bl-sp .5s .4s ease-out forwards}' +
    '.bl-clink .s2{right:0;top:-12px;font-size:18px;transform:scale(0);animation:bl-sp .45s .5s ease-out forwards}' +
    '.bl-clink .p{left:16px;animation:bl-pop .7s ease-out forwards}' +
    '.bl-clink .b{left:-4px;top:-8px;animation:bl-sw .7s ease-out forwards}' +
    '.bl-clink .stk{position:absolute;left:4px;top:30px;height:12px;width:0;border-radius:6px;' +
    'background:linear-gradient(90deg,#ff5f6d,#ffc371,#47e5bc,#4d8bff);animation:bl-stk .7s ease-out forwards}' +
    '@keyframes bl-cl{0%{transform:translateX(-14px) rotate(-12deg)}70%{transform:translateX(5px) rotate(20deg)}100%{transform:translateX(1px) rotate(14deg)}}' +
    '@keyframes bl-cr{0%{transform:translateX(14px) scaleX(-1) rotate(-12deg)}70%{transform:translateX(-5px) scaleX(-1) rotate(20deg)}100%{transform:translateX(-1px) scaleX(-1) rotate(14deg)}}' +
    '@keyframes bl-sp{0%{transform:scale(0)}60%{transform:scale(1.4)}100%{transform:scale(1)}}' +
    '@keyframes bl-pop{0%{transform:translateY(16px) rotate(0) scale(.5);opacity:0}60%{transform:translateY(-8px) rotate(300deg) scale(1.15);opacity:1}100%{transform:translateY(0) rotate(360deg) scale(1)}}' +
    '@keyframes bl-sw{0%{transform:translateX(0) rotate(-20deg)}100%{transform:translateX(40px) rotate(10deg)}}' +
    '@keyframes bl-stk{to{width:56px}}' +
    '.bl-err .bl-msg{color:#ff9b85}' +
    '@media (prefers-reduced-motion:reduce){.bl-bub,.bl-fall,.bl-clink span,.bl-clink .stk{animation:none!important}' +
    '.bl-clink .s,.bl-clink .s2{transform:none}.bl-clink .stk{width:56px}.bl-wrap{transition:none}}';

  function ensureEl() {
    if (el) return el;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    el = document.createElement('div');
    el.className = 'bl-wrap';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="bl-card"><div data-r="icon"></div><div class="bl-txt">' +
      '<span class="bl-msg" data-r="msg"></span><div class="bl-meta" data-r="meta"></div>' +
      '<div class="bl-bar" data-r="barw"><i data-r="bar"></i></div></div></div>';
    document.body.appendChild(el);
    refs = {};
    [].forEach.call(el.querySelectorAll('[data-r]'), function (n) { refs[n.getAttribute('data-r')] = n; });
    return el;
  }
  function mugMode() {
    var card = el.firstChild;
    card.style.setProperty('--bl-bg', T.bg);
    card.style.setProperty('--bl-bd', T.bd);
    card.style.setProperty('--bl-title', T.title);
    card.style.setProperty('--bl-text', T.text);
    card.style.setProperty('--bl-bar', T.bar);
    refs.icon.innerHTML = T.vessel;
    refs.g1 = refs.g2 = refs.surf = null;
    [].forEach.call(refs.icon.querySelectorAll('[data-r]'), function (n) { refs[n.getAttribute('data-r')] = n; });
    card.classList.remove('bl-err');
    refs.barw.style.display = '';
  }
  function setHue(s) { // thùng sơn: đổi màu dần như đang pha
    if (!T.hue || !refs.g1) return;
    var h = Math.round((s * 45) % 360);
    var c1 = 'hsl(' + h + ',85%,62%)';
    refs.g1.setAttribute('stop-color', c1);
    refs.g2.setAttribute('stop-color', 'hsl(' + h + ',80%,45%)');
    refs.stream.setAttribute('stroke', c1);
    refs.surf.setAttribute('fill', 'hsl(' + h + ',90%,76%)');
  }
  function setLevel(p) {
    level = p;
    var top = 62 - 56 * p;
    refs.clip.setAttribute('y', top.toFixed(2));
    refs.clip.setAttribute('height', (62 - top + 1).toFixed(2));
    refs.foam.setAttribute('transform', 'translate(0,' + top.toFixed(2) + ')');
    refs.foam.setAttribute('opacity', p > 0.04 ? '1' : '0');
    refs.stream.setAttribute('y2', top.toFixed(2));
    refs.bar.style.width = Math.round(p * 100) + '%';
  }
  function tick() {
    if (state !== 'pouring') return;
    var s = (Date.now() - t0) / 1000;
    setLevel(0.92 * (1 - Math.exp(-s / 5))); // đầy dần, tiến gần 92% chứ không bao giờ "đầy giả"
    setHue(s);
    var msg = s > 40 ? T.long2 : s > 20 ? T.long1 : T.msgs[Math.floor(s / 2.8) % T.msgs.length];
    refs.msg.textContent = msg;
    refs.meta.textContent = (label ? label + ' · ' : '') + '⏱ ' + s.toFixed(1) + 's · đầy ' + Math.round(level * 100) + '% ' + T.unit +
      (pending > 1 ? ' · ' + pending + ' ' + T.many : '');
    raf = setTimeout(tick, 40);
  }
  function show(resume) {
    if (!document.body) { document.addEventListener('DOMContentLoaded', function () { show(); }, { once: true }); return; }
    if (pending <= 0) return;
    ensureEl();
    if (resume !== true) T = THEMES[pickTheme()];
    mugMode();
    state = 'pouring';
    setLevel(resume === true ? level : 0);
    setHue((Date.now() - t0) / 1000);
    refs.stream.style.opacity = '1';
    el.classList.add('on');
    clearTimeout(raf);
    tick();
  }
  function hide() {
    state = 'idle'; label = ''; hadError = false;
    if (el) el.classList.remove('on');
  }
  function finish() {
    clearTimeout(raf);
    state = 'finishing';
    if (hadError) {
      refs.icon.innerHTML = '<div class="bl-clink"><span class="l" style="animation:none;left:8px">💥</span></div>';
      el.firstChild.classList.add('bl-err');
      refs.msg.textContent = T.err;
      refs.meta.textContent = 'Có lỗi khi xử lý — xem thông báo trên trang';
      refs.barw.style.display = 'none';
      endTimer = setTimeout(hide, ERROR_MS);
      return;
    }
    // đổ nốt cho đầy rồi mới ăn mừng
    var from = level, a = Date.now();
    refs.stream.style.opacity = '0';
    (function fill() {
      if (state !== 'finishing') return;
      var k = Math.min(1, (Date.now() - a) / 300);
      setLevel(from + (1 - from) * k);
      if (k < 1) { raf = setTimeout(fill, 40); return; }
      refs.icon.innerHTML = T.doneHtml;
      refs.msg.textContent = T.done[Math.floor(Math.random() * T.done.length)];
      refs.meta.textContent = 'Xong sau ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
      endTimer = setTimeout(hide, CHEERS_MS);
    })();
  }

  function begin(text, immediate) {
    // giữ nhãn của việc đang chạy ngoài cùng (vd. xuất PowerPoint dùng JSZip bên trong → vẫn ghi "Đang tạo file PowerPoint")
    if (text && (pending === 0 || !label)) label = text;
    pending++;
    clearTimeout(graceTimer);
    if (state === 'finishing') { // đang cụng ly mà có việc mới → rót tiếp (giữ nguyên thời gian & mức bia)
      clearTimeout(endTimer);
      hadError = false;
      show(true);
      return;
    }
    if (state === 'idle') {
      state = 'waiting';
      t0 = Date.now();
      showTimer = setTimeout(show, immediate ? 0 : SHOW_DELAY);
    } else if (state === 'waiting' && immediate) {
      clearTimeout(showTimer);
      showTimer = setTimeout(show, 0);
    }
  }
  function end(isError) {
    pending = Math.max(0, pending - 1);
    if (isError) hadError = true;
    if (pending > 0) return;
    if (state === 'waiting') { clearTimeout(showTimer); hide(); return; }
    // chờ 1 nhịp ngắn: nhiều bước nối tiếp nhau (vd. mở từng file zip) thì gộp thành 1 lần rót, khỏi cụng ly liên tục
    if (state === 'pouring') { clearTimeout(graceTimer); graceTimer = setTimeout(function () { if (pending === 0 && state === 'pouring') finish(); }, END_GRACE); }
  }

  if (!off) {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      if (init && init.beer === false) return nativeFetch.apply(this, arguments);
      begin();
      var p;
      try { p = nativeFetch.apply(this, arguments); } catch (e) { end(true); throw e; }
      return p.then(
        function (r) { end(!r.ok && r.status !== 401); return r; },
        function (e) { end(!(e && e.name === 'AbortError')); throw e; }
      );
    };
  }

  window.BeerLoader = {
    theme: function () { return pickTheme(); }, // xem trang hiện tại đang dùng chủ đề nào
    start: function (text) {
      if (off) return function () {};
      var closed = false;
      begin(text || '', true);
      return function done(isError) { if (!closed) { closed = true; end(!!isError); } };
    },
    run: function (fn, text) {
      var done = window.BeerLoader.start(text);
      // nhường 1 nhịp cho trình duyệt kịp vẽ ly bia trước khi chạy việc nặng
      return new Promise(function (r) { setTimeout(r, 30); })
        .then(function () { return fn(); })
        .then(function (v) { done(); return v; }, function (e) { done(true); throw e; });
    },
  };

  /* ---------- Tự gắn vào các thư viện xử lý nặng trong trình duyệt ----------
     Trang nào có thư viện nào thì gắn thư viện đó, không cần sửa code từng trang. */
  function wrapAsync(obj, name, text) {
    var orig = obj && obj[name];
    if (typeof orig !== 'function' || orig.__beer) return;
    var w = function () {
      var done = window.BeerLoader.start(text), r;
      try { r = orig.apply(this, arguments); } catch (e) { done(true); throw e; }
      if (r && typeof r.then === 'function') {
        r.then(function () { done(); }, function () { done(true); });
      } else done();
      return r;
    };
    w.__beer = true;
    obj[name] = w;
  }

  var xlsxReadDone = null;
  function startXlsxRead() {
    if (xlsxReadDone) return;
    var d = window.BeerLoader.start('Đang đọc file Excel');
    xlsxReadDone = d;
    // chọn file mà trang không đọc (sai định dạng, bị chặn…) thì tự dọn sau 3s
    setTimeout(function () { if (xlsxReadDone === d) { xlsxReadDone = null; d(); } }, 3000);
  }
  function isSheetFile(f) { return f && /\.(xlsx|xlsm|xls|csv)$/i.test(f.name || ''); }
  function hasSheet(files) { return files && [].some.call(files, isSheetFile); }

  function hookLibs() {
    var X = window.XLSX;
    if (X && !X.__beer) {
      X.__beer = true;
      // Xuất Excel: chạy đồng bộ nên hoãn 1 nhịp cho ly bia kịp hiện rồi mới xuất
      ['writeFile', 'writeFileXLSX'].forEach(function (n) {
        var orig = X[n];
        if (typeof orig !== 'function') return;
        X[n] = function () {
          var self = this, args = arguments, done = window.BeerLoader.start('Đang xuất file Excel');
          setTimeout(function () {
            try { orig.apply(self, args); done(); } catch (e) { done(true); console.error(e); }
          }, 60);
        };
      });
      // Đọc Excel: ly bia đã bật từ lúc chọn file, đọc xong thì cụng ly
      var origRead = X.read;
      if (typeof origRead === 'function') {
        X.read = function () {
          try { return origRead.apply(this, arguments); }
          finally {
            var d = xlsxReadDone; xlsxReadDone = null;
            if (d) setTimeout(d, 50);
          }
        };
      }
    }
    if (typeof window.html2canvas === 'function' && !window.html2canvas.__beer) {
      var h2c = window.html2canvas;
      window.html2canvas = function (node, opts) {
        opts = opts || {};
        var ign = opts.ignoreElements;
        // không để ly bia lọt vào ảnh chụp báo cáo
        var o = Object.assign({}, opts, {
          ignoreElements: function (n) { return (n.classList && n.classList.contains('bl-wrap')) || (ign ? ign(n) : false); },
        });
        var done = window.BeerLoader.start('Đang chụp ảnh báo cáo');
        var r;
        try { r = h2c.call(this, node, o); } catch (e) { done(true); throw e; }
        r.then(function () { done(); }, function () { done(true); });
        return r;
      };
      window.html2canvas.__beer = true;
    }
    if (window.PptxGenJS && window.PptxGenJS.prototype) {
      wrapAsync(window.PptxGenJS.prototype, 'writeFile', 'Đang tạo file PowerPoint');
      wrapAsync(window.PptxGenJS.prototype, 'write', 'Đang tạo file PowerPoint');
    }
    if (window.JSZip && window.JSZip.prototype) {
      wrapAsync(window.JSZip.prototype, 'loadAsync', 'Đang mở file zip');
      wrapAsync(window.JSZip.prototype, 'generateAsync', 'Đang nén file zip');
    }
  }

  if (!off) {
    document.addEventListener('change', function (e) {
      var t = e.target;
      if (window.XLSX && t && t.type === 'file' && hasSheet(t.files)) startXlsxRead();
    }, true);
    document.addEventListener('drop', function (e) {
      if (window.XLSX && e.dataTransfer && hasSheet(e.dataTransfer.files)) startXlsxRead();
    }, true);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hookLibs);
    else hookLibs();
    window.addEventListener('load', hookLibs); // phòng thư viện nạp muộn
  }
})();
