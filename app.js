/**
 * Digit Span Memory Game — production-ready rewrite.
 *
 * Highlights:
 *  - All game state lives inside the DIGIT_SPAN_GAME instance; no globals.
 *  - Native Web Audio for feedback (no howler dependency). Soft sine/triangle
 *    waves with a gentle attack/release envelope for sensory-friendly UX.
 *  - SpeechSynthesis with a mobile-friendly re-initialization guard.
 *  - Precise timer driven by Date.now() + requestAnimationFrame (no setInterval drift).
 *  - Focus trapping + Escape to close on every modal (keyboard a11y).
 *  - Auto-submit once the input matches the expected sequence length.
 *  - CSV export of the full session log from the report modal.
 */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  /** Lazily create the AudioContext and resume it. */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    return this.ctx;
  }

  /** Resume the context inside a user gesture to satisfy autoplay policies. */
  unlock() {
    const ctx = this.ensure();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  /**
   * Sensory-friendly beep: sine/triangle wave with a short attack and a
   * longer release so the onset/offset is gentle, not a hard click.
   */
  beep({ freq = 700, dur = 0.18, vol = 0.06, type = "sine" } = {}) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;

      const now = ctx.currentTime;
      const attack = 0.03;
      const release = Math.min(0.12, dur);

      // Gentle attack/release envelope.
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(vol, now + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + release);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + attack + release + 0.02);
    } catch (e) {
      /* Audio can be unavailable; never let it break the game. */
    }
  }
}

