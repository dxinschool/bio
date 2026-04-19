const USER_ID = '511031197455876128';
const API_URL = `https://api.lanyard.rest/v1/users/${USER_ID}`;
let currentSpotify = null;
let progressInterval = null;
let progressRafId = null;
let currentLyricsLines = [];
let lyricsTrackKey = '';
let lyricsLoading = false;
let lyricsAbortController = null;
const lyricsCache = new Map();
const ABOUT_BIRTHDAY = new Date('2009-01-20T00:00:00+08:00');
const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
let liveAgeRafId = null;

function setActivitySongLink(spotify) {
  const songLink = document.getElementById('activity-song-link');
  if (!songLink) return;

  if (spotify && spotify.track_id) {
    songLink.href = `https://open.spotify.com/track/${encodeURIComponent(spotify.track_id)}`;
    songLink.target = '_blank';
    songLink.rel = 'noopener noreferrer';
    songLink.classList.remove('is-disabled');
    songLink.tabIndex = 0;
    songLink.setAttribute('aria-label', `Open ${spotify.song || 'song'} on Spotify`);
    return;
  }

  songLink.removeAttribute('href');
  songLink.removeAttribute('target');
  songLink.removeAttribute('rel');
  songLink.classList.add('is-disabled');
  songLink.tabIndex = -1;
  songLink.setAttribute('aria-label', 'Activity album art');
}

function clearProgressUpdate() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }

  if (progressRafId !== null) {
    cancelAnimationFrame(progressRafId);
    progressRafId = null;
  }
}

function getLyricsTrackKey(spotify) {
  if (!spotify) return '';
  return spotify.track_id || `${spotify.song || ''}::${spotify.artist || ''}::${spotify.album || ''}`;
}

function getSpotifyDurationMs(spotify) {
  if (!spotify || !spotify.timestamps) return 0;
  return Math.max(0, Number(spotify.timestamps.end) - Number(spotify.timestamps.start));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function extractLyricTokens(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    const segmented = [];

    for (const part of segmenter.segment(normalized)) {
      const token = String(part.segment || '').trim();
      if (!token) continue;

      const isCjkToken = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token);
      if (part.isWordLike || isCjkToken) {
        segmented.push(token);
      }
    }

    if (segmented.length > 1) {
      return segmented;
    }
  }

  try {
    const unicodeTokens = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    if (unicodeTokens && unicodeTokens.length > 1) {
      return unicodeTokens;
    }
  } catch (error) {
    // Fallback for engines without Unicode property escape support.
  }

  const spacedTokens = (normalized.match(/\S+/g) || []).filter(Boolean);
  if (spacedTokens.length > 1) {
    return spacedTokens;
  }

  return Array.from(normalized).filter(char => char.trim().length > 0);
}

