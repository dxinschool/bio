const USER_ID = '511031197455876128';
const API_URL = `https://api.lanyard.rest/v1/users/${USER_ID}`;
let currentSpotify = null;
let progressInterval = null;

function clearProgressUpdate() {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
}

async function fetchStatus() {
  try {
    const response = await fetch(API_URL);
    const data = await response.json();
    if (!data.success) throw new Error('API failed');
    renderStatus(data.data);
  } catch (error) {
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
    const activityIcon = document.getElementById('activity-icon');
    if (activityIcon) activityIcon.src = spotify.album_art_url;
    const typeEl = document.getElementById('activity-type');
    if (typeEl) { typeEl.textContent = 'Listening to Spotify'; typeEl.className = 'activity-type spotify-type'; }
    const nameEl = document.getElementById('activity-name');
    if (nameEl) nameEl.textContent = spotify.song;
    const detailEl = document.getElementById('activity-detail');
    if (detailEl) detailEl.textContent = spotify.artist;
    const progressEl = document.getElementById('progress-container');
    if (progressEl) progressEl.classList.remove('hidden');
    const activityContainer = document.getElementById('activity-container');
    if (activityContainer) activityContainer.classList.remove('hidden');
    progressInterval = setInterval(updateSpotifyProgress, 1000);
    updateSpotifyProgress();
    return;
  }

  // Update Card 2: Check for Game Activity
  const gameActivity = activities?.find(a => a.type === 0 && a.name !== 'Custom Status');
  if (gameActivity) {
    const largeImg = gameActivity.assets?.large_image;
    const appId = gameActivity.application_id;
    const activityIcon = document.getElementById('activity-icon');
    if (largeImg && !largeImg.startsWith('spotify:')) {
      if (activityIcon) activityIcon.src = `https://cdn.discordapp.com/app-assets/${appId}/${largeImg}.png?size=96`;
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
  } else {
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
    if (activityIcon) activityIcon.src = '';
    if (detailEl) detailEl.textContent = '';
    if (progressEl) progressEl.classList.add('hidden');
    // center the placeholder
    document.querySelectorAll('.activity-section').forEach(el => el.classList.add('no-activity'));
  }
}

function updateSpotifyProgress() {
  if (!currentSpotify) return;
  const progress = ((Date.now() - currentSpotify.timestamps.start) / (currentSpotify.timestamps.end - currentSpotify.timestamps.start)) * 100;
  if (progress >= 100) { fetchStatus(); return; }
  const currentTimeText = formatTime(Date.now() - currentSpotify.timestamps.start);
  const durationText = formatTime(currentSpotify.timestamps.end - currentSpotify.timestamps.start);
  const progressFill = document.getElementById('progress-fill');
  if (progressFill) progressFill.style.width = `${progress}%`;
  const currentTimeEl = document.getElementById('current-time');
  if (currentTimeEl) currentTimeEl.textContent = currentTimeText;
  const durationEl = document.getElementById('duration-time');
  if (durationEl) durationEl.textContent = durationText;
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

fetchStatus();
setInterval(fetchStatus, 5000);
setInterval(updateLiveClock, 1000);
updateLiveClock(); // initial call

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
