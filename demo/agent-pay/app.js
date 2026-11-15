(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const state = {
    slow: false,
    introPlaying: false,
    heroAnims: [],
    introAnims: [],
    introTimers: [],
    demoTimers: [],
    demoRun: 0,
    demoStarted: false,
    activeScenario: 'office',
    toastTimer: 0,
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const factor = () => (state.slow ? 2 : 1);
  const duration = (value) => reducedQuery.matches ? 0.01 : value * factor();

  function animate(element, keyframes, options = {}) {
    if (!element) return null;
    const animation = element.animate(keyframes, {
      duration: duration(options.duration ?? 400),
      delay: duration(options.delay ?? 0),
      easing: options.easing || 'cubic-bezier(.22,1,.36,1)',
      fill: options.fill || 'both',
      iterations: options.iterations || 1,
      direction: options.direction,
    });
    return animation;
  }

  function setFinal(element, styles) {
    if (!element) return;
    Object.assign(element.style, styles);
  }

  function timer(fn, delay, bucket = state.demoTimers) {
    const id = setTimeout(fn, reducedQuery.matches ? 0 : delay * factor());
    bucket.push(id);
    return id;
  }

  function clearTimers(bucket) {
    bucket.forEach((id) => clearTimeout(id));
    bucket.length = 0;
  }

  function showToast(message) {
    const toast = $('#toast');
    clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    state.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2100);
  }

  const intro = $('#intro');
  const introPaths = $$('.intro-trace');
  const introWordLeft = $('#introWordLeft');
  const introWordRight = $('#introWordRight');
  const introMark = $('#introMark');
  const introCaption = $('.intro-caption');
  const navIsland = $('#navIsland');
  const navWrap = $('.nav-wrap');
  const heroStage = $('#heroStage');
  const heroConsole = $('#heroConsole');
  const heroReceipt = $('#heroReceipt');
  const heroOrb = $('#agentOrb');
  const heroMessages = $$('[data-hero-message]');
  const heroAuth = $('[data-hero-auth]');
  const heroPills = [$('#floatPillTop'), $('#floatPillBottom')];

  function hideIntro() {
    intro.classList.add('is-hidden');
    intro.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('intro-running');
  }

  function finishIntro() {
    state.introPlaying = false;
    sessionStorage.setItem('pact:intro-played', '1');
    hideIntro();
    runHeroSequence();
    setTimeout(() => runDemoIfVisible(), 700);
  }

  function playIntro(force = false) {
    if (!force && sessionStorage.getItem('pact:intro-played') === '1') {
      hideIntro();
      runHeroSequence();
      return;
    }
    if (reducedQuery.matches) {
      finishIntro();
      showToast('已遵循系统“减少动态效果”设置');
      return;
    }
    clearTimers(state.introTimers);
    state.introAnims.forEach((animation) => animation.cancel());
    state.introAnims = [];
    state.introPlaying = true;
    intro.classList.remove('is-hidden');
    intro.removeAttribute('aria-hidden');
    document.body.classList.add('intro-running');
    introWordLeft.style.opacity = '0';
    introWordRight.style.opacity = '0';
    introCaption.style.opacity = '0';
    introPaths.forEach((path) => {
      path.style.strokeDashoffset = '1';
      path.style.opacity = '0';
    });
    introMark.style.opacity = '0';
    introMark.style.transform = 'scale(.88)';
    state.introAnims.push(
      animate(introWordLeft, [
        { translate: '-58vw 0', opacity: 0 },
        { translate: '0 0', opacity: 1, offset: .55 },
        { translate: '-18vw 0', opacity: 0 },
      ], { duration: 1700, easing: 'cubic-bezier(.12,.78,.22,1)' }),
      animate(introWordRight, [
        { translate: '58vw 0', opacity: 0 },
        { translate: '0 0', opacity: .85, offset: .55 },
        { translate: '18vw 0', opacity: 0 },
      ], { duration: 1700, easing: 'cubic-bezier(.12,.78,.22,1)' }),
      animate(introMark, [
        { opacity: 0, scale: .88 },
        { opacity: 1, scale: 1 },
      ], { duration: 520, delay: 100, easing: 'cubic-bezier(.22,1,.36,1)' }),
      animate(introCaption, [
        { opacity: 0, translate: '0 8px' },
        { opacity: 1, translate: '0 0' },
      ], { duration: 500, delay: 1050, easing: 'ease-out' })
    );
    introPaths.forEach((path, index) => {
      state.introAnims.push(animate(path, [
        { strokeDashoffset: 1, opacity: 0 },
        { strokeDashoffset: 0, opacity: 1 },
      ], { duration: 760, delay: 180 + index * 24, easing: 'cubic-bezier(.35,0,.15,1)' }));
    });
    state.introAnims.push(animate(intro, [
      { clipPath: 'inset(0 0 0 0)' },
      { clipPath: 'inset(0 0 100% 0)' },
    ], { duration: 620, delay: 1900, easing: 'cubic-bezier(.76,0,.24,1)' }));
    state.introTimers.push(setTimeout(finishIntro, 2540));
  }

  function resetHeroElements() {
    state.heroAnims.forEach((animation) => animation.cancel());
    state.heroAnims = [];
    $$('.load-title').forEach((line) => {
      line.style.opacity = '0';
      line.style.transform = 'translateX(0)';
    });
    $$('.load-reveal').forEach((element) => {
      element.style.opacity = '0';
      element.style.translate = '0 14px';
    });
    heroMessages.forEach((message) => {
      message.style.opacity = '0';
      message.style.translate = '0 12px';
      message.style.scale = '.97';
    });
    heroAuth.style.opacity = '0';
    heroReceipt.style.opacity = '0';
    heroOrb.style.opacity = '0';
    heroPills.forEach((pill) => { pill.style.opacity = '0'; });
    heroConsole.style.opacity = '0';
  }

  function runHeroSequence() {
    resetHeroElements();
    if (reducedQuery.matches) {
      $$('.load-title, .load-reveal').forEach((element) => {
        element.style.opacity = '1';
        element.style.translate = '0 0';
        element.style.transform = 'none';
      });
      heroMessages.forEach((message) => {
        message.style.opacity = '1';
        message.style.translate = '0 0';
        message.style.scale = '1';
      });
      heroAuth.style.opacity = '1';
      heroReceipt.style.opacity = '1';
      heroOrb.style.opacity = '1';
      heroConsole.style.opacity = '1';
      heroPills.forEach((pill) => { pill.style.opacity = '1'; });
      return;
    }
    state.heroAnims.push(animate(navIsland, [
      { opacity: 0, translate: '0 -24px' },
      { opacity: 1, translate: '0 0' },
    ], { duration: 620, delay: 60, easing: 'cubic-bezier(.22,1,.36,1)' }));
    $$('.load-title').forEach((line, index) => {
      const fromLeft = line.dataset.titleDirection === 'left';
      line.style.opacity = '1';
      state.heroAnims.push(animate(line, [
        { transform: `translateX(${fromLeft ? -70 : 70}%) skewX(${fromLeft ? 4 : -4}deg)`, opacity: 0 },
        { transform: 'translateX(0) skewX(0deg)', opacity: 1 },
      ], { duration: 980, delay: 80 + index * 95, easing: 'cubic-bezier(.12,.78,.22,1)' }));
    });
    $$('.load-reveal').forEach((element, index) => {
      state.heroAnims.push(animate(element, [
        { opacity: 0, translate: '0 14px' },
        { opacity: 1, translate: '0 0' },
      ], { duration: 700, delay: 330 + index * 70, easing: 'cubic-bezier(.22,1,.36,1)' }));
    });
    heroConsole.style.opacity = '1';
    state.heroAnims.push(animate(heroConsole, [
      { opacity: 0, transform: 'rotateY(-7deg) rotateX(12deg) translateY(60px) scale(.92)' },
      { opacity: 1, transform: 'rotateY(-7deg) rotateX(4deg) translateY(0) scale(1)' },
    ], { duration: 1050, delay: 380, easing: 'cubic-bezier(.22,1,.36,1)' }));
    heroMessages.forEach((message, index) => {
      message.style.opacity = '1';
      state.heroAnims.push(animate(message, [
        { opacity: 0, translate: '0 12px', scale: .97 },
        { opacity: 1, translate: '0 0', scale: 1 },
      ], { duration: 480, delay: 760 + index * 250, easing: 'cubic-bezier(.22,1,.36,1)' }));
    });
    heroAuth.style.opacity = '1';
    state.heroAnims.push(animate(heroAuth, [
      { opacity: 0, translate: '0 18px', scale: .9, rotate: '-1deg' },
      { opacity: 1, translate: '0 0', scale: 1, rotate: '0deg' },
    ], { duration: 720, delay: 1180, easing: 'cubic-bezier(.34,1.56,.64,1)' }));
    heroReceipt.style.opacity = '1';
    state.heroAnims.push(animate(heroReceipt, [
      { opacity: 0, translate: '40px 20px', rotate: '18deg', scale: .9 },
      { opacity: 1, translate: '0 0', rotate: '9deg', scale: 1 },
    ], { duration: 820, delay: 1320, easing: 'cubic-bezier(.22,1,.36,1)' }));
    heroOrb.style.opacity = '1';
    state.heroAnims.push(animate(heroOrb, [
      { opacity: 0, scale: .4, rotate: '-16deg' },
      { opacity: 1, scale: 1, rotate: '0deg' },
    ], { duration: 760, delay: 560, easing: 'cubic-bezier(.34,1.56,.64,1)' }));
    state.heroAnims.push(animate(heroOrb.querySelector('.orb-face'), [
      { scale: '1 0', opacity: 0 },
      { scale: '1 1', opacity: 1 },
    ], { duration: 420, delay: 880, easing: 'cubic-bezier(.22,1,.36,1)' }));
    heroPills.forEach((pill, index) => {
      pill.style.opacity = '1';
      state.heroAnims.push(animate(pill, [
        { opacity: 0, translate: '0 12px' },
        { opacity: 1, translate: '0 0' },
      ], { duration: 460, delay: 1500 + index * 140, easing: 'cubic-bezier(.22,1,.36,1)' }));
    });
  }

  function initAgentEyes() {
    const eyes = $$('.orb-eye');
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let raf = 0;
    const tick = () => {
      currentX += (targetX - currentX) * .12;
      currentY += (targetY - currentY) * .12;
      heroOrb.style.setProperty('--eye-x', `${currentX.toFixed(2)}px`);
      heroOrb.style.setProperty('--eye-y', `${currentY.toFixed(2)}px`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('pointermove', (event) => {
      if (reducedQuery.matches) return;
      const rect = heroOrb.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      targetX = clamp((event.clientX - cx) / 40, -4, 4);
      targetY = clamp((event.clientY - cy) / 45, -3, 3);
    }, { passive: true });
    const blink = () => {
      eyes.forEach((eye) => eye.classList.add('is-blinking'));
      setTimeout(() => eyes.forEach((eye) => eye.classList.remove('is-blinking')), 150);
      setTimeout(blink, 2600 + Math.random() * 3000);
    };
    setTimeout(blink, 1800);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else raf = requestAnimationFrame(tick);
    });
  }

  function initReveals() {
    const elements = $$('.reveal');
    if (reducedQuery.matches) {
      elements.forEach((element) => element.classList.add('is-visible', 'is-settled'));
      $$('.network-path').forEach((path) => { path.style.strokeDashoffset = '0'; });
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        setTimeout(() => entry.target.classList.add('is-settled'), 1200);
        observer.unobserve(entry.target);
      });
    }, { threshold: .12, rootMargin: '0px 0px -7% 0px' });
    elements.forEach((element) => observer.observe(element));
  }

  function initNetworkDraw() {
    const stage = $('#networkStage');
    if (!stage) return;
    const draw = () => {
      if (stage.dataset.drawn) return;
      stage.dataset.drawn = '1';
      $$('.network-path', stage).forEach((path, index) => {
        animate(path, [
          { strokeDashoffset: 1, opacity: .2 },
          { strokeDashoffset: 0, opacity: 1 },
        ], { duration: 1450, delay: index * 170, easing: 'cubic-bezier(.35,0,.15,1)' });
      });
      $$('.network-dot', stage).forEach((dot, index) => {
        animate(dot, [
          { opacity: 0, scale: 0 },
          { opacity: 1, scale: 1 },
        ], { duration: 380, delay: 420 + index * 70, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      });
    };
    if (reducedQuery.matches) {
      draw();
      return;
    }
    new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) draw();
    }, { threshold: .25 }).observe(stage);
  }

  function pressIsland() {
    animate(navIsland, [
      { translate: '0 0' },
      { translate: '0 6px', offset: .3, easing: 'cubic-bezier(.22,1,.36,1)' },
      { translate: '0 0' },
    ], { duration: 340, easing: 'ease-out' });
  }

  function initNavigation() {
    const trigger = $('#productTrigger');
    const dropdown = $('#productDropdown');
    const burger = $('#navBurger');
    const mobileMenu = $('#mobileMenu');
    const closeDropdown = () => {
      if (dropdown.hidden) return;
      trigger.setAttribute('aria-expanded', 'false');
      animate(dropdown, [
        { opacity: 1, transform: 'translateY(0) scale(1)', clipPath: 'inset(0 0 0 0 round 18px)' },
        { opacity: 0, transform: 'translateY(-6px) scale(.98)', clipPath: 'inset(0 0 100% 0 round 18px)' },
      ], { duration: 180, easing: 'ease-in' }).finished.then(() => { dropdown.hidden = true; }).catch(() => {});
    };
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      pressIsland();
      const opening = dropdown.hidden;
      if (!opening) { closeDropdown(); return; }
      dropdown.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      animate(dropdown, [
        { opacity: 0, transform: 'translateY(-8px) scale(.98)', clipPath: 'inset(0 0 100% 0 round 18px)' },
        { opacity: 1, transform: 'translateY(0) scale(1)', clipPath: 'inset(0 0 0 0 round 18px)' },
      ], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' });
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.nav-product-wrap')) closeDropdown();
    });
    burger.addEventListener('click', () => {
      const opening = mobileMenu.hidden;
      burger.setAttribute('aria-expanded', String(opening));
      if (!opening) { mobileMenu.hidden = true; return; }
      mobileMenu.hidden = false;
      animate(mobileMenu, [
        { opacity: 0, translate: '0 -8px', scale: .98 },
        { opacity: 1, translate: '0 0', scale: 1 },
      ], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' });
    });
    $$('a', mobileMenu).forEach((link) => link.addEventListener('click', () => {
      mobileMenu.hidden = true;
      burger.setAttribute('aria-expanded', 'false');
    }));
  }

  const SCENARIOS = {
    office: {
      user: '周五晚上，帮我订那家靠窗的位置。',
      agent: '找到 19:30 的双人位，人均 ¥268。需要你确认。',
      authTitle: '晚风餐厅 · 2 位',
      amount: '536.00',
      success: '已订好靠窗的位置，凭证已回传。',
      receipt: 'DINNER · FRI 19:30',
    },
    mobile: {
      user: '帮我在路上买一杯冰美式，少冰。',
      agent: '附近门店 6 分钟后可取，使用你常用的口味。',
      authTitle: 'Morrow Coffee · 大杯',
      amount: '24.00',
      success: '咖啡已下单，取餐码 A12。',
      receipt: 'COFFEE · PICKUP 18:42',
    },
    spatial: {
      user: '看一眼这副眼镜，帮我买下来。',
      agent: '识别到商品 ¥1,299，是否使用默认收货地址？',
      authTitle: 'Studio Arc · 透明镜框',
      amount: '1299.00',
      success: '订单已创建，预计明天送达。',
      receipt: 'ARRIVAL · TOMORROW',
    },
  };

  function demoMessage(role, text) {
    const row = document.createElement('div');
    row.className = `demo-msg demo-msg--${role}`;
    if (role === 'agent') {
      const avatar = document.createElement('span');
      avatar.className = 'demo-msg-avatar';
      avatar.textContent = '✳';
      row.append(avatar);
    }
    const bubble = document.createElement('div');
    bubble.className = 'demo-msg-bubble';
    const content = document.createElement('span');
    content.textContent = text;
    const time = document.createElement('small');
    time.className = 'demo-msg-time';
    time.textContent = role === 'user' ? '刚刚' : 'PACT · 0.4s';
    bubble.append(content, time);
    row.append(bubble);
    return row;
  }

  function typingRow() {
    const row = document.createElement('div');
    row.className = 'demo-msg demo-msg--agent demo-msg--typing';
    const avatar = document.createElement('span');
    avatar.className = 'demo-msg-avatar';
    avatar.textContent = '✳';
    const bubble = document.createElement('span');
    bubble.className = 'demo-typing';
    bubble.innerHTML = '<i></i><i></i><i></i>';
    row.append(avatar, bubble);
    return row;
  }

  function scrollChat() {
    const chat = $('#demoChat');
    chat.scrollTo({ top: chat.scrollHeight, behavior: reducedQuery.matches ? 'auto' : 'smooth' });
  }

  function buildAuthCard(scenario, run) {
    const auth = document.createElement('div');
    auth.className = 'demo-auth';
    auth.innerHTML = `
      <div class="demo-auth-top"><span>Payment authorization</span><span>30 sec</span></div>
      <div class="demo-auth-amount"><span>¥</span>${scenario.amount}</div>
      <div class="demo-auth-meta"><span>${scenario.authTitle}</span><span>PACT secure</span></div>
      <button class="demo-auth-btn" type="button">授权并支付 →</button>
    `;
    const button = $('button', auth);
    button.addEventListener('click', () => authorizePayment(auth, button, scenario, run));
    return auth;
  }

  function runDemo() {
    state.demoRun += 1;
    const run = state.demoRun;
    clearTimers(state.demoTimers);
    const chat = $('#demoChat');
    chat.innerHTML = '';
    chat.scrollTop = 0;
    const scenario = SCENARIOS[state.activeScenario];
    const user = demoMessage('user', scenario.user);
    chat.append(user);
    animate(user, [
      { opacity: 0, translate: '0 14px', scale: .97 },
      { opacity: 1, translate: '0 0', scale: 1 },
    ], { duration: 420, delay: 120, easing: 'cubic-bezier(.22,1,.36,1)' });
    timer(scrollChat, 200);
    const typing = typingRow();
    timer(() => {
      if (run !== state.demoRun) return;
      chat.append(typing);
      animate(typing, [
        { opacity: 0, translate: '0 10px' },
        { opacity: 1, translate: '0 0' },
      ], { duration: 280, easing: 'ease-out' });
      scrollChat();
    }, 560);
    timer(() => {
      if (run !== state.demoRun) return;
      typing.remove();
      const agent = demoMessage('agent', scenario.agent);
      chat.append(agent);
      animate(agent, [
        { opacity: 0, translate: '0 12px', scale: .97 },
        { opacity: 1, translate: '0 0', scale: 1 },
      ], { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' });
      scrollChat();
    }, 1250);
    timer(() => {
      if (run !== state.demoRun) return;
      const auth = buildAuthCard(scenario, run);
      auth.dataset.run = String(run);
      chat.append(auth);
      animate(auth, [
        { opacity: 0, translate: '0 16px', scale: .93 },
        { opacity: 1, translate: '0 0', scale: 1 },
      ], { duration: 620, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      scrollChat();
    }, 2050);
    state.demoStarted = true;
  }

  function authorizePayment(auth, button, scenario, run) {
    if (run !== state.demoRun || button.disabled) return;
    button.disabled = true;
    button.classList.add('is-processing');
    button.textContent = '处理中…';
    animate(button, [
      { scale: 1 },
      { scale: .96, offset: .35, easing: 'cubic-bezier(.22,1,.36,1)' },
      { scale: 1 },
    ], { duration: 340, easing: 'ease-out' });
    timer(() => {
      if (run !== state.demoRun) return;
      button.classList.remove('is-processing');
      button.textContent = '已授权 ✓';
      button.style.background = 'rgba(10,160,91,.22)';
      const success = document.createElement('div');
      success.className = 'demo-success';
      success.innerHTML = `<span class="success-icon">✓</span><strong>支付完成</strong><p>${scenario.success}</p>`;
      $('#demoChat').append(success);
      animate(success, [
        { opacity: 0, translate: '0 18px', scale: .92 },
        { opacity: 1, translate: '0 0', scale: 1 },
      ], { duration: 620, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      burstConfetti(success);
      const agent = demoMessage('agent', '支付结果已回传。我会继续完成接下来的安排。');
      $('#demoChat').append(agent);
      animate(agent, [
        { opacity: 0, translate: '0 12px', scale: .97 },
        { opacity: 1, translate: '0 0', scale: 1 },
      ], { duration: 420, delay: 280, easing: 'cubic-bezier(.22,1,.36,1)' });
      scrollChat();
      showToast(scenario.receipt);
    }, 950);
  }

  function burstConfetti(anchor) {
    if (reducedQuery.matches) return;
    const colors = ['#ffc947', '#087a46', '#0aa05b', '#ff7a45', '#ffffff'];
    for (let i = 0; i < 18; i += 1) {
      const piece = document.createElement('i');
      piece.className = 'confetti';
      piece.style.background = colors[i % colors.length];
      piece.style.left = '50%';
      piece.style.top = '44%';
      anchor.append(piece);
      const angle = (Math.PI * 2 * i) / 18 + Math.random() * .3;
      const distance = 38 + Math.random() * 62;
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      animate(piece, [
        { opacity: 1, transform: 'translate(0, 0) scale(1) rotate(0deg)' },
        { opacity: 0, transform: `translate(${x}px, ${y}px) scale(.2) rotate(${180 + Math.random() * 180}deg)` },
      ], { duration: 760 + Math.random() * 280, easing: 'cubic-bezier(.12,.78,.22,1)' }).finished
        .then(() => piece.remove())
        .catch(() => piece.remove());
    }
  }

  function initDemo() {
    const tabs = $$('.scenario-tab');
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      state.activeScenario = tab.dataset.scenario;
      tabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
      });
      runDemo();
    }));
    $('#replayDemo').addEventListener('click', runDemo);
    const section = $('#demo');
    if (reducedQuery.matches) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting || state.demoStarted) return;
      runDemo();
      observer.disconnect();
    }, { threshold: .22 });
    observer.observe(section);
  }

  function runDemoIfVisible() {
    if (state.demoStarted) return;
    const rect = $('#demo').getBoundingClientRect();
    if (rect.top < innerHeight * .8 && rect.bottom > 0) {
      state.demoStarted = true;
      runDemo();
    }
  }

  function initTilt() {
    if (reducedQuery.matches) return;
    $$('[data-tilt]').forEach((card) => {
      let rect = null;
      card.addEventListener('pointerenter', () => { rect = card.getBoundingClientRect(); });
      card.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'touch') return;
        rect = rect || card.getBoundingClientRect();
        const px = (event.clientX - rect.left) / rect.width;
        const py = (event.clientY - rect.top) / rect.height;
        card.style.setProperty('--rx', `${(0.5 - py) * 7}deg`);
        card.style.setProperty('--ry', `${(px - 0.5) * 9}deg`);
        card.style.setProperty('--mx', `${px * 100}%`);
        card.style.setProperty('--my', `${py * 100}%`);
      });
      const reset = () => {
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
        card.style.setProperty('--mx', '50%');
        card.style.setProperty('--my', '50%');
      };
      card.addEventListener('pointerleave', reset);
      card.addEventListener('pointercancel', reset);
    });
  }

  function initDock() {
    const notes = $('#notesPanel');
    const replay = () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      sessionStorage.removeItem('pact:intro-played');
      setTimeout(() => playIntro(true), reducedQuery.matches ? 0 : 260);
    };
    $('#replayHero').addEventListener('click', replay);
    $('#dockReplay').addEventListener('click', replay);
    $('#dockSlow').addEventListener('click', () => {
      state.slow = !state.slow;
      $('#dockSlow').setAttribute('aria-pressed', String(state.slow));
      showToast(state.slow ? '动效速度：0.5×（仅 WAAPI 序列）' : '动效速度：1×');
    });
    $('#dockNotes').addEventListener('click', () => {
      notes.classList.toggle('is-open');
      notes.setAttribute('aria-hidden', String(!notes.classList.contains('is-open')));
    });
    $('#notesClose').addEventListener('click', () => {
      notes.classList.remove('is-open');
      notes.setAttribute('aria-hidden', 'true');
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        notes.classList.remove('is-open');
        notes.setAttribute('aria-hidden', 'true');
      }
    });
  }

  function init() {
    resetHeroElements();
    initAgentEyes();
    initNavigation();
    initReveals();
    initNetworkDraw();
    initDemo();
    initTilt();
    initDock();
    requestAnimationFrame(() => playIntro(false));
    setTimeout(runDemoIfVisible, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
