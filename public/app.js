(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.add("js");

  var scene = document.getElementById("scene");
  var dogButton = document.getElementById("dog-trigger");
  var ctaButton = document.getElementById("how-it-works");
  var pilotPanel = document.getElementById("pilot");
  var pupils = document.getElementById("pupils");
  var hint = document.querySelector(".hint");
  var STATES = {
    HOME: "home",
    HOPPING_RIGHT: "hopping-right",
    RIGHT: "right",
    APPROACHING: "approaching",
    NETWORK: "network",
    RETURNING: "returning"
  };
  var state = STATES.HOME;
  var transitionTimer = null;
  var transitionToken = 0;

  var HOME_LABEL = "Pati Hattı'nın nasıl çalıştığını gör";
  var RIGHT_LABEL = "Pati Hattı'nın klinik ağını gör";
  var NETWORK_LABEL = "Eve dön";
  var NETWORK_HINT = "Eve dönmek için köpeğe dokunun 🐾";
  var RIGHT_HINT = "Devam etmek için köpeğe tekrar dokunun 🐾";
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function render() {
    scene.dataset.state = state;

    var transitioning = state === STATES.HOPPING_RIGHT || state === STATES.APPROACHING || state === STATES.RETURNING;
    var label = state === STATES.NETWORK || state === STATES.RETURNING
      ? NETWORK_LABEL
      : state === STATES.RIGHT || state === STATES.APPROACHING
        ? RIGHT_LABEL
        : HOME_LABEL;
    dogButton.setAttribute("aria-label", label);
    dogButton.disabled = transitioning;
    ctaButton.disabled = transitioning;
    ctaButton.textContent = state === STATES.RIGHT ? "Klinik ağını gör" : "Nasıl çalışır?";
    hint.textContent = state === STATES.NETWORK ? NETWORK_HINT : state === STATES.RIGHT ? RIGHT_HINT : "";

    var revealed = state === STATES.NETWORK;
    pilotPanel.dataset.revealed = String(revealed);
    pilotPanel.setAttribute("aria-hidden", String(!revealed));
    pilotPanel.inert = !revealed;
  }

  function clearTransitionTimer() {
    if (transitionTimer !== null) {
      window.clearTimeout(transitionTimer);
      transitionTimer = null;
    }
  }

  function finishTransition(settledState, token) {
    if (token !== transitionToken) return;

    clearTransitionTimer();
    state = settledState;
    render();
    dogButton.focus({ preventScroll: true });
  }

  function beginTransition(transitioningTo, settledState, durationMs) {
    state = transitioningTo;
    render();

    if (reducedMotion) {
      transitionToken += 1;
      state = settledState;
      render();
      dogButton.focus({ preventScroll: true });
      return;
    }

    transitionToken += 1;
    var token = transitionToken;
    var complete = function (event) {
      if (event && event.target !== dogButton) return;
      dogButton.removeEventListener("animationend", complete);
      finishTransition(settledState, token);
    };

    dogButton.addEventListener("animationend", complete);
    // Background tabs can throttle CSS animation events. Never stay stuck.
    transitionTimer = window.setTimeout(complete, durationMs + 250);
  }

  function activate() {
    if (state === STATES.HOME) {
      beginTransition(STATES.HOPPING_RIGHT, STATES.RIGHT, 1600);
    } else if (state === STATES.RIGHT) {
      beginTransition(STATES.APPROACHING, STATES.NETWORK, 1400);
    } else if (state === STATES.NETWORK) {
      beginTransition(STATES.RETURNING, STATES.HOME, 1700);
    }
    // Any other state means a transition is already in flight: ignored.
  }

  dogButton.addEventListener("click", activate);
  ctaButton.addEventListener("click", activate);

  if (!reducedMotion) {
    var GAZE_RANGE_PX = 2.2;
    scene.addEventListener("pointermove", function (event) {
      if (state !== STATES.HOME && state !== STATES.RIGHT && state !== STATES.NETWORK) return;
      var rect = dogButton.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var dx = Math.max(-1, Math.min(1, (event.clientX - cx) / (rect.width || 1)));
      var dy = Math.max(-1, Math.min(1, (event.clientY - cy) / (rect.height || 1)));
      pupils.style.setProperty("--gaze-x", (dx * GAZE_RANGE_PX).toFixed(1) + "px");
      pupils.style.setProperty("--gaze-y", (dy * GAZE_RANGE_PX).toFixed(1) + "px");
    });
    scene.addEventListener("pointerleave", function () {
      pupils.style.setProperty("--gaze-x", "0px");
      pupils.style.setProperty("--gaze-y", "0px");
    });
  }

  render();
  window.requestAnimationFrame(function () {
    root.classList.add("ready");
  });
})();