function buildWordTimings(text, startMs, endMs, lineId) {
  const words = extractLyricTokens(text);
  if (!words.length) return [];

  const totalDuration = Math.max(160, endMs - startMs);
  const weights = words.map(word => Math.max(1, word.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = startMs;
  return words.map((word, index) => {
    const remainingWords = words.length - index - 1;
    const minRemaining = remainingWords * 70;
    const weightedSpan = index === words.length - 1
      ? Math.max(80, endMs - cursor)
      : Math.max(70, Math.round((totalDuration * weights[index]) / totalWeight));

    const span = index === words.length - 1
      ? Math.max(80, endMs - cursor)
      : Math.max(70, Math.min(weightedSpan, Math.max(80, endMs - cursor - minRemaining)));

    const wordStart = cursor;
    const wordEnd = index === words.length - 1
      ? endMs
      : Math.max(wordStart + 60, Math.min(endMs, wordStart + span));

    cursor = wordEnd;
    return {
      id: `${lineId}-word-${index}`,
      text: word,
      startMs: wordStart,
      endMs: wordEnd
    };
  });
}

function parseSyncedLyrics(lrcText, durationMs) {
  if (!lrcText || typeof lrcText !== 'string') return [];

  const timeRegex = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;
  const lines = [];

  lrcText.split(/\r?\n/).forEach((rawLine, rowIndex) => {
    const matches = [...rawLine.matchAll(timeRegex)];
    if (!matches.length) return;

    const text = rawLine.replace(timeRegex, '').trim();
    if (!text) return;

    matches.forEach((match, matchIndex) => {
      const minute = Number(match[1]);
      const second = Number(match[2]);
      const startMs = Math.max(0, Math.round((minute * 60 + second) * 1000));
      lines.push({
        id: `lrc-${rowIndex}-${matchIndex}`,
        text,
        startMs,
        endMs: startMs + 1500,
        words: []
      });
    });
  });

  lines.sort((a, b) => a.startMs - b.startMs);
  if (!lines.length) return [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nextStart = lines[i + 1] ? lines[i + 1].startMs : null;
    const fallbackEnd = durationMs > 0
      ? durationMs
      : line.startMs + 3200;

    line.endMs = nextStart !== null
      ? Math.max(line.startMs + 260, nextStart - 24)
      : Math.max(line.startMs + 500, fallbackEnd);

    line.words = buildWordTimings(line.text, line.startMs, line.endMs, line.id);
  }

  return lines;
}

function parsePlainLyrics(plainText, durationMs) {
  if (!plainText || typeof plainText !== 'string') return [];

  const lines = plainText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const totalDuration = Math.max(durationMs || 0, lines.length * 1800);
  const slot = Math.max(900, Math.floor(totalDuration / lines.length));

  return lines.map((text, index) => {
    const startMs = index * slot;
    const endMs = index === lines.length - 1
      ? totalDuration
      : Math.max(startMs + 600, ((index + 1) * slot) - 30);
    const id = `plain-${index}`;

    return {
      id,
      text,
      startMs,
      endMs,
      words: buildWordTimings(text, startMs, endMs, id)
    };
  });
}

function findActiveLineIndex(elapsedMs) {
  if (!currentLyricsLines.length) return -1;

  for (let i = currentLyricsLines.length - 1; i >= 0; i -= 1) {
    if (elapsedMs >= currentLyricsLines[i].startMs) {
      return i;
    }
  }

  return 0;
}

function renderWordSyncedLine(line, elapsedMs) {
  if (!line.words || !line.words.length) {
    return escapeHtml(line.text);
  }

  return line.words.map(word => {
    let className = 'lyrics-word lyrics-word-future';
    let inlineStyle = '';

    if (elapsedMs >= word.endMs) {
      className = 'lyrics-word lyrics-word-past';
    } else if (elapsedMs >= word.startMs) {
      className = 'lyrics-word lyrics-word-active';

      const duration = Math.max(1, word.endMs - word.startMs);
      const progress = clamp((elapsedMs - word.startMs) / duration, 0, 1);
      const wave = Math.sin(progress * Math.PI);
      const lift = wave * 2.5;
      const scale = 1 + (wave * 0.06);
      const glow = 10 + (wave * 12);
      inlineStyle = `style="transform: translateY(${-lift.toFixed(2)}px) scale(${scale.toFixed(3)}); filter: brightness(${(1.1 + (wave * 0.2)).toFixed(3)}); text-shadow: 0 0 ${glow.toFixed(1)}px rgba(248, 250, 252, 0.38), 0 0 ${(glow * 1.6).toFixed(1)}px rgba(125, 211, 252, 0.25);"`;
    } else {
      const startOffset = word.startMs - elapsedMs;
      if (startOffset < 220) {
        const anticipation = 1 - clamp(startOffset / 220, 0, 1);
        inlineStyle = `style="opacity: ${(0.42 + (anticipation * 0.18)).toFixed(3)}; transform: translateY(${(0.9 - anticipation).toFixed(2)}px);"`;
      }
    }

    return `<span class="${className}" ${inlineStyle}>${escapeHtml(word.text)}</span>`;
  }).join('');
}

function renderLyricsAtTime(elapsedMs) {
  const panel = document.getElementById('lyrics-panel');
  const currentLineEl = document.getElementById('lyrics-current');
  const nextLineEl = document.getElementById('lyrics-next');

  if (!panel || !currentLineEl || !nextLineEl) return;

  panel.classList.remove('hidden');

  if (!currentLyricsLines.length) {
    currentLineEl.textContent = lyricsLoading ? 'Loading lyrics...' : 'Lyrics unavailable';
    nextLineEl.textContent = '';
    return;
  }

  const activeIndex = findActiveLineIndex(elapsedMs);
  const currentLine = currentLyricsLines[activeIndex];
  const nextLine = currentLyricsLines[activeIndex + 1];
  const lineDuration = Math.max(1, currentLine.endMs - currentLine.startMs);
  const lineProgress = clamp((elapsedMs - currentLine.startMs) / lineDuration, 0, 1);
  const fadeBlend = clamp((lineProgress - 0.72) / 0.28, 0, 1);

  currentLineEl.innerHTML = renderWordSyncedLine(currentLine, elapsedMs);
  currentLineEl.style.opacity = String(1 - (fadeBlend * 0.18));
  currentLineEl.style.transform = `translateY(${(-fadeBlend * 2.2).toFixed(2)}px)`;

  nextLineEl.textContent = nextLine ? nextLine.text : '';
  nextLineEl.style.opacity = String(nextLine ? (0.44 + (fadeBlend * 0.45)) : 0);
  nextLineEl.style.transform = `translateY(${((1 - fadeBlend) * 2.4).toFixed(2)}px)`;
}

async function fetchLyricsPayload(spotify, signal) {
  const params = new URLSearchParams({
    track_name: spotify.song || '',
    artist_name: spotify.artist || ''
  });

  if (spotify.album) params.set('album_name', spotify.album);

  const response = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
    cache: 'no-store',
    signal
  });

  if (!response.ok) {
    throw new Error(`Lyrics API failed with ${response.status}`);
  }

  return response.json();
}