class DigitSpanGame {
  STORAGE_KEY = "digit-span-farsi-v1";
  PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];
  PERSIAN_WORDS = ["صفر", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه"];

  constructor() {
    /** Centralized game state — nothing leaks into the global scope. */
    this.state = {
      mode: "forward",           // 'forward' | 'backward'
      sequence: [],
      userInput: [],
      showing: false,            // true while the sequence is being displayed
      seqLength: 2,              // current adaptive length
      seqLengthFixed: null,      // null = adaptive; number = locked length
      delayBetweenNumbers: 500,  // ms gap between displayed numbers
      score: 0,
      stars: 0,
      best: { maxLength: 2, score: 0, stars: 0 },
      audioOn: true,
      // Reporting state
      correctCount: 0,
      wrongCount: 0,
      incorrectAnswers: [],      // {expected:[], given:[]} for on-screen list
      sessionLog: [],            // full structured log for CSV export
      // Modal + timer internals
      openModal: null,
      lastFocus: null,
      timerStart: 0,
      timerShown: 0,
      timerRAF: null,
      autoSubmitTimer: null,
    };

    this.audio = new AudioEngine();
    this.el = this.cacheElements();
  }

  /** Grab every DOM node we need once up-front. */
  cacheElements() {
    const $ = (id) => document.getElementById(id);
    return {
      modeForwardBtn: $("mode-forward"),
      modeBackwardBtn: $("mode-backward"),
      tutorialBtn: $("tutorial-btn"),
      tutorialModal: $("tutorial"),
      closeTut: $("close-tut"),
      reportBtn: $("report-btn"),
      reportModal: $("report-modal"),
      closeReport: $("close-report"),
      exportCsv: $("export-csv"),
      homeBtn: $("home-btn"),
      soundToggle: $("sound-toggle"),
      resetBtn: $("reset-btn"),
      startBtn: $("start-btn"),
      submitBtn: $("submit-btn"),
      clearBtn: $("clear-btn"),
      numberDisplay: $("number-display"),
      message: $("message"),
      scoreEl: $("score"),
      levelEl: $("level"),
      starsEl: $("stars"),
      digitsContainer: $("digits"),
      timerEl: $("timer"),
      celebrate: $("celebrate"),
      startMenu: $("start-menu"),
      startModeForward: $("start-mode-forward"),
      startModeBackward: $("start-mode-backward"),
      startConfirm: $("start-confirm"),
      startSkip: $("start-skip"),
      reportCorrect: $("report-correct"),
      reportWrong: $("report-wrong"),
      reportList: $("report-list"),
      reportStudent: $("report-student"),
      reportScore: $("report-score"),
      reportMaxLevel: $("report-maxlevel"),
      profileBadge: $("profile-badge"),
      profileBadgeName: $("profile-badge-name"),
      profileModal: $("profile-modal"),
      profileNameInput: $("profile-name-input"),
      profileAdd: $("profile-add"),
      profileList: $("profile-list"),
      closeProfile: $("close-profile"),
      startProfileSelect: $("start-profile-select"),
      startProfileManage: $("start-profile-manage"),
    };
  }

  // ---------------------------------------------------------------- Init
  init() {
    this.loadProgress();
    this.buildDigitButtons();
    this.bindEvents();
    this.bindUnlockHandlers();

    // Default active length selection on the start menu.
    const autoBtn = document.querySelector('.length-btn[data-length="auto"]');
    if (autoBtn) {
      document.querySelectorAll(".length-btn").forEach((b) => b.classList.remove("is-active"));
      autoBtn.classList.add("is-active");
    }

    // Default active delay selection on the start menu.
    const defaultDelayBtn = document.querySelector('.delay-btn[data-delay="500"]');
    if (defaultDelayBtn) {
      defaultDelayBtn.classList.add("is-active");
    }

    // Sync the topbar mode without resetting the very first round.
    this.setMode(this.state.mode, false);

    this.updateProfileBadge();
    this.renderProfileList();
    this.renderStartProfileSelect();

    // On first launch there is no active profile → prompt for a student name.
    // Otherwise open the start menu directly.
    if (this.activeProfileName) {
      this.openModal(this.el.startMenu);
    } else {
      this.openProfileModal();
    }
  }

  bindEvents() {
    // Start menu mode toggle.
    this.el.startModeForward.addEventListener("click", () => this.setStartMode("forward"));
    this.el.startModeBackward.addEventListener("click", () => this.setStartMode("backward"));

    // Length buttons just toggle their active state.
    document.querySelectorAll(".length-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".length-btn").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
      });
    });

    // Delay buttons just toggle their active state.
    document.querySelectorAll(".delay-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".delay-btn").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
      });
    });

    this.el.startConfirm.addEventListener("click", () => this.confirmStart());
    this.el.startSkip.addEventListener("click", () => {
      if (!this.activeProfileName) return;
      this.state.delayBetweenNumbers = 500;
      this.closeModal(this.el.startMenu);
      this.resetRound();
    });

    // Profile management.
    this.el.profileBadge.addEventListener("click", () => this.openProfileModal());
    this.el.closeProfile.addEventListener("click", () => this.closeModal(this.el.profileModal));
    this.el.profileAdd.addEventListener("click", () => {
      this.createProfile(this.el.profileNameInput.value);
    });
    this.el.profileNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.el.profileAdd.click();
      }
    });
    this.el.startProfileManage.addEventListener("click", () => this.openProfileModal());
    this.el.startProfileSelect.addEventListener("change", () => {
      const name = this.el.startProfileSelect.value;
      if (name && this.profiles[name]) this.switchProfile(name);
    });

    // Topbar.
    this.el.modeForwardBtn.addEventListener("click", () => this.setMode("forward"));
    this.el.modeBackwardBtn.addEventListener("click", () => this.setMode("backward"));
    this.el.tutorialBtn.addEventListener("click", () => this.openModal(this.el.tutorialModal));
    this.el.closeTut.addEventListener("click", () => this.closeModal(this.el.tutorialModal));
    this.el.reportBtn.addEventListener("click", () => {
      this.updateReportUI();
      this.openModal(this.el.reportModal);
    });
    this.el.closeReport.addEventListener("click", () => this.closeModal(this.el.reportModal));
    this.el.exportCsv.addEventListener("click", () => this.exportCSV());
    this.el.homeBtn.addEventListener("click", () => this.goHome());
    this.el.soundToggle.addEventListener("click", () => this.toggleSound());
    this.el.resetBtn.addEventListener("click", () => this.resetProgress());

    // Game flow.
    this.el.startBtn.addEventListener("click", () => this.startRound());
    this.el.submitBtn.addEventListener("click", () => this.submitAnswer());
    this.el.clearBtn.addEventListener("click", () => this.clearInput());

    // Global keyboard handling: modal trapping + digit shortcuts.
    window.addEventListener("keydown", (e) => this.onKeydown(e));
  }

  /**
   * AudioContext and SpeechSynthesis can only start inside a user gesture on
   * mobile. Unlock them on the very first interaction.
   */
  bindUnlockHandlers() {
    const unlock = () => {
      this.audio.unlock();
      if ("speechSynthesis" in window) {
        try {
          window.speechSynthesis.resume();
        } catch (e) {}
      }
    };
    ["pointerdown", "keydown", "touchstart"].forEach((evt) =>
      document.addEventListener(evt, unlock, { once: true })
    );
  }

  // ------------------------------------------------------------- Modals
  openModal(modal) {
    // Only one modal open at a time; remember where focus was so we can
    // return the user to it when the modal closes (a11y best practice).
    if (this.state.openModal) this.closeModal(this.state.openModal);
    this.state.lastFocus = document.activeElement;

    modal.classList.add("modal--open");
    modal.setAttribute("aria-hidden", "false");
    this.state.openModal = modal;

    const first = this.focusablesIn(modal)[0];
    if (first) first.focus();
  }

  closeModal(modal) {
    modal.classList.remove("modal--open");
    modal.setAttribute("aria-hidden", "true");
    if (this.state.openModal === modal) this.state.openModal = null;

    const prev = this.state.lastFocus;
    if (prev && document.contains(prev)) prev.focus();
    this.state.lastFocus = null;
  }

  /** Live, enabled, visible focusable elements inside a container. */
  focusablesIn(container) {
    const nodes = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    return Array.from(nodes).filter(
      (el) => !el.disabled && el.offsetParent !== null
    );
  }

  /** Trap the Tab key inside the currently open modal. */
  trapFocusIn(modal) {
    const focusable = this.focusablesIn(modal);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const isInside = modal.contains(active);

    if (this._shiftKeyHeld) {
      if (active === first || !isInside) {
        this._shiftKeyHeld = false;
        last.focus();
      }
    } else {
      if (active === last || !isInside) {
        first.focus();
      }
    }
  }

  onKeydown(e) {
    this._shiftKeyHeld = e.shiftKey;

    // When a modal is open: trap Tab, and allow Escape to close tutorial/report.
    if (this.state.openModal) {
      if (e.key === "Tab") {
        e.preventDefault();
        this.trapFocusIn(this.state.openModal);
        return;
      }
      if (e.key === "Escape" && this.state.openModal !== this.el.startMenu) {
        this.closeModal(this.state.openModal);
      }
      return; // keep digits/Enter from "typing" into the game behind a modal
    }

    // No modal open → digit shortcuts and global Enter/Backspace.
    if (e.key >= "1" && e.key <= "9") {
      this.onDigitPress(Number(e.key));
    } else if (e.key === "Enter") {
      if (!this.el.startBtn.disabled && !this.state.showing) this.startRound();
      else if (!this.el.submitBtn.disabled) this.submitAnswer();
    } else if (e.key === "Backspace") {
      this.clearInput();
    }
  }

  // ------------------------------------------------------------ Start
  confirmStart() {
    const selected = document.querySelector(".length-btn.is-active");
    if (selected && selected.dataset.length === "auto") {
      this.state.seqLengthFixed = null;
    } else if (selected) {
      this.state.seqLengthFixed = Math.max(2, Math.min(10, Number(selected.dataset.length)));
    } else {
      this.state.seqLengthFixed = null;
    }

    const delayBtn = document.querySelector(".delay-btn.is-active");
    this.state.delayBetweenNumbers = delayBtn ? Number(delayBtn.dataset.delay) : 500;

    // Small confirmation animation (CSS transition on transform).
    this.el.startConfirm.animate(
      [{ transform: "scale(1)" }, { transform: "scale(0.96)" }, { transform: "scale(1)" }],
      { duration: 420, iterations: 1 }
    );

    this.closeModal(this.el.startMenu);

    this.el.message.innerText = "آماده شدیم! کمی صبر کن...";
    setTimeout(() => {
      this.resetRound();
      this.startRound();
    }, 600);
  }

  setStartMode(m) {
    this.el.startModeForward.classList.toggle("is-active", m === "forward");
    this.el.startModeBackward.classList.toggle("is-active", m === "backward");
    this.setMode(m, false);
  }

  setMode(m, reset = true) {
    this.state.mode = m;
    this.el.modeForwardBtn.classList.toggle("is-active", m === "forward");
    this.el.modeBackwardBtn.classList.toggle("is-active", m === "backward");
    if (reset) this.resetRound();
  }

  goHome() {
    this.state.seqLengthFixed = null;
    this.resetRound();
    this.renderStartProfileSelect();
    this.openModal(this.el.startMenu);
  }

  toggleSound() {
    this.state.audioOn = !this.state.audioOn;
    this.audio.enabled = this.state.audioOn;
    this.el.soundToggle.innerText = this.state.audioOn ? "🔊" : "🔈";
  }

  resetProgress() {
    if (!this.activeProfileName) return;
    if (!confirm(`آیا می‌خواهی پیشرفت دانش‌آموز «${this.activeProfileName}» پاک شود؟`)) return;
    this.profiles[this.activeProfileName] = this.defaultProfile();
    this.loadProfileIntoState(this.activeProfileName);
    this.resetRound();
    this.saveProgress();
    this.renderProfileList();
    this.updateProfileBadge();
  }

  // --------------------------------------------------------- Persistence
  /** A fresh, empty profile. */
  defaultProfile() {
    return {
      score: 0,
      seqLength: 2,
      stars: 0,
      best: { maxLength: 2, score: 0, stars: 0 },
      correctCount: 0,
      wrongCount: 0,
      incorrectAnswers: [],
      lastPlayed: null,
    };
  }

  loadProgress() {
    this.profiles = {};
    this.activeProfileName = null;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.profiles && typeof data.profiles === "object") {
          // New multi-profile format.
          this.profiles = data.profiles;
          this.activeProfileName = data.activeProfileName || null;
        } else if (data && data.best) {
          // Legacy single-user format → migrate into one profile.
          this.profiles = {
            "دانش‌آموز": {
              score: data.score || 0,
              seqLength: data.seqLength || 2,
              stars: data.stars || 0,
              best: data.best || this.defaultProfile().best,
              correctCount: 0,
              wrongCount: 0,
              incorrectAnswers: [],
              lastPlayed: data.savedAt || null,
            },
          };
          this.activeProfileName = "دانش‌آموز";
        }
      }
    } catch (e) {
      /* Corrupt or blocked storage — start fresh. */
    }

    // Drop references to names that no longer resolve; pick a fallback.
    if (!this.profiles[this.activeProfileName]) {
      const names = Object.keys(this.profiles);
      this.activeProfileName = names.length ? names[0] : null;
    }
    if (this.activeProfileName) {
      this.loadProfileIntoState(this.activeProfileName);
    }
    this.refreshUI();
  }

  /** Copy the active profile's persisted fields into the live state. */
  loadProfileIntoState(name) {
    const p = this.profiles[name] || this.defaultProfile();
    this.state.score = p.score;
    this.state.seqLength = p.seqLength;
    this.state.stars = p.stars;
    this.state.best = { ...p.best };
    this.state.correctCount = p.correctCount;
    this.state.wrongCount = p.wrongCount;
    this.state.incorrectAnswers = p.incorrectAnswers.slice();
    this.state.sessionLog = [];
    this.state.userInput = [];
    this.state.sequence = [];
    this.state.showing = false;
    this.state.seqLengthFixed = null;
    this.resetRound();
  }

  /** Write the live state back into the active profile's data block. */
  saveActiveProfile() {
    if (!this.activeProfileName || !this.profiles[this.activeProfileName]) return;
    const p = this.profiles[this.activeProfileName];
    p.score = this.state.score;
    p.seqLength = this.state.seqLength;
    p.stars = this.state.stars;
    p.best = { ...this.state.best };
    p.correctCount = this.state.correctCount;
    p.wrongCount = this.state.wrongCount;
    p.incorrectAnswers = this.state.incorrectAnswers.slice();
    p.lastPlayed = Date.now();
  }

  /** Save safely; never crashes in Incognito/full-storage scenarios. */
  saveProgress() {
    this.saveActiveProfile();
    try {
      const payload = {
        activeProfileName: this.activeProfileName,
        profiles: this.profiles,
        savedAt: Date.now(),
      };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn("Progress could not be saved:", e);
    }
  }

  // ----------------------------------------------------------- Profiles
  switchProfile(name) {
    if (!this.profiles[name] || name === this.activeProfileName) {
      if (this.profiles[name]) this.closeModal(this.el.profileModal);
      return;
    }
    this.saveActiveProfile();
    this.activeProfileName = name;
    this.loadProfileIntoState(name);
    this.saveProgress();
    this.refreshUI();
    this.updateProfileBadge();
    this.renderProfileList();
    this.renderStartProfileSelect();
    this.closeModal(this.el.profileModal);
  }

  createProfile(rawName) {
    const name = (rawName || "").trim();
    if (!name) return null;
    // Reusing an existing name just activates it.
    if (this.profiles[name]) {
      this.switchProfile(name);
      return name;
    }
    this.profiles[name] = this.defaultProfile();
    this.activeProfileName = name;
    this.loadProfileIntoState(name);
    this.saveProgress();
    this.refreshUI();
    this.updateProfileBadge();
    this.renderProfileList();
    this.renderStartProfileSelect();
    this.closeModal(this.el.profileModal);
    this.openModal(this.el.startMenu);
    return name;
  }

  deleteProfile(name) {
    if (!this.profiles[name]) return;
    delete this.profiles[name];

    if (this.activeProfileName === name) {
      const remaining = Object.keys(this.profiles);
      this.activeProfileName = remaining.length ? remaining[0] : null;
    }

    if (this.activeProfileName) {
      this.loadProfileIntoState(this.activeProfileName);
      this.refreshUI();
      this.resetRound();
    }

    this.saveProgress();
    this.updateProfileBadge();
    this.renderProfileList();
    this.renderStartProfileSelect();

    // If no profiles remain, keep the modal open so one can be created.
    if (!this.activeProfileName) {
      this.openProfileModal();
    }
  }

  confirmDeleteProfile(name) {
    if (!confirm(`آیا مطمئنی که پروفایل «${name}» حذف شود؟`)) return;
    this.deleteProfile(name);
  }

  openProfileModal() {
    this.renderProfileList();
    if (this.el.profileNameInput) this.el.profileNameInput.value = "";
    this.openModal(this.el.profileModal);
  }

  updateProfileBadge() {
    const name = this.activeProfileName || "—";
    this.el.profileBadgeName.innerText = name;
    this.el.profileBadge.classList.toggle("is-active", !!this.activeProfileName);
  }

  renderProfileList() {
    const list = this.el.profileList;
    list.innerHTML = "";
    const names = Object.keys(this.profiles);

    if (names.length === 0) {
      const empty = document.createElement("div");
      empty.className = "profile-empty";
      empty.innerText = "هنوز کاربری ساخته نشده است. نام اولین دانش‌آموز را وارد کن.";
      list.appendChild(empty);
      return;
    }

    names.forEach((name) => {
      const p = this.profiles[name];
      const card = document.createElement("div");
      card.className = "profile-card";
      if (name === this.activeProfileName) card.classList.add("is-active");

      const head = document.createElement("div");
      head.className = "profile-card__head";
      const title = document.createElement("span");
      title.className = "profile-card__name";
      title.innerText = name;
      head.appendChild(title);
      if (name === this.activeProfileName) {
        const tag = document.createElement("span");
        tag.className = "profile-card__tag";
        tag.innerText = "فعال";
        head.appendChild(tag);
      }

      const meta = document.createElement("div");
      meta.className = "profile-card__meta";
      meta.innerText = `امتیاز ${this.toPersianNumber(p.score)} • مرحله ${this.toPersianNumber(p.seqLength)} • ${this.starsText(p.stars)}`;

      const actions = document.createElement("div");
      actions.className = "profile-card__actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "big-btn big-btn--primary";
      selectBtn.innerText = "انتخاب";
      selectBtn.addEventListener("click", () => this.switchProfile(name));

      const reportBtn = document.createElement("button");
      reportBtn.type = "button";
      reportBtn.className = "big-btn big-btn--secondary";
      reportBtn.innerText = "مشاهده گزارش";
      reportBtn.addEventListener("click", () => {
        if (name !== this.activeProfileName) this.switchProfile(name);
        this.closeModal(this.el.profileModal);
        this.updateReportUI();
        this.openModal(this.el.reportModal);
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "big-btn big-btn--danger";
      delBtn.innerText = "حذف";
      delBtn.addEventListener("click", () => this.confirmDeleteProfile(name));

      actions.append(selectBtn, reportBtn, delBtn);
      card.append(head, meta, actions);
      list.appendChild(card);
    });
  }

  renderStartProfileSelect() {
    const sel = this.el.startProfileSelect;
    sel.innerHTML = "";
    const names = Object.keys(this.profiles);
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = this.activeProfileName || "";
    sel.disabled = names.length === 0;
    this.el.startConfirm.disabled = !this.activeProfileName;
  }

  // ---------------------------------------------------------- Digit pad
  buildDigitButtons() {
    for (let i = 1; i <= 9; i++) {
      const btn = document.createElement("button");
      btn.className = "digit-btn";
      btn.type = "button";
      btn.dataset.value = String(i);
      btn.innerText = this.toPersianDigit(i);
      btn.addEventListener("click", () => this.onDigitPress(i));
      this.el.digitsContainer.appendChild(btn);
    }
  }

  // ----------------------------------------------------------- Game flow
  startRound() {
    this.el.startBtn.disabled = true;
    this.el.submitBtn.disabled = true;
    this.el.clearBtn.disabled = true;
    this.state.userInput = [];
    this.state.sequence = this.generateSequence(this.state.seqLengthFixed || this.state.seqLength);
    this.state.showing = true;
    this.el.message.innerText = "به عددها خوب نگاه کن...";

    this.playSequence(this.state.sequence).then(() => {
      this.state.showing = false;
      this.el.message.innerText = "حالا وارد کن!";
      this.enableInput(true);
      this.startTimer();
    });
  }

  resetRound() {
    this.clearAutoSubmit();
    this.stopTimer();
    this.el.startBtn.disabled = false;
    this.el.submitBtn.disabled = true;
    this.el.clearBtn.disabled = true;
    this.state.userInput = [];
    this.state.sequence = [];
    this.state.showing = false;
    this.el.message.innerText = "آماده‌ای؟ شروع کن!";
    this.el.numberDisplay.innerText = "";
    this.refreshUI();
  }

  generateSequence(len) {
    const seq = [];
    for (let i = 0; i < len; i++) seq.push(Math.floor(Math.random() * 9) + 1);
    return seq;
  }

  async playSequence(seq) {
    this.el.numberDisplay.innerText = "";
    this.stopTimer();
    for (let i = 0; i < seq.length; i++) {
      await this.showNumber(seq[i]);
      await this.delay(this.state.delayBetweenNumbers);
    }
    await this.delay(400);
  }

  showNumber(n) {
    return new Promise((resolve) => {
      const display = this.el.numberDisplay;
      display.innerText = this.toPersianDigit(n);
      display.animate(
        [
          { transform: "translateX(18px) translateY(-18px) scale(0.9)", opacity: 0 },
          { transform: "translateX(0) translateY(0) scale(1.05)", opacity: 1 },
          { transform: "translateX(-6px) translateY(-6px) scale(1)", opacity: 1 },
        ],
        { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
      if (this.state.audioOn) this.speakNumber(n);
      // Soft, low-amplitude, randomized pitch — never harsh.
      this.audio.beep({ freq: 600 + Math.random() * 500, dur: 0.18, vol: 0.035, type: "triangle" });

      setTimeout(() => {
        display.innerText = "";
        resolve();
      }, 520);
    });
  }

  /** Persian number speech with a mobile re-initialization guard. */
  speakNumber(n) {
    if (!("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;
    const msg = new SpeechSynthesisUtterance(this.PERSIAN_WORDS[n]);
    msg.lang = "fa-IR";
    msg.rate = 0.9;

    // Some mobile browsers stall after cancel; resume re-primes the queue.
    try {
      if (synth.speaking || synth.pending) synth.cancel();
      synth.resume();
      synth.speak(msg);
    } catch (e) {
      /* Speech is optional — never break the game over it. */
    }
  }

  delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // -------------------------------------------------------------- Input
  onDigitPress(n) {
    const s = this.state;
    if (s.showing) return;                       // don't accept during playback
    if (this.el.startBtn.disabled === false) return; // ignore unless started
    if (s.userInput.length >= s.sequence.length) return;

    s.userInput.push(n);
    this.updateInputUI();
    if (s.audioOn) this.speakNumber(n);
    this.audio.beep({ freq: 900, dur: 0.07, vol: 0.05 });

    this.enableInput(true);

    // Auto-submit once the answer reaches the full expected length.
    if (s.userInput.length === s.sequence.length) this.scheduleAutoSubmit();
  }

  scheduleAutoSubmit() {
    this.clearAutoSubmit();
    this.state.autoSubmitTimer = setTimeout(() => this.submitAnswer(), 300);
  }

  clearAutoSubmit() {
    if (this.state.autoSubmitTimer) {
      clearTimeout(this.state.autoSubmitTimer);
      this.state.autoSubmitTimer = null;
    }
  }

  updateInputUI() {
    // Render input visually right-to-left (first pressed at the right).
    const display = this.el.numberDisplay;
    display.innerText = this.state.userInput.map(this.toPersianDigit.bind(this)).slice().reverse().join(" ");
    try {
      display.animate(
        [{ transform: "translateX(14px)", opacity: 0.2 }, { transform: "translateX(0)", opacity: 1 }],
        { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
    } catch (e) {}
  }

  enableInput(enable) {
    document.querySelectorAll(".digit-btn").forEach((b) => (b.disabled = !enable));
    this.el.submitBtn.disabled = !enable;
    this.el.clearBtn.disabled = !enable;
  }

  clearInput() {
    this.clearAutoSubmit();
    this.state.userInput = [];
    this.updateInputUI();
    this.el.submitBtn.disabled = true;
    this.el.clearBtn.disabled = true;
  }

  // ------------------------------------------------------------ Submit
  submitAnswer() {
    const s = this.state;
    this.clearAutoSubmit();
    this.stopTimer();
    this.enableInput(false);

    const correct = this.checkAnswer();
    const expected = s.mode === "forward" ? s.sequence : [...s.sequence].reverse();

    // Append a structured, timestamped row to the session log (CSV source).
    s.sessionLog.push({
      timeIso: new Date().toISOString(),
      result: correct ? "correct" : "wrong",
      mode: s.mode,
      length: s.sequence.length,
      expected: expected.join(" "),
      given: s.userInput.join(" "),
    });

    if (correct) this.onCorrect();
    else this.onWrong();

    this.saveProgress();
    setTimeout(() => this.resetRound(), 1200);
  }

  checkAnswer() {
    const expected = this.state.mode === "forward" ? this.state.sequence : [...this.state.sequence].reverse();
    if (this.state.userInput.length !== expected.length) return false;
    return this.state.userInput.every((v, i) => Number(v) === Number(expected[i]));
  }

  onCorrect() {
    const s = this.state;
    this.el.message.innerText = "عالی! آفرین!";
    this.celebrateFlash();
    s.score += s.seqLength * 10;
    s.seqLength = Math.min(s.seqLength + 1, 9);
    s.stars = this.computeStars(s.score);
    if (s.seqLength > s.best.maxLength) s.best.maxLength = s.seqLength;
    if (s.score > s.best.score) s.best.score = s.score;
    if (s.stars > s.best.stars) s.best.stars = s.stars;
    s.correctCount++;
    this.audio.beep({ freq: 1200, dur: 0.18, vol: 0.05 });
    this.updateProgressUI();
  }

  onWrong() {
    const s = this.state;
    this.el.message.innerText = "خیلی خوب تلاش کردی! می‌خوای دوباره امتحان کنی؟";
    const expected = s.mode === "forward" ? s.sequence.slice() : [...s.sequence].reverse();
    s.incorrectAnswers.push({ expected: expected.slice(), given: s.userInput.slice() });
    s.wrongCount++;
    if (s.seqLength > 2) s.seqLength = Math.max(2, s.seqLength - 1);
    this.audio.beep({ freq: 300, dur: 0.2, vol: 0.045, type: "sine" });
    this.updateProgressUI();
  }

  computeStars(sc) {
    if (sc < 100) return 0;
    if (sc < 250) return 1;
    if (sc < 500) return 2;
    return 3;
  }

  updateProgressUI() {
    this.el.scoreEl.innerText = this.state.score;
    this.el.levelEl.innerText = this.state.seqLength;
    this.el.starsEl.innerText = this.starsText(this.state.stars);
  }

  refreshUI() {
    this.updateProgressUI();
  }

  starsText(count) {
    return ("★".repeat(count) + "☆".repeat(3 - count)).slice(0, 3);
  }

  // ------------------------------------------------------------- Report
  updateReportUI() {
    const s = this.state;
    this.el.reportStudent.innerText = `دانش‌آموز: ${this.activeProfileName || "—"}`;
    this.el.reportScore.innerText = this.toPersianNumber(s.score);
    this.el.reportMaxLevel.innerText = this.toPersianNumber(s.best.maxLength);
    this.el.reportCorrect.innerText = this.toPersianNumber(s.correctCount);
    this.el.reportWrong.innerText = this.toPersianNumber(s.wrongCount);

    if (s.incorrectAnswers.length === 0) {
      this.el.reportList.innerText = "هنوز مورد نادرستی ثبت نشده.";
      return;
    }
    const lines = s.incorrectAnswers.slice(-6).map((it, idx) => {
      const exp = it.expected.map(this.toPersianDigit.bind(this)).join(" ");
      const giv = it.given.map(this.toPersianDigit.bind(this)).join(" ");
      return `${this.toPersianNumber(idx + 1)}. انتظار: ${exp} — وارد شده: ${giv}`;
    });
    this.el.reportList.innerText = lines.reverse().join("\n");
  }

  /**
   * Build a UTF-8 CSV (with BOM so Excel opens it correctly) of the whole
   * session log and trigger a download. Values are escaped for safety.
   */
  exportCSV() {
    const header = ["timestamp", "result", "mode", "length", "expected", "given"];
    const rows = this.state.sessionLog.map((e) => [
      e.timeIso,
      e.result,
      e.mode,
      e.length,
      e.expected,
      e.given,
    ]);
    const csvEscape = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = "\uFEFF" + [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `digit-span-report-${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ------------------------------------------------------------- Timer
  /** Precision timer: rAF loop computing elapsed time from Date.now(). */
  startTimer() {
    this.stopTimer();
    this.state.timerStart = Date.now();
    this.state.timerShown = 0;
    this.el.timerEl.innerText = `⏱ ${this.toPersianNumber(0)}`;

    const update = () => {
      if (this.state.timerRAF === null) return;
      const elapsed = Math.floor((Date.now() - this.state.timerStart) / 1000);
      if (elapsed !== this.state.timerShown) {
        this.state.timerShown = elapsed;
        this.el.timerEl.innerText = `⏱ ${this.toPersianNumber(elapsed)}`;
      }
      this.state.timerRAF = requestAnimationFrame(update);
    };
    this.state.timerRAF = requestAnimationFrame(update);
  }

  stopTimer() {
    if (this.state.timerRAF !== null) {
      cancelAnimationFrame(this.state.timerRAF);
      this.state.timerRAF = null;
    }
  }

  // -------------------------------------------------------- Formatting
  toPersianDigit(n) {
    return this.PERSIAN_DIGITS[String(n)];
  }

  toPersianNumber(n) {
    return String(n)
      .split("")
      .map((ch) => (/\d/.test(ch) ? this.PERSIAN_DIGITS[ch] : ch))
      .join("");
  }

  // ------------------------------------------------------- Celebration
  celebrateFlash() {
    const c = this.el.celebrate;
    c.classList.add("celebrate--show");
    c.setAttribute("aria-hidden", "false");
    setTimeout(() => {
      c.classList.remove("celebrate--show");
      c.setAttribute("aria-hidden", "true");
    }, 1400);
  }
}

// Bootstrap.
const DIGIT_SPAN_GAME = new DigitSpanGame();
DIGIT_SPAN_GAME.init();
