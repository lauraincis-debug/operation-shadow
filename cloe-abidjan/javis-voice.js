/* javis-voice.js — moteur vocal de Javis (PWA, Chrome Android)
   Reconnaissance Web Speech, file de parole, intentions, interruptions.
   Aucune clé API ici : le cerveau est injecté via opts.askImpl (ou endpoint). */
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // Supprime les répétitions consécutives : "arrêter arrêter la arrêter la conversation" -> "arrêter la conversation"
  function dedupe(text, minN = 1) {
    let w = (text || '').split(/\s+/).filter(Boolean), changed = true;
    const key = (a, b) => w.slice(a, b).join(' ').toLowerCase();
    while (changed) {
      changed = false;
      for (let n = Math.min(6, w.length >> 1); n >= minN && !changed; n--) {
        for (let i = 0; i + 2 * n <= w.length; i++) {
          if (key(i, i + n) === key(i + n, i + 2 * n)) { w.splice(i + n, n); changed = true; break; }
        }
      }
    }
    return w.join(' ');
  }

  const STOP_RX = /\b(stop|arrete|arreter|arrete toi|ca suffit|c est bon|c est tout|merci c est tout|termine|terminer|au revoir|bye|a plus tard|a bientot|ferme|fermer|quitte|quitter|fin de la conversation|fin de conversation)\b/;
  const PAUSE_RX = /\b(pause|une seconde|un instant|une minute|attends|attend)\b/;
  const RESUME_RX = /\b(javis|jarvis|reprends|reprend|je suis la|c est bon|ok|vas y|allez)\b/;

  function intentOf(raw) {
    const n = dedupe(norm(raw)), words = n ? n.split(' ').length : 0;
    if (words && words <= 5 && STOP_RX.test(n)) return 'stop';
    if (words && words <= 4 && PAUSE_RX.test(n)) return 'pause';
    return 'chat';
  }

  class JavisVoice {
    constructor(opts) {
      this.o = Object.assign({
        endpoint: '', askImpl: null, lang: 'fr-FR', silenceMs: 60000, commitMs: 1200,
        getToken: null, loadMemory: null, saveTurn: null,
        onState() {}, onTranscript() {}, onError() {}
      }, opts);
      this.state = 'idle'; this.active = false; this.paused = false;
      this.history = []; this.summary = '';
      this.rec = null; this.q = []; this.speaking = false; this.streaming = false;
      this.gen = 0; this.logs = []; this.dbg = null; this.voice = null;
      this._lvl = 0; this._tgt = 0;
      if ('speechSynthesis' in window) {
        this.pickVoice();
        speechSynthesis.onvoiceschanged = () => this.pickVoice();
      }
    }
    pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    log(tag, d = '') {
      console.log('[Javis]', tag, d);
      this.logs.push(new Date().toLocaleTimeString('fr-FR') + ' ' + tag + ' ' + d);
      if (this.logs.length > 40) this.logs.shift();
      if (this.dbg) this.dbg.textContent = this.logs.slice(-16).join('\n');
    }
    showDebug() {
      if (this.dbg) return;
      this.dbg = document.createElement('pre');
      this.dbg.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;margin:0;padding:8px;background:rgba(0,0,0,.85);color:#7CFC9A;font:11px monospace;z-index:99999;white-space:pre-wrap';
      this.dbg.onclick = () => this.hideDebug();
      document.body.appendChild(this.dbg);
      this.dbg.textContent = this.logs.slice(-16).join('\n');
    }
    hideDebug() { if (this.dbg) this.dbg.remove(); this.dbg = null; }
    bump(v) { this._tgt = Math.max(this._tgt, v); }
    getLevel() {
      if (this.speaking) this.bump(0.35 + 0.3 * Math.abs(Math.sin(Date.now() / 130)));
      this._lvl += (this._tgt - this._lvl) * 0.25;
      this._tgt *= 0.9;
      return this._lvl;
    }
    set(s) {
      if (s === this.state) return;
      this.state = s; this.log('état', s);
      if (s === 'thinking') { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} }
      this.o.onState(s);
    }
    pickVoice() {
      try {
        const v = speechSynthesis.getVoices().filter(x => /^fr/i.test(x.lang));
        this.voice = v.find(x => /fr[-_]FR/i.test(x.lang) && /google|natural|neural|online/i.test(x.name))
          || v.find(x => /fr[-_]FR/i.test(x.lang)) || v[0] || null;
      } catch (e) {}
    }
    async micPermission() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        return true;
      } catch (e) {
        this.fatal(e.name === 'NotFoundError'
          ? "Je ne trouve pas de micro sur cet appareil."
          : "Le micro est bloqué. Autorise-le dans les réglages du site, puis réessaie.");
        return false;
      }
    }
    async start() {
      if (this.active) return;
      if (!SR) return this.fatal("Ce navigateur ne gère pas la reconnaissance vocale. Utilise Chrome.");
      if (!(await this.micPermission())) return;
      this.active = true; this.paused = false; this.last = Date.now(); this.errs = 0; this.quick = 0;
      try { this.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
      this.vis = () => { if (document.hidden) this.stop(); };
      document.addEventListener('visibilitychange', this.vis);
      try {
        const m = await this.o.loadMemory();
        if (m) { this.summary = m.summary || ''; this.history = m.history || []; }
      } catch (e) { this.log('mémoire:erreur', e.message); }
      this.timer = setInterval(() => {
        if (this.state === 'listening' && Date.now() - this.last > this.o.silenceMs)
          this.stop("Je reste dispo si tu as besoin. À tout à l'heure !");
      }, 4000);
      this.enqueue(this.pick(["Salut Lauraincis ! Je t'écoute.", "Je suis là, dis-moi.", "Hello ! Qu'est-ce qu'on fait ?"]));
    }
    stop(bye, withError) {
      this.active = false; this.paused = false; this.gen++;
      clearInterval(this.timer);
      document.removeEventListener('visibilitychange', this.vis);
      try { this.wake && this.wake.release(); } catch (e) {}
      this.wake = null;
      if (this.abort) this.abort.abort();
      this.stopRec();
      this.q = []; this.speaking = false; this.streaming = false;
      if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
        if (bye) setTimeout(() => {
          const u = new SpeechSynthesisUtterance(bye);
          u.lang = this.o.lang; if (this.voice) u.voice = this.voice;
          speechSynthesis.speak(u);
        }, 120);
      }
      this.set(withError ? 'error' : 'idle');
      if (withError) setTimeout(() => { if (this.state === 'error') this.set('idle'); }, 2500);
    }
    fatal(msg) { this.log('FATAL', msg); this.o.onError(msg); this.stop(msg, true); }
    interrupt() {
      this.log('interruption'); this.gen++;
      if (this.abort) this.abort.abort();
      this.q = [];
      speechSynthesis.cancel(); this.speaking = false; this.streaming = false;
      this.set('listening'); this.startRec();
    }
    attachOrb(el) {
      if (!el) return;
      let t = 0;
      el.addEventListener('pointerdown', () => {
        t = setTimeout(() => { t = 0; if (this.dbg) this.hideDebug(); else this.showDebug(); }, 700);
      });
      el.addEventListener('pointerup', () => {
        if (!t) return; clearTimeout(t); t = 0;
        if (!this.active) this.start();
        else if (this.state === 'speaking' || this.state === 'thinking') this.interrupt();
      });
      el.addEventListener('pointercancel', () => { clearTimeout(t); t = 0; });
    }
    stopRec() {
      const r = this.rec; this.rec = null;
      try { r && r.abort(); } catch (e) {}
    }
    startRec() {
      if (!this.active || this.rec || this.speaking || this.state === 'thinking') return;
      const r = new SR(); this.rec = r;
      r.lang = this.o.lang; r.continuous = false; r.interimResults = true; r.maxAlternatives = 1;
      let committed = false, text = '', timer = 0;
      const t0 = Date.now();
      const commit = () => {
        if (committed) return; committed = true; clearTimeout(timer);
        const final = text.trim();
        try { r.stop(); } catch (e) {}
        if (final) this.onUtterance(final);
      };
      r.onstart = () => { this.log('micro:start'); if (!this.paused) this.set('listening'); };
      r.onspeechstart = () => { this.log('micro:voix détectée'); this.last = Date.now(); this.bump(0.8); };
      r.onresult = e => {
        let fin = '', itm = '';
        for (let i = 0; i < e.results.length; i++) {
          if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' ';
          else itm += e.results[i][0].transcript + ' ';
        }
        text = (fin + itm).trim(); this.last = Date.now(); this.bump(0.6);
        this.o.onTranscript(dedupe(text, 2), !itm);
        clearTimeout(timer);
        if (fin && !itm) commit();
        else timer = setTimeout(commit, this.o.commitMs);
      };
      r.onerror = e => {
        if (r !== this.rec) return;
        this.log('micro:erreur', e.error);
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
          this.fatal("Le micro est bloqué. Autorise-le dans les réglages du site, puis réessaie.");
        else if (e.error === 'audio-capture')
          this.fatal("Je ne trouve pas de micro sur cet appareil.");
        else if (e.error === 'network' && ++this.errs >= 3)
          this.fatal("La reconnaissance vocale a besoin d'internet. Vérifie ta connexion.");
      };
      r.onend = () => {
        if (r !== this.rec) return;
        clearTimeout(timer); this.rec = null; this.log('micro:fin');
        if (!committed && text.trim()) return commit();
        this.quick = Date.now() - t0 < 700 ? this.quick + 1 : 0;
        if (this.quick >= 6)
          return this.fatal("La reconnaissance vocale ne démarre pas. Ferme les autres applis qui utilisent le micro, puis réessaie.");
        if (this.active && !this.speaking && this.state !== 'thinking') setTimeout(() => this.startRec(), 250);
      };
      try { r.start(); } catch (e) {
        this.log('micro:échec démarrage', e.message); this.rec = null;
        setTimeout(() => this.startRec(), 500);
      }
    }
    async onUtterance(raw) {
      this.last = Date.now();
      const clean = dedupe(raw, 2); this.log('entendu', clean);
      if (this.paused) {
        if (RESUME_RX.test(norm(clean))) { this.paused = false; this.enqueue("Je suis de retour, dis-moi !"); }
        return;
      }
      const intent = intentOf(clean);
      if (intent === 'stop') return this.stop("D'accord, à bientôt !");
      if (intent === 'pause') {
        this.paused = true; this.set('paused');
        return this.enqueue("D'accord, je t'attends. Dis Cloé quand tu veux reprendre.");
      }
      await this.ask(clean);
    }
    async ask(text) {
      this.set('thinking'); this.stopRec();
      this.streaming = true; this.abort = new AbortController();
      const filler = setTimeout(() => this.enqueue(this.pick(["Hmm, laisse-moi regarder ça…", "Une seconde, je cherche…"])), 6000);
      let full = '', buf = '';
      const pousserMorceaux = c => {
        clearTimeout(filler); buf += c;
        let m;
        while ((m = buf.match(/^([\s\S]+?(?:[.!?…](?=\s)|\n))\s*/))) { this.enqueue(m[1]); buf = buf.slice(m[0].length); }
      };
      try {
        if (this.o.askImpl) {
          full = await this.o.askImpl(text, { signal: this.abort.signal, onChunk: pousserMorceaux });
          if (buf.trim()) this.enqueue(buf);
          if (full === null) { clearTimeout(filler); this.streaming = false; return this.maybeListen(); }
          if (!full || !String(full).trim()) throw new Error('réponse vide');
          full = String(full);
        } else {
          const headers = { 'Content-Type': 'application/json' };
          const tok = await this.o.getToken(); if (tok) headers.Authorization = 'Bearer ' + tok;
          const res = await fetch(this.o.endpoint, {
            method: 'POST', headers, signal: this.abort.signal,
            body: JSON.stringify({ message: text, history: this.history.slice(-10), summary: this.summary })
          });
          this.log('ia:http', res.status);
          if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
          const rd = res.body.getReader(), dec = new TextDecoder();
          for (;;) {
            const { done, value } = await rd.read(); if (done) break;
            const c = dec.decode(value, { stream: true }); full += c; pousserMorceaux(c);
          }
          if (buf.trim()) this.enqueue(buf);
          if (!full.trim()) throw new Error('réponse vide');
        }
        this.history.push({ role: 'user', content: text }, { role: 'assistant', content: full });
        this.history = this.history.slice(-20);
        if (this.o.saveTurn) { try { await this.o.saveTurn(text, full); } catch (e) { this.log('mémoire:erreur', e.message); } }
      } catch (e) {
        if (e.name !== 'AbortError') {
          this.log('ia:erreur', e.message); this.o.onError(e.message);
          this.enqueue("Désolé, je n'arrive pas à te répondre pour le moment. Vérifie ma connexion et réessaie.");
        }
      } finally {
        clearTimeout(filler); this.streaming = false; this.maybeListen();
      }
    }
    enqueue(text) {
      const t = (text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_#`>~]/g, '').trim();
      if (!t) return;
      this.q.push(t); this.pump();
    }
    pump() {
      if (this.speaking || !this.active) return;
      const t = this.q.shift();
      if (!t) return this.maybeListen();
      this.speaking = true; this.stopRec(); this.set('speaking');
      const g = this.gen, u = new SpeechSynthesisUtterance(t);
      u.lang = this.o.lang; if (this.voice) u.voice = this.voice; u.rate = 1.05; u.pitch = 1.05;
      let done = false, wd = 0;
      const end = () => {
        if (done) return; done = true; clearTimeout(wd);
        if (g !== this.gen) return;
        this.speaking = false; this.utt = null; this.pump();
      };
      u.onboundary = () => this.bump(0.75);
      u.onend = end;
      u.onerror = e => { this.log('voix:erreur', e.error); end(); };
      wd = setTimeout(end, 4000 + t.length * 90);
      this.utt = u;
      speechSynthesis.speak(u);
    }
    maybeListen() {
      if (!this.active || this.speaking || this.streaming || this.q.length) return;
      this.set(this.paused ? 'paused' : 'listening');
      setTimeout(() => this.startRec(), 300);
    }
  }
  window.JavisVoice = JavisVoice;
  window.__javisDedupe = dedupe;
  window.__javisIntent = intentOf;
})();