function hideLyricsPanel() {
  const panel = document.getElementById('lyrics-panel');
  const currentLineEl = document.getElementById('lyrics-current');
  const nextLineEl = document.getElementById('lyrics-next');

  if (panel) panel.classList.add('hidden');
  if (currentLineEl) currentLineEl.textContent = '';
  if (nextLineEl) nextLineEl.textContent = '';

  currentLyricsLines = [];
  lyricsTrackKey = '';
  lyricsLoading = false;

  if (lyricsAbortController) {
    lyricsAbortController.abort();
    lyricsAbortController = null;
  }
}

async function loadSpotifyLyrics(spotify) {
  const trackKey = getLyricsTrackKey(spotify);
  if (!trackKey) return;

  const elapsedMs = Math.max(0, Date.now() - spotify.timestamps.start);

  if (trackKey === lyricsTrackKey && (lyricsLoading || currentLyricsLines.length)) {
    renderLyricsAtTime(elapsedMs);
    return;
  }

  lyricsTrackKey = trackKey;
  lyricsLoading = true;
  currentLyricsLines = [];
  renderLyricsAtTime(elapsedMs);

  if (lyricsAbortController) {
    lyricsAbortController.abort();
  }
  lyricsAbortController = new AbortController();

  if (lyricsCache.has(trackKey)) {
    currentLyricsLines = lyricsCache.get(trackKey);
    lyricsLoading = false;
    renderLyricsAtTime(elapsedMs);
    return;
  }

  try {
    const payload = await fetchLyricsPayload(spotify, lyricsAbortController.signal);
    if (trackKey !== lyricsTrackKey) return;

    const durationMs = getSpotifyDurationMs(spotify);
    let parsed = [];

    if (payload && payload.syncedLyrics) {
      parsed = parseSyncedLyrics(payload.syncedLyrics, durationMs);
    }

    if (!parsed.length && payload && payload.plainLyrics) {
      parsed = parsePlainLyrics(payload.plainLyrics, durationMs);
    }

    currentLyricsLines = parsed;
    lyricsCache.set(trackKey, parsed);
  } catch (error) {
    if (error.name !== 'AbortError') {
      currentLyricsLines = [];
    }
  } finally {
    if (trackKey === lyricsTrackKey) {
      lyricsLoading = false;
      renderLyricsAtTime(Math.max(0, Date.now() - spotify.timestamps.start));
    }
  }
}

async function fetchStatus() {
  try {
    const response = await fetch(API_URL);
    const data = await response.json();
    if (!data.success) throw new Error('API failed');
    renderStatus(data.data);
  } catch (error) {
    hideLyricsPanel();
    setActivitySongLink(null);
    // Hide profile if unavailable, but keep activity card visible with a placeholder
    const profileContainer = document.getElementById('profile-container');
    if (profileContainer) profileContainer.classList.add('hidden');
    const activityContainer = document.getElementById('activity-container');
    if (activityContainer) activityContainer.classList.remove('hidden');
    // set placeholder text
    const typeEl = document.getElementById('activity-type');
    const nameEl = document.getElementById('activity-name');
    const detailEl = document.getElementById('activity-detail');
    const progressEl = document.getElementById('progress-container');
    if (typeEl) {
      typeEl.textContent = 'No Activity';
      typeEl.className = 'activity-type no-activity';
    }
    if (nameEl) {
      nameEl.textContent = 'No current activity detected';
      nameEl.className = 'activity-name no-activity';
    }
    // hide album art
    const activityIcon = document.getElementById('activity-icon');
    if (activityIcon) activityIcon.src = '';
    if (detailEl) detailEl.textContent = '';
    if (progressEl) progressEl.classList.add('hidden');
    // add a helper class for centered layout
    document.querySelectorAll('.activity-section').forEach(el => el.classList.add('no-activity'));
  }
}

