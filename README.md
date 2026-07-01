# PuzzleCam — Gesture Capture
**© 2026 Eng. Abdallah Qaraqe — all rights reserved**

A hand-gesture controlled photobooth puzzle game that runs entirely in your browser. No installation, no backend, no frameworks. Just your hands and a webcam.

---

## what is this?

You use your hands as a camera frame, pinch to take a photo, solve a puzzle with your fingers, and watch it shatter into a polaroid strip. The whole thing runs in one browser tab with zero setup.

Built with vanilla JavaScript, MediaPipe hand tracking, and the Web Audio API. No React. No npm. Nothing to install.

---

## how to run it

**1. clone the repo**
```bash
git clone https://github.com/abdallahqaraqe1/puzzlecam.git
cd puzzlecam
```

**2. open in VS Code and click Go Live**

Install the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension by Ritwick Dey if you don't have it. Then click **Go Live** in the bottom right corner.

**3. open in Chrome or Edge**
```
http://localhost:5500
```
Allow camera access when the browser asks.

> needs internet on first load to download the MediaPipe hand model (~10MB). after that it works offline.

---

## how to play

| gesture | what it does |
|---|---|
| raise both hands | camera starts tracking your hands |
| pinch both hands together | defines the photo frame and starts 3 second countdown |
| one hand pinch on a piece | drag that puzzle piece |
| drop piece near correct spot | it snaps in automatically |
| closed fist (hold) | resets board |

**the full flow:**
1. hold both hands up — the space between your index fingers becomes your camera frame
2. pinch both hands → 3 second countdown → flash → photo captured in B&W
3. solve the 3x3 puzzle by dragging pieces with a pinch gesture
4. puzzle saves automatically 1 second after completion → pieces shatter → saved as a color polaroid with your date and photo number
5. complete 3 puzzles → your full photo strip pops up and is automatically downloaded

---

## what makes it different

- puzzles are **B&W while solving**, then reveal as **full color** when saved
- **camera flash** at the moment of capture
- **polaroid borders** with date and number stamped on each photo
- **sound design** — countdown beeps, piece snap, shatter burst, completion chime
- **video recording** of each solve, downloadable as WebM
- **photo strip popup** inside the game when all 3 are done
- zero frameworks, zero dependencies, everything runs in the browser

---

## tech used

- MediaPipe Tasks Vision `v0.10.14` — hand landmark detection
- Canvas 2D API — rendering, effects, puzzle, shatter physics
- Web Audio API — all sounds generated in code, no audio files
- MediaRecorder API — video capture
- Vanilla JavaScript (ES Modules) — no frameworks, no build step

---

## browser support

| browser | support |
|---|---|
| Chrome / Edge | recommended |
| Firefox | works |
| Safari | limited |
| mobile | not recommended |

---

## tag me!

if you try this i would genuinely love to see your photobooth strip. check out my profile **@abdallahqaraqe1** — have fun with it!

---

## license

MIT — free to use, modify, and share.
