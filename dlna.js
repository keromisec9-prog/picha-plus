(function () {
  if (!window.PichaDlna) return;
  var sheet = null;
  function el(tag, css, txt) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (txt) e.textContent = txt;
    return e;
  }
  function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }
  window.onDlnaResult = function (ok, msg) {
    if (window.PichaApp && PichaApp.toast) PichaApp.toast(msg);
    if (ok) closeSheet();
  };
  window.castToTV = function (url, title) {
  window.openCastChooser = function () { if (window._tvCast) chooser(); else if (window.PichaChromecast) PichaChromecast.open(); };
    closeSheet();
    sheet = el('div', 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:flex-end');
    sheet.onclick = function (e) { if (e.target === sheet) closeSheet(); };
    var box = el('div', 'width:100%;max-height:65%;overflow:auto;background:#1a1a1a;color:#fff;border-radius:16px 16px 0 0;padding:20px');
    box.appendChild(el('div', 'font-weight:600;font-size:16px;margin-bottom:12px', 'Cast to TV'));
    var status = el('div', 'opacity:.7;font-size:13px;margin-bottom:8px', 'Searching for TVs…');
    var list = el('div');
    var stopBtn = el('button', 'margin-top:12px;padding:10px 14px;background:transparent;color:#ccc;border:1px solid #444;border-radius:10px;font-size:14px', 'Stop casting');
    stopBtn.onclick = function () { PichaDlna.stop(); closeSheet(); };
    box.appendChild(status); box.appendChild(list); box.appendChild(stopBtn);
    sheet.appendChild(box);
    document.body.appendChild(sheet);
    window.onDlnaDevices = function (devs) {
      list.textContent = '';
      status.textContent = devs.length ? 'Tap your TV' : 'No TVs found. Check that the phone and TV are on the same Wi-Fi.';
      devs.forEach(function (d) {
        var b = el('button', 'display:block;width:100%;text-align:left;padding:14px;margin:6px 0;background:#2a2a2a;color:#fff;border:0;border-radius:10px;font-size:15px', d.name);
        b.onclick = function () {
          status.textContent = 'Sending to ' + d.name + '…';
          PichaDlna.play(d.id, url, title || '');
        };
        list.appendChild(b);
      });
    };
    PichaDlna.discover();
  };
})();

(function () {
  if (!window.PichaDlna) return;
  var btn = null;
  function make() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'tvCastBtn';
    btn.textContent = '📺 TV';
    btn.style.cssText = 'position:absolute;top:12px;right:64px;z-index:60;padding:8px 12px;background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:20px;font-size:13px;display:none';
    btn.onclick = function () {
      var c = window._tvCast;
      if (!c) return;
      var v = document.getElementById('player');
      if (v) { try { v.pause(); } catch (e) {} }
      window.castToTV(c.url, c.title);
    };
    var m = document.getElementById('playerModal');
    if (m) m.appendChild(btn);
    return btn;
  }
  window.showTvCastBtn = function () { var b = null; if (b) b.style.display = 'block'; };
  window.hideTvCastBtn = function () { if (btn) btn.style.display = 'none'; };
})();
