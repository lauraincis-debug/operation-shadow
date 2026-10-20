/* Operation Shadow — Moteur de jeu stealth */
(function(){
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, scale = 1;

  // État du jeu
  const state = { running: false, won: false, lost: false, time: 0, frame: 0 };
  const keys = {};

  // Entités
  let player = { x: 0, y: 0, r: 12, speed: 3.2 };
  let target = { x: 0, y: 0, r: 18 };
  let spotlights = [];
  let walls = [];

  function resize(){
    const area = document.getElementById('game-area');
    W = area.clientWidth;
    H = area.clientHeight;
    canvas.width = W * window.devicePixelRatio;
    canvas.height = H * window.devicePixelRatio;
    scale = window.devicePixelRatio;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function resetLevel(){
    state.running = true; state.won = false; state.lost = false; state.time = 0; state.frame = 0;
    player = { x: W * 0.15, y: H * 0.82, r: 12, speed: 3.2 };
    target = { x: W * 0.85, y: H * 0.15, r: 16 };
    // Murs simples (rectangles)
    walls = [
      { x: W*0.35, y: H*0.35, w: 100, h: 30 },
      { x: W*0.6, y: H*0.55, w: 30, h: 100 },
      { x: W*0.2, y: H*0.45, w: 20, h: 120 },
    ];
    // Spotlights mobiles
    spotlights = [
      { cx: W*0.4, cy: H*0.5, r: 70, angle: 0, speed: 0.02, dir: 1 },
      { cx: W*0.7, cy: H*0.3, r: 60, angle: Math.PI/2, speed: 0.03, dir: -1 },
      { cx: W*0.25, cy: H*0.7, r: 90, angle: Math.PI, speed: 0.015, dir: 1 },
    ];
  }

  function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }

  function rectIntersect(px, py, pw, ph, rx, ry, rw, rh){
    return px < rx+rw && px+pw > rx && py < ry+rh && py+ph > ry;
  }

  function update(){
    if(!state.running) return;
    state.frame++;
    state.time += 1/60;

    // Déplacement joueur
    let dx = 0, dy = 0;
    if(keys['ArrowUp']||keys['w']||keys['W']) dy -= 1;
    if(keys['ArrowDown']||keys['s']||keys['S']) dy += 1;
    if(keys['ArrowLeft']||keys['a']||keys['A']) dx -= 1;
    if(keys['ArrowRight']||keys['d']||keys['D']) dx += 1;
    if(dx || dy){
      let len = Math.hypot(dx, dy);
      dx = (dx/len)*player.speed; dy = (dy/len)*player.speed;
      // Collision murs
      let nx = player.x + dx, ny = player.y + dy;
      let hit = false;
      for(let w of walls){
        if(rectIntersect(nx-player.r, ny-player.r, player.r*2, player.r*2, w.x, w.y, w.w, w.h)){ hit = true; break; }
      }
      if(!hit){ player.x = nx; player.y = ny; }
    }

    // Limites
    player.x = Math.max(player.r, Math.min(W-player.r, player.x));
    player.y = Math.max(player.r, Math.min(H-player.r, player.y));

    // Spotlights
    for(let s of spotlights){
      s.angle += s.speed * s.dir;
      // Faisceau lumineux vers le centre du spot + rayon
      let sx = s.cx + Math.cos(s.angle)*s.r*0.3;
      let sy = s.cy + Math.sin(s.angle)*s.r*0.3;
    }

    // Vérification attrapage
    for(let s of spotlights){
      if(dist(player, s) < s.r*0.7) { state.lost = true; state.running = false; setTimeout(showEnd, 300); return; }
    }

    // Objectif
    if(dist(player, target) < player.r + target.r){ state.won = true; state.running = false; setTimeout(showEnd, 300); return; }
  }

  function draw(){
    ctx.clearRect(0, 0, W, H);
    // Grille subtile
    ctx.save();
    ctx.strokeStyle = 'rgba(46,207,255,.06)'; ctx.lineWidth = 1;
    for(let x=0; x<W; x+=40){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for(let y=0; y<H; y+=40){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
    ctx.restore();

    // Murs
    for(let w of walls){
      ctx.fillStyle = '#1a1c2e'; ctx.strokeStyle = '#2a2f4a'; ctx.lineWidth = 2;
      ctx.fillRect(w.x, w.y, w.w, w.h); ctx.strokeRect(w.x, w.y, w.w, w.h);
    }

    // Spotlights (cercles pulsés)
    for(let s of spotlights){
      let pulse = 1 + Math.sin(state.frame*0.05)*0.08;
      ctx.save();
      // Halo
      let g = ctx.createRadialGradient(s.cx, s.cy, 0, s.cx, s.cy, s.r*pulse);
      g.addColorStop(0, 'rgba(255,46,110,.35)'); g.addColorStop(.6, 'rgba(255,46,110,.1)'); g.addColorStop(1, 'rgba(255,46,110,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r*pulse, 0, Math.PI*2); ctx.fill();
      // Cercle central
      ctx.fillStyle = 'rgba(255,46,110,.7)'; ctx.beginPath(); ctx.arc(s.cx, s.cy, 10*pulse, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }

    // Objectif
    ctx.save();
    let pulse = 1 + Math.sin(state.frame*0.08)*0.2;
    let g = ctx.createRadialGradient(target.x, target.y, 0, target.x, target.y, target.r*2*pulse);
    g.addColorStop(0, '#2eff8a'); g.addColorStop(.4, '#2eff8a88'); g.addColorStop(1, 'transparent');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(target.x, target.y, target.r*2*pulse, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#2eff8a'; ctx.beginPath(); ctx.arc(target.x, target.y, target.r, 0, Math.PI*2); ctx.fill();
    ctx.restore();

    // Joueur (ombre / silhouette)
    ctx.save();
    ctx.shadowColor = 'rgba(46,207,255,.6)'; ctx.shadowBlur = 18;
    ctx.fillStyle = '#e8e8f0'; ctx.beginPath(); ctx.arc(player.x, player.y, player.r, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    // Cercle intérieur
    ctx.fillStyle = '#0b0c15'; ctx.beginPath(); ctx.arc(player.x, player.y, player.r*0.45, 0, Math.PI*2); ctx.fill();

    // HUD de temps sur canvas (petit coin)
    if(state.running){
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = '11px monospace';
      ctx.fillText('Temps : ' + Math.floor(state.time) + 's', 12, H-10);
    }
  }

  function loop(){
    update();
    draw();
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', () => { resize(); if(state.running) resetLevel(); });
  function showEnd(){
    const overlay = document.getElementById('overlay');
    const title = document.getElementById('overlay-title');
    const text = document.getElementById('overlay-text');
    const btn = document.getElementById('btn-start');
    overlay.classList.remove('hidden');
    if(state.won){
      title.textContent = 'Extraction réussie';
      text.textContent = 'Vous avez atteint la zone sécurisée. L\'opération Shadow est un succès.';
      btn.textContent = 'Rejouer';
    } else if(state.lost){
      title.textContent = 'Détecté';
      text.textContent = 'Un faisceau vous a repéré. L\'opération Shadow échoue. Réessayez.';
      btn.textContent = 'Recommencer';
    }
  }

  window.addEventListener('keydown', e => { keys[e.key] = true; if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault(); if(e.key === ' ' && !state.running){ resetLevel(); document.getElementById('overlay').classList.add('hidden'); } });
  window.addEventListener('keyup', e => keys[e.key] = false);

  // Initialisation
  resize();
  resetLevel();
  loop();

  // Boutons overlay
  document.getElementById('btn-start').addEventListener('click', () => { document.getElementById('overlay').classList.add('hidden'); resetLevel(); });
})();
