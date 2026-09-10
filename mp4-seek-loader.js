// MSE loader for non-faststart MP4s (moov at end of file).
// Requires mp4box.js (loaded globally as MP4Box) and a real <video> element.
class SeekableMSELoader {
  constructor(videoEl, url) {
    this.video = videoEl;
    this.url = url;
    this.mp4boxfile = MP4Box.createFile();
    this.mediaSource = null;
    this.sourceBuffers = {};
    this.fileSize = 0;
    this.mdatStart = 0;
    this.ready = false;
    this.destroyed = false;
    this.fetchController = null;
    this.pendingSegments = [];
    this._onSourceOpen = this._onSourceOpen.bind(this);
  }

  async load() {
    this.fileSize = await this._getFileSize();
    const { moovStart, moovEnd, mdatStart } = await this._locateMoov();
    this.mdatStart = mdatStart;

    // Fetch ftyp+moov region and feed to mp4box so it can parse the sample table.
    const headerBuf = await this._fetchRange(0, moovEnd - 1);
    headerBuf.fileStart = 0;
    this.mp4boxfile.onReady = (info) => this._onMoovReady(info);
    this.mp4boxfile.onError = (e) => console.error('mp4box error:', e);
    this.mp4boxfile.appendBuffer(headerBuf);
    this.mp4boxfile.flush();

    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener('sourceopen', this._onSourceOpen, { once: true });

    this.video.addEventListener('seeking', () => this._onSeek());
  }

  async _getFileSize() {
    const res = await fetch(this.url, { headers: { Range: 'bytes=0-1' } });
    const cr = res.headers.get('content-range'); // bytes 0-1/TOTAL
    if (cr) return parseInt(cr.split('/')[1], 10);
    const cl = res.headers.get('content-length');
    return cl ? parseInt(cl, 10) : 0;
  }

  async _fetchRange(start, end) {
    const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } });
    const ab = await res.arrayBuffer();
    return ab;
  }

  // Walk top-level boxes from byte 0 to find where moov starts/ends and where mdat starts.
  async _locateMoov() {
    let pos = 0;
    let mdatStart = -1;
    let moovStart = -1, moovEnd = -1;
    for (let i = 0; i < 50; i++) {
      const buf = await this._fetchRange(pos, pos + 15);
      const dv = new DataView(buf);
      let size = dv.getUint32(0, false);
      const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
      let headerLen = 8;
      if (size === 1) {
        // 64-bit size in next 8 bytes
        const hi = dv.getUint32(8, false), lo = dv.getUint32(12, false);
        size = hi * 4294967296 + lo;
        headerLen = 16;
      }
      if (type === 'mdat') mdatStart = pos;
      if (type === 'moov') { moovStart = pos; moovEnd = pos + size; break; }
      if (size === 0 || size < 8) break;
      pos += size;
      if (pos >= this.fileSize) break;
    }
    if (moovStart === -1) throw new Error('moov not found');
    return { moovStart, moovEnd, mdatStart: mdatStart === -1 ? 0 : mdatStart };
  }

  _onMoovReady(info) {
    this.info = info;
    this.ready = true;
    this.duration = info.duration / info.timescale;
    if (this._readyResolve) this._readyResolve();
  }

  _onSourceOpen() {
    this.mediaSource.duration = this.duration || 0;
    for (const track of this.info.tracks) {
      const mime = `video/mp4; codecs="${track.codec}"`;
      if (!MediaSource.isTypeSupported(mime)) {
        console.warn('Unsupported codec, skipping track:', mime);
        continue;
      }
      const sb = this.mediaSource.addSourceBuffer(mime);
      sb.mode = 'segments';
      this.sourceBuffers[track.id] = sb;
      this.mp4boxfile.setSegmentOptions(track.id, sb, { nbSamples: 100 });
    }
    this.mp4boxfile.onSegment = (id, user, buffer) => {
      const sb = this.sourceBuffers[id];
      if (!sb) return;
      this.pendingSegments.push({ sb, buffer });
      this._flushSegments();
    };
    const initSegs = this.mp4boxfile.initializeSegmentation();
    for (const seg of initSegs) {
      const sb = this.sourceBuffers[seg.id];
      if (sb) this.pendingSegments.push({ sb, buffer: seg.buffer });
    }
    this._flushSegments();
    this._streamFrom(this.mdatStart);
  }

  _flushSegments() {
    if (!this.pendingSegments.length) return;
    const next = this.pendingSegments[0];
    if (next.sb.updating) return;
    this.pendingSegments.shift();
    try {
      next.sb.appendBuffer(next.buffer);
      next.sb.addEventListener('updateend', () => this._flushSegments(), { once: true });
    } catch (e) {
      console.error('appendBuffer failed:', e);
    }
  }

  async _streamFrom(byteOffset) {
    if (this.fetchController) this.fetchController.abort();
    this.fetchController = new AbortController();
    const signal = this.fetchController.signal;
    const CHUNK = 2 * 1024 * 1024; // 2MB per fetch
    let pos = byteOffset;
    this.mp4boxfile.start();
    while (pos < this.fileSize && !this.destroyed) {
      // back off if we're comfortably buffered ahead
      while (this._bufferedAhead() > 30 && !this.destroyed) {
        await new Promise(r => setTimeout(r, 300));
      }
      if (this.destroyed || signal.aborted) return;
      let res;
      try {
        res = await fetch(this.url, { headers: { Range: `bytes=${pos}-${Math.min(pos + CHUNK - 1, this.fileSize - 1)}` }, signal });
      } catch (e) { return; } // aborted (likely due to a seek)
      const buf = await res.arrayBuffer();
      buf.fileStart = pos;
      pos += buf.byteLength;
      this.mp4boxfile.appendBuffer(buf);
    }
  }

  _bufferedAhead() {
    if (!this.video.buffered.length) return 0;
    const end = this.video.buffered.end(this.video.buffered.length - 1);
    return end - this.video.currentTime;
  }

  async _onSeek() {
    if (!this.ready) return;
    const targetTime = this.video.currentTime;
    const seekInfo = this.mp4boxfile.seek(targetTime, true);
    // Clear existing buffered data so we don't play stale ranges out of order.
    for (const id in this.sourceBuffers) {
      const sb = this.sourceBuffers[id];
      if (sb.updating) continue;
      if (this.video.buffered.length) {
        try { sb.remove(0, this.mediaSource.duration); } catch (e) {}
      }
    }
    this._streamFrom(seekInfo.offset);
  }

  destroy() {
    this.destroyed = true;
    if (this.fetchController) this.fetchController.abort();
    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try { this.mediaSource.endOfStream(); } catch (e) {}
    }
  }
}

// Drop-in replacement for `video.src = url`. Call this instead when the URL
// is known/suspected to be a non-faststart MP4. Returns the loader instance
// so callers can .destroy() it on unmount/slide-change.
async function loadShortVideoMSE(videoEl, url) {
  await loadMp4Box();
  const loader = new SeekableMSELoader(videoEl, url);
  await loader.load();
  return loader;
}
