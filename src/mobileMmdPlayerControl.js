import { MmdPlayerControl } from "babylon-mmd/esm/Runtime/Util/mmdPlayerControl";

/**
 * Display time format
 *
 * This enum is used for `MmdPlayerControl.displayTimeFormat`
 */
export var DisplayTimeFormat;
(function (DisplayTimeFormat) {
    DisplayTimeFormat[DisplayTimeFormat["Seconds"] = 0] = "Seconds";
    DisplayTimeFormat[DisplayTimeFormat["Frames"] = 1] = "Frames";
})(DisplayTimeFormat || (DisplayTimeFormat = {}));

export class mobileMmdPlayerControl extends MmdPlayerControl {
    _isMobile;
    _speedlabel;
    _sceneRef;
    _mmdRuntimeRef;
    _captureObserver;
    _captureActive;
    _captureFrames;
    _captureCanvas;
    _captureCtx;
    _pendingBlobPromises;
    _zipWorkerUrl;
    _zipWorker;
    _captureFrameIndex;
    _lastCapturedRuntimeFrame;
    _progressOverlay;
    _lastFrameChangeTime;
    _batchFrameLimit;
    _batchIndex;
    _stepping;
    _batchFrameCount;

    constructor(scene, mmdRuntime, audioPlayer, isMobile = false)  {
        super(scene, mmdRuntime, audioPlayer);
        this._speedlabel = null;
        this._isMobile = isMobile;
        this._sceneRef = scene;
        this._mmdRuntimeRef = mmdRuntime;
        this._captureObserver = null;
        this._captureActive = false;
        this._captureCanvas = null;
        this._captureCtx = null;
        this._pendingBlobPromises = [];
        this._zipWorkerUrl = null;
        this._zipWorker = null;
        this._captureFrameIndex = 0;
        this._lastCapturedRuntimeFrame = -1;
        this._progressOverlay = null;
        this._lastFrameChangeTime = 0;
        // capture continuously without mid-run batching to avoid pauses/resets
        this._batchFrameLimit = Number.POSITIVE_INFINITY;
        this._batchIndex = 0;
        this._stepping = false;
        this._batchFrameCount = 0;
        this._mobileRemoval();
    }

    _startFrameCapture() {
        if (this._captureActive) return;
        const scene = this._sceneRef;
        const engine = scene?.getEngine();
        const sourceCanvas = engine?.getRenderingCanvas();
        if (!scene || !sourceCanvas) return;

        this._ensureZipWorker();
        this._batchIndex = 0;
        this._captureFrameIndex = 0;
        this._lastCapturedRuntimeFrame = -1;
        this._batchFrameCount = 0;

        this._captureCanvas = document.createElement("canvas");
        this._captureCanvas.width = 1080;
        this._captureCanvas.height = 1920;
        this._captureCtx = this._captureCanvas.getContext("2d", { willReadFrequently: true });
        this._captureActive = true;
        this._showProgressOverlay();

        this._stepping = true;
        void this._stepFrameCapture(scene, sourceCanvas);
    }

    async _stepFrameCapture(scene, sourceCanvas) {
        if (!this._captureActive || !this._stepping) return;
        const runtime = this._mmdRuntimeRef;
        if (!runtime) return;

        const frameIndex = this._captureFrameIndex;
        runtime.seekAnimation(frameIndex, true);
        scene.render();

        const targetW = 1080;
        const targetH = 1920;
        const targetAspect = targetW / targetH;
        const srcW = sourceCanvas.width;
        const srcH = sourceCanvas.height;
        const srcAspect = srcW / srcH;
        let sx = 0;
        let sy = 0;
        let sw = srcW;
        let sh = srcH;
        if (srcAspect > targetAspect) {
            sw = srcH * targetAspect;
            sx = (srcW - sw) * 0.5;
        } else {
            sh = srcW / targetAspect;
            sy = (srcH - sh) * 0.5;
        }

        this._captureCtx.clearRect(0, 0, targetW, targetH);
        this._captureCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, targetW, targetH);

