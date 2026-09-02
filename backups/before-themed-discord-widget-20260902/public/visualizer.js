const canvas = document.querySelector('#visualizer');
const ctx = canvas.getContext('2d');
const status = document.querySelector('#status');
const songTitle = document.querySelector('#song-title');
const songTitleText = document.querySelector('#song-title-text');
const copyHint = document.querySelector('#copy-hint');
let target = Array(64).fill(0);
let shown = Array(64).fill(0);
let connected = false;
let active = false;

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

function connect() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  socket.onopen = () => { connected = true; status.textContent = 'Waiting for Rythm…'; };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'spectrum') target = message.bands;
    if (message.type === 'track' && message.track) {
      songTitleText.textContent = message.track.title;
      if (message.track.url) {
        songTitle.href = message.track.url;
        songTitle.classList.add('has-link');
      } else {
        songTitle.removeAttribute('href');
        songTitle.classList.remove('has-link');
      }
      updateTitleOverflow();
    }
    if ('active' in message) active = message.active;
    status.textContent = active ? '♫ Rythm reactive ♫' : 'Waiting for Rythm…';
  };
  socket.onclose = () => {
    connected = false;
    active = false;
    status.textContent = 'Analyzer disconnected — retrying…';
    setTimeout(connect, 1500);
  };
}
connect();

function updateTitleOverflow() {
  songTitle.classList.remove('is-scrolling');
  songTitle.style.removeProperty('--scroll-distance');
  songTitle.style.removeProperty('--scroll-duration');
  requestAnimationFrame(() => {
    const distance = Math.ceil(songTitleText.scrollWidth - songTitle.clientWidth);
    if (distance <= 1) return;
    songTitle.style.setProperty('--scroll-distance', `-${distance}px`);
    songTitle.style.setProperty('--scroll-duration', `${Math.max(8, distance / 35 + 4)}s`);
    songTitle.classList.add('is-scrolling');
  });
}

addEventListener('resize', updateTitleOverflow);

songTitle.addEventListener('click', async event => {
  event.preventDefault();
  const title = songTitleText.textContent.trim();
  if (!title || title === 'Waiting for Rythm…') return;
  try {
    await navigator.clipboard.writeText(title);
  } catch {
    const input = document.createElement('textarea');
    input.value = title;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  copyHint.textContent = '𓆩TITLE COPIED𓆪';
  clearTimeout(copyHint.resetTimer);
  copyHint.resetTimer = setTimeout(() => {
    copyHint.textContent = '𓆩CLICK ON THE TITLE TO COPY IT𓆪';
  }, 1600);
});

function draw(time) {
  const w = innerWidth;
  const h = innerHeight;
  ctx.clearRect(0, 0, w, h);
  if (shown.length !== target.length) shown = Array(target.length).fill(0);
  const gap = Math.max(2, w * 0.0025);
  const barWidth = Math.max(2, (w * 0.92 - gap * (target.length - 1)) / target.length);
  const left = (w - (barWidth + gap) * target.length + gap) / 2;
  const center = h * 0.68;
  const maxHeight = h * 0.5;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < target.length; i += 1) {
    const idle = connected ? 0.025 + Math.sin(time / 700 + i * .4) * .012 : 0;
    const desired = active ? Math.max(target[i], idle) : idle;
    shown[i] += (desired - shown[i]) * (desired > shown[i] ? .32 : .09);
    const height = Math.max(3, shown[i] * maxHeight);
    const gradient = ctx.createLinearGradient(0, center, 0, center - height);
    const pulse = Math.sin(time / 900 + i * .18) * 8;
    gradient.addColorStop(0, 'rgba(92,0,14,.76)');
    gradient.addColorStop(.65, `hsl(${356 + pulse / 8},100%,43%)`);
    gradient.addColorStop(.92, 'rgb(255,48,58)');
    gradient.addColorStop(1, 'rgb(255,230,222)');
    ctx.shadowColor = 'rgba(225,0,25,.9)';
    ctx.shadowBlur = 15;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(left + i * (barWidth + gap), center - height, barWidth, height, barWidth / 2);
    ctx.fill();
    ctx.globalAlpha = .20;
    ctx.fillRect(left + i * (barWidth + gap), center + 7, barWidth, height * .3);
    ctx.globalAlpha = 1;
  }
  ctx.globalCompositeOperation = 'source-over';
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