function startSpotifyProgressLoop() {
  clearProgressUpdate();

  const tick = () => {
    if (!currentSpotify) return;

    updateSpotifyProgress();

    if (currentSpotify) {
      progressRafId = requestAnimationFrame(tick);
    }
  };

  progressRafId = requestAnimationFrame(tick);
}

function renderStatus(data) {
  const { discord_user, discord_status, spotify, activities } = data;

  const avatarUrl = discord_user.avatar 
    ? `https://cdn.discordapp.com/avatars/${discord_user.id}/${discord_user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(discord_user.discriminator) % 5}.png`;

  // Update Card 1: Profile Info
  const avatarImg = document.getElementById('avatar-img');
  if (avatarImg) avatarImg.src = avatarUrl;
  const displayNameEl = document.getElementById('display-name');
  if (displayNameEl) displayNameEl.textContent = discord_user.display_name || discord_user.username;
  const usernameEl = document.getElementById('username');
  if (usernameEl) usernameEl.textContent = `@${discord_user.username}`;
  const statusIndicator = document.getElementById('status-indicator');
  if (statusIndicator) statusIndicator.className = `status-indicator ${discord_status}`;
  const profileContainer = document.getElementById('profile-container');
  if (profileContainer) profileContainer.classList.remove('hidden');

  clearProgressUpdate();

  // Update Card 2: Check for Spotify Activity
  if (spotify) {
    currentSpotify = spotify;
    setActivitySongLink(spotify);
    const activityIcon = document.getElementById('activity-icon');
    if (activityIcon) {
      activityIcon.src = spotify.album_art_url;
      activityIcon.alt = `${spotify.song} album art`;
    }
    const typeEl = document.getElementById('activity-type');
    if (typeEl) { typeEl.textContent = 'Listening to Spotify'; typeEl.className = 'activity-type spotify-type'; }
    const nameEl = document.getElementById('activity-name');
    if (nameEl) nameEl.textContent = spotify.song;
    const detailEl = document.getElementById('activity-detail');
    if (detailEl) detailEl.textContent = spotify.artist;
    const progressEl = document.getElementById('progress-container');
    if (progressEl) progressEl.classList.remove('hidden');
    const lyricsPanel = document.getElementById('lyrics-panel');
    if (lyricsPanel) lyricsPanel.classList.remove('hidden');
    const activityContainer = document.getElementById('activity-container');
    if (activityContainer) activityContainer.classList.remove('hidden');
    // clear any placeholder/no-activity state so the album art is shown
    document.querySelectorAll('.activity-section').forEach(el => el.classList.remove('no-activity'));
    loadSpotifyLyrics(spotify);
    startSpotifyProgressLoop();
    updateSpotifyProgress();
    return;
  }

  // Update Card 2: Check for Game Activity
  const gameActivity = activities?.find(a => a.type === 0 && a.name !== 'Custom Status');
  if (gameActivity) {
    currentSpotify = null;
    setActivitySongLink(null);
    const largeImg = gameActivity.assets?.large_image;
    const appId = gameActivity.application_id;
    const activityIcon = document.getElementById('activity-icon');
    if (largeImg && !largeImg.startsWith('spotify:')) {
      if (activityIcon) {
        activityIcon.src = `https://cdn.discordapp.com/app-assets/${appId}/${largeImg}.png?size=96`;
        activityIcon.alt = `${gameActivity.name} image`;
      }
    } else {
      if (activityIcon) activityIcon.src = '';
    }
    const typeEl = document.getElementById('activity-type');
    if (typeEl) { typeEl.textContent = 'Playing'; typeEl.className = 'activity-type'; }
    const nameEl = document.getElementById('activity-name');
    if (nameEl) nameEl.textContent = gameActivity.name;
    const detailEl = document.getElementById('activity-detail');
    if (detailEl) detailEl.textContent = gameActivity.details || '';
    const progressEl = document.getElementById('progress-container');
    if (progressEl) progressEl.classList.add('hidden');
    const activityContainer = document.getElementById('activity-container');
    if (activityContainer) activityContainer.classList.remove('hidden');
    hideLyricsPanel();
    // clear any placeholder/no-activity state so the game asset is shown
    document.querySelectorAll('.activity-section').forEach(el => el.classList.remove('no-activity'));
  } else {
    currentSpotify = null;
    setActivitySongLink(null);
    // No spotify or game activity — show a consistent "No Activity" placeholder
    const activityContainer = document.getElementById('activity-container');
    const typeEl = document.getElementById('activity-type');
    const nameEl = document.getElementById('activity-name');
    const detailEl = document.getElementById('activity-detail');
    const progressEl = document.getElementById('progress-container');

    if (activityContainer) activityContainer.classList.remove('hidden');
    if (typeEl) { typeEl.textContent = 'No Activity'; typeEl.className = 'activity-type no-activity'; }
    if (nameEl) { nameEl.textContent = 'Not listening'; nameEl.className = 'activity-name no-activity'; }
    // hide album art for placeholder
    const activityIcon = document.getElementById('activity-icon');
    if (activityIcon) {
      activityIcon.src = '';
      activityIcon.alt = '';
    }
    if (detailEl) detailEl.textContent = '';
    if (progressEl) progressEl.classList.add('hidden');
    hideLyricsPanel();
    // center the placeholder
    document.querySelectorAll('.activity-section').forEach(el => el.classList.add('no-activity'));
  }
}

