// Reads QR codes with the camera. Uses the browser's BarcodeDetector where it
// can read QR codes (Chrome on Android), and otherwise jsQR, which is only
// loaded the first time it's needed (Safari on iPhone).

let jsQRPromise = null;

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsQRPromise) {
    jsQRPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/jsQR.js';
      script.onload = () => resolve(window.jsQR);
      script.onerror = () => {
        jsQRPromise = null;
        reject(new Error('Couldn’t load the QR code reader.'));
      };
      document.head.appendChild(script);
    });
  }
  return jsQRPromise;
}

async function qrDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code') ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  } catch (err) {
    return null;
  }
}

function cameraError(err) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return new Error('The camera isn’t available in this browser. Paste the link instead.');
  }
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return new Error('RV Notes isn’t allowed to use the camera. Allow camera access in your settings, or paste the link instead.');
  }
  if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
    return new Error('No camera was found. Paste the link instead.');
  }
  return new Error('Couldn’t start the camera. Paste the link instead.');
}

/**
 * Shows the back camera in video and calls onCode(text) for each QR code it
 * reads until onCode returns true or stop() is called.
 *
 * @param {HTMLVideoElement} video
 * @param {function(string): boolean} onCode
 * @returns {Promise<function(): void>} stop
 */
export async function startScanner(video, onCode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw cameraError();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (err) {
    throw cameraError(err);
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
    stream.getTracks().forEach(track => track.stop());
    video.srcObject = null;
  };

  try {
    // Safari needs these to play the camera inline without going full screen.
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const detector = await qrDetector();
    const jsQR = detector ? null : await loadJsQR();
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const read = async () => {
      if (detector) {
        const codes = await detector.detect(video);
        return codes.length ? codes[0].rawValue : '';
      }
      // Smaller frames read faster and are plenty for a code held up close.
      const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      return code ? code.data : '';
    };

    const tick = async () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          const text = await read();
          if (text && !stopped && onCode(text) === true) {
            stop();
            return;
          }
        } catch (err) {
          // Try the next frame.
        }
      }
      setTimeout(tick, 150);
    };
    tick();
  } catch (err) {
    stop();
    throw err.message ? err : cameraError(err);
  }
  return stop;
}
