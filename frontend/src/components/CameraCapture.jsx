import { useEffect, useRef, useState } from 'react';
import { viewLabel } from '../constants';
import { Icon, Modal } from './Shared';

const MIN_CAPTURE_EDGE = 320;
const stopStream = (stream) => stream?.getTracks().forEach((track) => track.stop());

function cameraError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Camera permission was denied. Allow camera access for this site in the browser settings, then reopen the camera.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
    return 'No camera was found on this device. Use "Add photos" to pick files instead.';
  }
  if (error?.name === 'NotReadableError') return 'The camera is in use by another application. Close it and try again.';
  return `Could not start the camera: ${error?.message || error}`;
}

// Live camera capture for one capture view. Each "Capture" hands a JPEG File to onCapture.
export default function CameraCapture({ view, onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [shots, setShots] = useState([]);
  const supported = Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    if (!supported) {
      setError(`Camera access needs a secure context (https:// or http://localhost); this page is served from ${window.location.origin}. Use "Add photos" instead — on phones it opens the camera app.`);
      return undefined;
    }
    let cancelled = false;
    setReady(false);
    setError('');
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
    navigator.mediaDevices.getUserMedia({ video, audio: false })
      .then(async (stream) => {
        if (cancelled) { stopStream(stream); return; }
        stopStream(streamRef.current);
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
        // Device labels are only exposed after permission is granted.
        const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (!cancelled) setDevices(all.filter((device) => device.kind === 'videoinput'));
      })
      .catch((err) => { if (!cancelled) setError(cameraError(err)); });
    return () => { cancelled = true; };
  }, [deviceId, supported]);

  // Stop every track and free thumbnails when the modal closes.
  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopStream(streamRef.current);
      streamRef.current = null;
      shotsRef.current.forEach((shot) => URL.revokeObjectURL(shot.url));
    };
  }, []);

  const activeId = deviceId || streamRef.current?.getVideoTracks()[0]?.getSettings?.().deviceId || '';

  const capture = () => {
    const videoEl = videoRef.current;
    if (!videoEl || !videoEl.videoWidth) return;
    // Some cameras deliver tiny placeholder frames while starting up; never queue those as evidence.
    if (Math.max(videoEl.videoWidth, videoEl.videoHeight) < MIN_CAPTURE_EDGE) {
      setError('The camera is still starting — wait a moment and capture again.');
      return;
    }
    setError('');
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setError('Canvas is not available in this browser.'); return; }
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!mountedRef.current) return;
      if (!blob) { setError('Could not encode the captured frame.'); return; }
      const file = new File([blob], `${view}-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setShots((current) => [...current, { id: `${Date.now()}-${Math.random()}`, url: URL.createObjectURL(blob), name: file.name }]);
      onCapture(file);
    }, 'image/jpeg', 0.92);
  };

  return (
    <Modal
      title={`Camera · ${viewLabel(view)}`}
      subtitle="Each capture is added to this view's upload queue"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn btn--primary" onClick={capture} disabled={!ready || Boolean(error)}>
            <Icon name="camera" size={15} /> Capture
          </button>
          <button type="button" className="btn btn--secondary" onClick={onClose}>Done{shots.length ? ` (${shots.length})` : ''}</button>
        </>
      )}
    >
      {error ? (
        <div className="alert alert--warning" role="alert"><Icon name="alert" /><span className="alert__text">{error}</span></div>
      ) : (
        <div className="camera">
          <video ref={videoRef} className="camera__video" playsInline muted autoPlay />
          {!ready && <span className="camera__status"><span className="spinner spinner--dark" aria-hidden="true" /> Starting camera…</span>}
        </div>
      )}
      {devices.length > 1 && (
        <div className="field">
          <label htmlFor="camera-device" className="field__label">Camera</label>
          <select id="camera-device" className="input select" value={activeId} onChange={(event) => setDeviceId(event.target.value)}>
            {devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>
            ))}
          </select>
        </div>
      )}
      {shots.length > 0 && (
        <div className="camera__strip" aria-label="Captured photos">
          {shots.map((shot) => <img key={shot.id} src={shot.url} alt={`Captured ${shot.name}`} />)}
        </div>
      )}
    </Modal>
  );
}
