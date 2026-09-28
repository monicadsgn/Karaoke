// Guarda músicas importadas, preferências e recordes no navegador.
(function (K) {
  const SONGS = 'karaoke.songs.v1';
  const PREFS = 'karaoke.prefs.v1';
  const BEST = 'karaoke.best.v1';
  const HISTORY = 'karaoke.history.v1';

  function read(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { console.warn(e); return false; }
  }

  const Store = {
    songs() { return read(SONGS, []); },
    saveSong(song) {
      const all = this.songs().filter((s) => s.id !== song.id);
      all.unshift(song);
      if (!write(SONGS, all)) throw new Error('Sem espaço para salvar a música no navegador.');
    },
    deleteSong(id) {
      write(SONGS, this.songs().filter((s) => s.id !== id));
      for (const k of [id, id + ':inst', id + ':voc']) this.deleteAudio(k).catch(() => {});
    },

    prefs(songId) { return read(PREFS, {})[songId] || {}; },
    savePrefs(songId, prefs) { const all = read(PREFS, {}); all[songId] = prefs; write(PREFS, all); },
    globalPrefs() { return read(PREFS, {})._global || {}; },
    saveGlobalPrefs(p) { const all = read(PREFS, {}); all._global = { ...(all._global || {}), ...p }; write(PREFS, all); },

    best(key) { return read(BEST, {})[key] || null; },
    saveBest(key, result) {
      const all = read(BEST, {});
      const prev = all[key];
      const isNew = !prev || result.score > prev.score;
      if (isNew) { all[key] = result; write(BEST, all); }
      return isNew;
    },
    addHistory(entry) {
      const h = read(HISTORY, []);
      h.unshift(entry);
      write(HISTORY, h.slice(0, 200));
    },
    history() { return read(HISTORY, []); },

    // --- áudio (instrumental) no IndexedDB ---
    _db: null,
    db() {
      if (this._db) return this._db;
      this._db = new Promise((resolve, reject) => {
        const req = indexedDB.open('karaoke', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('audio');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this._db;
    },
    async tx(mode, fn) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const t = db.transaction('audio', mode);
        const req = fn(t.objectStore('audio'));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      });
    },
    saveAudio(id, blob) { return this.tx('readwrite', (s) => s.put(blob, id)); },
    loadAudio(id) { return this.tx('readonly', (s) => s.get(id)); },
    deleteAudio(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  };

  K.Store = Store;
})(globalThis.K = globalThis.K || {});