        const frameNumber = this._captureFrameIndex++;
        await new Promise((resolve) => {
            this._captureCanvas.toBlob(async (blob) => {
                if (blob && this._zipWorker) {
                    const buffer = await blob.arrayBuffer();
                    this._zipWorker.postMessage({ type: "frame", name: `frame_${String(frameNumber).padStart(5, "0")}.jpg`, buffer }, [buffer]);
                }
                this._updateProgressOverlay(frameNumber + 1);
                resolve();
            }, "image/jpeg", 0.9);
        });
        this._batchFrameCount += 1;

        if (runtime.animationFrameTimeDuration && frameNumber >= Math.floor(runtime.animationFrameTimeDuration)) {
            this._finishFrameCapture();
            return;
        }

        // batching disabled; all frames captured in a single pass to keep physics continuous

        // step next frame asynchronously to keep UI responsive
        setTimeout(() => void this._stepFrameCapture(scene, sourceCanvas), 0);
    }

    async _finishFrameCapture() {
        if (!this._captureActive) return;
        this._captureActive = false;
        if (this._sceneRef && this._captureObserver) {
            this._sceneRef.onAfterRenderObservable.remove(this._captureObserver);
            this._captureObserver = null;
        }
        const finalizeWorker = this._zipWorker;
        const finalizeUrl = this._zipWorkerUrl;
        this._zipWorker = null;
        this._zipWorkerUrl = null;
        const count = this._batchFrameCount;
        this._batchFrameCount = 0;
        await this._finalizeCurrentBatch(true, finalizeWorker, finalizeUrl, count);
        this._updateProgressOverlay(null, true);
    }

    _ensureZipWorker() {
        if (this._zipWorker) return;
        const workerScript = `
            importScripts('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
            let zip = new JSZip();
            self.onmessage = async (e) => {
                const data = e.data;
                if (!data || !data.type) return;
                if (data.type === 'frame') {
                    try {
                        const blob = new Blob([data.buffer], { type: 'image/jpeg' });
                        zip.file(data.name, blob);
                    } catch (err) {
                        self.postMessage({ ok: false, error: err?.message || String(err) });
                    }
                } else if (data.type === 'finalize') {
                    try {
                        const result = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true });
                        self.postMessage({ ok: true, blob: result });
                    } catch (err) {
                        self.postMessage({ ok: false, error: err?.message || String(err) });
                    }
                    zip = null;
                }
            };
        `;

        const workerUrl = URL.createObjectURL(new Blob([workerScript], { type: "application/javascript" }));
        const worker = new Worker(workerUrl);

        worker.onmessage = (event) => {
            const data = event.data;
            if (data?.ok && data.blob) {
                const url = URL.createObjectURL(data.blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = `capture_${Date.now()}_batch${this._batchIndex - 1}.zip`;
                anchor.style.display = "none";
                document.body.appendChild(anchor);
                anchor.click();
                document.body.removeChild(anchor);
                setTimeout(() => URL.revokeObjectURL(url), 20000);
            } else if (data && !data.ok) {
                console.error("Failed to generate zip:", data.error);
            }
            this._cleanupSpecificWorker(worker, workerUrl);
        };

        worker.onerror = (err) => {
            console.error("Zip worker error:", err);
            this._cleanupSpecificWorker(worker, workerUrl);
        };

        this._zipWorkerUrl = workerUrl;
        this._zipWorker = worker;
    }

    _cleanupWorker() {
        if (this._zipWorker) {
            this._zipWorker.terminate();
            this._zipWorker = null;
            if (this._zipWorkerUrl) {
                URL.revokeObjectURL(this._zipWorkerUrl);
                this._zipWorkerUrl = null;
            }
        }
        this._hideProgressOverlay();
    }

    _cleanupSpecificWorker(worker, url) {
        if (worker) {
            worker.terminate();
        }
        if (url) {
            URL.revokeObjectURL(url);
        }
        if (worker === this._zipWorker) {
            this._zipWorker = null;
        }
        if (url === this._zipWorkerUrl) {
            this._zipWorkerUrl = null;
        }
    }

    async _finalizeCurrentBatch(isFinal, workerOverride, urlOverride, frameCount) {
        await Promise.all(this._pendingBlobPromises);
        this._pendingBlobPromises = [];
        const worker = workerOverride || this._zipWorker;
        const workerUrl = urlOverride || this._zipWorkerUrl;

        if (!worker || frameCount === 0) {
            if (isFinal) this._hideProgressOverlay();
            return;
        }

        if (!isFinal && frameCount < this._batchFrameLimit) {
            // not enough frames for this batch; restore count and skip finalize
            this._batchFrameCount = frameCount;
            return;
        }

        if (!isFinal) {
            this._batchIndex += 1;
        }
        console.log(`Finalizing batch ${this._batchIndex}${isFinal ? " (final)" : ""} with ${frameCount} frames`);
        const finalizePromise = new Promise((resolve) => {
            const handleMessage = (event) => {
                const data = event.data;
                if (data?.ok || (data && !data.ok)) {
                    worker.removeEventListener("message", handleMessage);
                    worker.removeEventListener("error", handleError);
                    resolve();
                }
            };
            const handleError = () => {
                worker.removeEventListener("message", handleMessage);
                worker.removeEventListener("error", handleError);
                resolve();
            };
            worker.addEventListener("message", handleMessage);
            worker.addEventListener("error", handleError);
        });

        worker.postMessage({ type: "finalize", batchIndex: this._batchIndex });
        await finalizePromise;

        if (isFinal) {
            this._cleanupSpecificWorker(worker, workerUrl);
        }
    }

    _showProgressOverlay() {
        if (this._progressOverlay) {
            this._progressOverlay.innerText = "0";
            this._progressOverlay.style.display = "block";
            return;
        }
        const el = document.createElement("div");
        el.style.position = "fixed";
        el.style.bottom = "12px";
        el.style.right = "12px";
        el.style.padding = "6px 10px";
        el.style.background = "rgba(0,0,0,0.5)";
        el.style.color = "white";
        el.style.fontSize = "12px";
        el.style.borderRadius = "6px";
        el.style.pointerEvents = "none";
        el.style.zIndex = "2147483647";
        el.innerText = "0";
        document.body.appendChild(el);
        this._progressOverlay = el;
    }

    _updateProgressOverlay(count, done = false) {
        if (!this._progressOverlay) return;
        if (done) {
            this._progressOverlay.innerText = "done";
            return;
        }
        this._progressOverlay.innerText = `${count}`;
    }

    _hideProgressOverlay() {
        if (this._progressOverlay) {
            this._progressOverlay.style.display = "none";
        }
    }

    _mobileRemoval() {
        if (this._isMobile) {
            const playerLowerRightContainer = document.getElementById('plrc');
            const sLa = document.getElementById('sLa');
            const sLi = document.getElementById('sLi');
            playerLowerRightContainer.removeChild(sLa);
            playerLowerRightContainer.removeChild(sLi);
        }
    }

    _createPlayerControl(parentControl, mmdRuntime, audioPlayer) {
        const ownerDocument = parentControl.ownerDocument;
        const playerContainer = this._playerContainer = ownerDocument.createElement("div");
        playerContainer.style.position = "relative";
        playerContainer.style.bottom = "120px";
        playerContainer.style.left = "0";
        playerContainer.style.width = "100%";
        playerContainer.style.height = "120px";
        playerContainer.style.transform = "translateY(50%)";
        playerContainer.style.transition = "transform 0.5s";
        parentControl.appendChild(playerContainer);
        playerContainer.onmouseenter = this._onPlayerControlMouseEnter;
        playerContainer.onmouseleave = this._onPlayerControlMouseLeave;
        {
            const playerInnerContainer = ownerDocument.createElement("div");
            playerInnerContainer.style.position = "absolute";
            playerInnerContainer.style.bottom = "0";
            playerInnerContainer.style.left = "0";
            playerInnerContainer.style.width = "100%";
            playerInnerContainer.style.height = "50%";
            playerInnerContainer.style.boxSizing = "border-box";
            playerInnerContainer.style.background = "linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.6))";
            playerInnerContainer.style.display = "flex";
            playerInnerContainer.style.flexDirection = "column";
            playerContainer.appendChild(playerInnerContainer);
            {
                const playerUpperContainer = ownerDocument.createElement("div");
                playerUpperContainer.style.width = "100%";
                playerUpperContainer.style.boxSizing = "border-box";
                playerUpperContainer.style.display = "flex";
                playerUpperContainer.style.flexDirection = "row";
                playerUpperContainer.style.alignItems = "center";
                playerInnerContainer.appendChild(playerUpperContainer);
                {
                    const timeSlider = this._timeSlider = ownerDocument.createElement("input");
                    timeSlider.style.width = "100%";
                    timeSlider.style.height = "4px";
                    timeSlider.style.border = "none";
                    timeSlider.style.opacity = "0.5";
                    timeSlider.type = "range";
                    timeSlider.min = "0";
                    timeSlider.max = mmdRuntime.animationFrameTimeDuration.toString();
                    timeSlider.oninput = (e) => {
                        e.preventDefault();
                        mmdRuntime.seekAnimation(Number(timeSlider.value), true);
                    };
                    {
                        let isPlaySeeking = false;
                        timeSlider.onmousedown = () => {
                            if (mmdRuntime.isAnimationPlaying) {
                                mmdRuntime.pauseAnimation();
                                isPlaySeeking = true;
                            }
                        };
                        timeSlider.onmouseup = () => {
                            if (isPlaySeeking) {
                                mmdRuntime.playAnimation();
                                isPlaySeeking = false;
                            }
                        };
                    }
                    playerUpperContainer.appendChild(timeSlider);
                }
                const playerLowerContainer = ownerDocument.createElement("div");
                playerLowerContainer.style.width = "100%";
                playerLowerContainer.style.flexGrow = "1";
                playerLowerContainer.style.padding = "0 5px";
                playerLowerContainer.style.boxSizing = "border-box";
                playerLowerContainer.style.display = "flex";
                playerLowerContainer.style.flexDirection = "row";
                playerLowerContainer.style.alignItems = "space-between";
                playerInnerContainer.appendChild(playerLowerContainer);
                {
                    const playerLowerLeftContainer = ownerDocument.createElement("div");
                    playerLowerLeftContainer.style.flex = "1";
                    playerLowerLeftContainer.style.display = "flex";
                    playerLowerLeftContainer.style.flexDirection = "row";
                    playerLowerLeftContainer.style.alignItems = "center";
                    playerLowerContainer.appendChild(playerLowerLeftContainer);
                    {
                        const playButton = this._playButton = ownerDocument.createElement("button");
                        playButton.style.width = "40px";
                        playButton.style.border = "none";
                        playButton.style.backgroundColor = "rgba(0, 0, 0, 0)";
                        playButton.style.color = "white";
                        playButton.style.fontSize = "18px";
                        playButton.innerText = mmdRuntime.isAnimationPlaying ? "❚❚" : "▶";
                        playButton.onclick = () => {
                            if (mmdRuntime.isAnimationPlaying) {
                                mmdRuntime.pauseAnimation();
                            }
                            else {
                                if (!this._captureActive) {
                                    this._startFrameCapture();
                                }
                                mmdRuntime.playAnimation();
                            }
                        };
                        playerLowerLeftContainer.appendChild(playButton);
                        if (audioPlayer !== undefined) {
                            const soundButton = this._soundButton = ownerDocument.createElement("button");
                            soundButton.style.width = "35px";
                            soundButton.style.border = "none";
                            soundButton.style.backgroundColor = "rgba(0, 0, 0, 0)";
                            soundButton.style.color = "white";
                            soundButton.style.fontSize = "20px";
                            soundButton.innerText = audioPlayer.muted ? "🔇" : "🔊";
                            soundButton.onclick = () => {
                                if (audioPlayer.muted) {
                                    audioPlayer.unmute();
                                }
                                else {
                                    audioPlayer.mute();
                                }
                            };
                            playerLowerLeftContainer.appendChild(soundButton);
                            const volumeSlider = this._volumeSlider = ownerDocument.createElement("input");
                            volumeSlider.style.width = "80px";
                            volumeSlider.style.height = "4px";
                            volumeSlider.style.border = "none";
                            volumeSlider.style.opacity = "0.5";
                            volumeSlider.type = "range";
                            volumeSlider.min = "0";
                            volumeSlider.max = "1";
                            volumeSlider.step = "0.01";
                            volumeSlider.value = audioPlayer.volume.toString();
                            volumeSlider.oninput = () => {
                                audioPlayer.volume = Number(volumeSlider.value);
                            };
                            playerLowerLeftContainer.appendChild(volumeSlider);
                        }
                        const curentFrameNumber = this._currentFrameNumberSpan = ownerDocument.createElement("span");
                        curentFrameNumber.style.width = "40px";
                        curentFrameNumber.style.textAlign = "right";
                        curentFrameNumber.style.color = "white";
                        curentFrameNumber.innerText = this.displayTimeFormat === DisplayTimeFormat.Seconds
                            ? this._getFormattedTime(mmdRuntime.currentTime)
                            : Math.floor(mmdRuntime.currentFrameTime).toString();
                        playerLowerLeftContainer.appendChild(curentFrameNumber);
                        const endFrameNumber = this._endFrameNumberSpan = ownerDocument.createElement("span");
                        endFrameNumber.style.width = "50px";
                        endFrameNumber.style.textAlign = "left";
                        endFrameNumber.style.color = "white";
                        endFrameNumber.innerHTML = "&nbsp;/&nbsp;" +
                            (this.displayTimeFormat === DisplayTimeFormat.Seconds
                                ? this._getFormattedTime(mmdRuntime.animationDuration)
                                : Math.floor(mmdRuntime.animationFrameTimeDuration).toString());
                        playerLowerLeftContainer.appendChild(endFrameNumber);
                    }
                    const playerLowerRightContainer = ownerDocument.createElement("div");
                    playerLowerRightContainer.style.flex = "1";
                    playerLowerRightContainer.style.display = "flex";
                    playerLowerRightContainer.style.flexDirection = "row";
                    playerLowerRightContainer.style.alignItems = "center";
                    playerLowerRightContainer.style.justifyContent = "flex-end";
                    playerLowerRightContainer.id = "plrc";
                    playerLowerContainer.appendChild(playerLowerRightContainer);
                    {
                        const speedLabel = this._speedlabel = ownerDocument.createElement("label");
                        speedLabel.style.width = "40px";
                        speedLabel.style.textAlign = "center";
                        speedLabel.style.color = "white";
                        speedLabel.innerText = "1.00x";
                        speedLabel.id = "sLa";
                        playerLowerRightContainer.appendChild(speedLabel);
                        const speedSlider = this._speedSlider = ownerDocument.createElement("input");
                        speedSlider.style.width = "80px";
                        speedSlider.style.height = "4px";
                        speedSlider.style.border = "none";
                        speedSlider.style.opacity = "0.5";
                        speedSlider.type = "range";
                        speedSlider.min = "0.07";
                        speedSlider.max = "1";
                        speedSlider.step = "0.01";
                        speedSlider.id = "sLi";
                        speedSlider.value = mmdRuntime.timeScale.toString();
                        speedSlider.oninput = () => {
                            mmdRuntime.timeScale = Number(speedSlider.value);
                            speedLabel.innerText = mmdRuntime.timeScale.toFixed(2) + "x";
                        };
                        playerLowerRightContainer.appendChild(speedSlider);
                        const fullscreenButton = this._fullscreenButton = ownerDocument.createElement("button");
                        fullscreenButton.style.width = "40px";
                        fullscreenButton.style.border = "none";
                        fullscreenButton.style.color = "white";
                        fullscreenButton.style.backgroundColor = "rgba(0, 0, 0, 0)";
                        fullscreenButton.style.fontSize = "20px";
                        fullscreenButton.innerHTML = '<img src="res/assets/maximise.png" alt="Fullscreen" style="width: 100%; height: 100%;">';
                        // fullscreenButton.innerText = "🗖";
                        fullscreenButton.onclick = () => {
                            if (ownerDocument.fullscreenElement)
                                ownerDocument.exitFullscreen();
                            else
                                parentControl.requestFullscreen();
                        };
                        playerLowerRightContainer.appendChild(fullscreenButton);
                    }
                }
            }
        }
    }
}