function updateSpotifyProgress() {
  if (!currentSpotify) return;
  const elapsedMs = Date.now() - currentSpotify.timestamps.start;
  const durationMs = currentSpotify.timestamps.end - currentSpotify.timestamps.start;
  const progress = (elapsedMs / durationMs) * 100;
  if (progress >= 100) {
    currentSpotify = null;
    clearProgressUpdate();
    fetchStatus();
    return;
  }
  const currentTimeText = formatTime(elapsedMs);
  const durationText = formatTime(durationMs);
  const progressFill = document.getElementById('progress-fill');
  if (progressFill) progressFill.style.width = `${progress}%`;
  const currentTimeEl = document.getElementById('current-time');
  if (currentTimeEl) currentTimeEl.textContent = currentTimeText;
  const durationEl = document.getElementById('duration-time');
  if (durationEl) durationEl.textContent = durationText;
  renderLyricsAtTime(Math.max(0, elapsedMs));
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function updateLiveClock() {
  const now = new Date();
  // Format time accurately for Hong Kong timezone
  const timeString = now.toLocaleTimeString('en-US', { 
    timeZone: 'Asia/Hong_Kong',
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit',
    second: '2-digit'
  });
  const timeEl = document.getElementById('live-time');
  if(timeEl) timeEl.textContent = timeString;
}

function calculateLiveAge(nowMs = Date.now()) {
  const birthdayMs = ABOUT_BIRTHDAY.getTime();
  if (!Number.isFinite(birthdayMs)) return 0;
  return Math.max(0, (nowMs - birthdayMs) / MS_PER_YEAR);
}

function startLiveAgeTicker() {
  const liveAgeEl = document.getElementById('live-age');
  if (!liveAgeEl) return;

  if (liveAgeRafId !== null) {
    cancelAnimationFrame(liveAgeRafId);
    liveAgeRafId = null;
  }

  const tick = () => {
    liveAgeEl.textContent = calculateLiveAge().toFixed(8);
    liveAgeRafId = requestAnimationFrame(tick);
  };

  tick();
}

fetchStatus();
setInterval(fetchStatus, 5000);
setInterval(updateLiveClock, 1000);
updateLiveClock(); // initial call
startLiveAgeTicker();

// HKO Weather integration
// HKO Weather integration — fetch temperature and show custom icon when available
async function fetchWeather() {
  const endpoints = [
    'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en',
    'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=flw&lang=en',
    'https://data.weather.gov.hk/weatherAPI/opendata/opendata.php?dataType=LTMV&lang=en&rformat=json'
  ];

  let json = null;
  for (const url of endpoints) {
    try {
      const resp = await fetch(url + `&_=${Date.now()}`);
      if (!resp.ok) continue;
      const text = await resp.text();
      try { json = JSON.parse(text); } catch (e) { continue; }
      if (json) break;
    } catch (e) { continue; }
  }

  const tempEl = document.getElementById('weather-temp');
  const descEl = document.getElementById('weather-desc');
  const iconImg = document.getElementById('weather-icon-img');
  const iconContainer = document.getElementById('weather-icon');

  if (!json) {
    console.warn('HKO: no JSON response from endpoints');
    return;
  }

  // Heuristic: find a numeric temperature value anywhere in the JSON
  function findTemp(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // common shapes
    if (obj.temperature && typeof obj.temperature === 'string') return obj.temperature;
    if (obj.temperature && Array.isArray(obj.temperature)) {
      for (const item of obj.temperature) {
        if (item.value !== undefined) return item.value;
        if (item.temperature !== undefined) return item.temperature;
      }
    }
    if (obj.temperature && obj.temperature.data && Array.isArray(obj.temperature.data)) {
      for (const t of obj.temperature.data) if (t.value !== undefined) return t.value;
    }
    // generic search
    for (const k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      const v = obj[k];
      if (v && typeof v === 'object') {
        const t = findTemp(v);
        if (t !== null && t !== undefined) return t;
      }
      if ((k.toLowerCase().includes('temp') || k.toLowerCase().includes('temperature')) && (typeof v === 'number' || typeof v === 'string')) return v;
    }
    return null;
  }

  const temp = findTemp(json);
  if (tempEl && temp !== null && temp !== undefined) tempEl.textContent = `${temp}°C`;

  // description
  const desc = json.generalSituation || json.weather?.main || json.forecast?.summary || json.overview || '';
  if (descEl && desc) descEl.textContent = desc;

  // icon handling: prefer a local asset if exists, else show an emoji
  const textLower = (desc || '').toLowerCase();
  let emoji = '🌤️';
  if (textLower.includes('rain')) emoji = '🌧️';
  else if (textLower.includes('cloud')) emoji = '☁️';
  else if (textLower.includes('sun') || textLower.includes('clear')) emoji = '☀️';

  const assetMap = {
    sun: 'assets/weather/sunny.svg',
    clear: 'assets/weather/sunny.svg',
    cloud: 'assets/weather/cloudy.svg',
    rain: 'assets/weather/rain.svg',
    storm: 'assets/weather/storm.svg',
    snow: 'assets/weather/snow.svg'
  };

  let chosenAsset = null;
  for (const k in assetMap) if (textLower.includes(k)) { chosenAsset = assetMap[k]; break; }

  if (iconImg) {
    if (chosenAsset) {
      try {
        const r = await fetch(chosenAsset, { method: 'GET' });
        if (r.ok) {
          iconImg.src = chosenAsset;
          iconImg.style.display = 'block';
          // clear textual fallback
          if (iconContainer) iconContainer.classList.remove('text-3xl');
        } else {
          iconImg.style.display = 'none';
          if (iconContainer) iconContainer.textContent = emoji;
        }
      } catch (e) {
        iconImg.style.display = 'none';
        if (iconContainer) iconContainer.textContent = emoji;
      }
    } else {
      iconImg.style.display = 'none';
      if (iconContainer) iconContainer.textContent = emoji;
    }
  }
}

// initial fetch + periodic update (every 10 minutes)
fetchWeather();
setInterval(fetchWeather, 10 * 60 * 1000);

const scrollHint = document.getElementById('scroll-hint');
const aboutSection = document.getElementById('about');
const backToTop = document.getElementById('back-to-top');

function updateScrollUi() {
  const scrolledY = window.scrollY;

  if (scrollHint) {
    scrollHint.classList.toggle('is-hidden', scrolledY > 80);
  }

  if (backToTop) {
    backToTop.classList.toggle('is-visible', scrolledY > 260);
  }
}

if (scrollHint && aboutSection) {
  scrollHint.addEventListener('click', () => {
    aboutSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

if (backToTop) {
  backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

window.addEventListener('scroll', updateScrollUi, { passive: true });
updateScrollUi();

let resizeTimer = null;

function markResponsiveResize() {
  document.body.classList.add('is-resizing');
  if (resizeTimer) {
    window.clearTimeout(resizeTimer);
  }

  resizeTimer = window.setTimeout(() => {
    document.body.classList.remove('is-resizing');
    resizeTimer = null;
  }, 180);
}

window.addEventListener('resize', markResponsiveResize, { passive: true });
window.addEventListener('orientationchange', markResponsiveResize, { passive: true });
